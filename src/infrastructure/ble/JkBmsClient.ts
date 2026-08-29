/**
 * Web Bluetooth GATT transport for the JK-BMS.
 *
 * `connect` must be called synchronously from a user gesture, and everything it does before
 * requestDevice must stay synchronous — one await ahead of the chooser and the browser refuses it
 * for lack of transient activation.
 *
 * The chooser matches on ADVERTISED service UUIDs, not on services discovered after
 * connecting. Some units advertise 0xFFE0; others advertise only their serial number as
 * the device name. Both filters are offered, and `showAllDevices` is the escape hatch when
 * a unit advertises neither.
 *
 * `reconnect` asks the radio straight out first, and waits to hear the pack only when that fails.
 * Chromium drops any device that is neither paired nor connected from its adapter map after three
 * minutes without an advertisement, and nothing in the connect path starts a scan on the page's
 * behalf — so a remembered handle taken straight to `gatt.connect()` is guaranteed to fail once the
 * pack has been quiet that long, and only a sighting puts it back. But the straight attach is the
 * only half that works with the window in the background: Chromium tears down every advertisement
 * watch when the tab is hidden or the window loses focus, silently and on every platform, while a
 * connect needs no focus at all. So the cheap question is asked first — a pack the map has
 * forgotten answers it in milliseconds and costs no radio time — and the sighting is what answers
 * it when the map has forgotten the pack.
 *
 * Whether the second half runs at all is the caller's to say, through `ReconnectPatience`. A page
 * behind another window has no watch to give, so it asks for the straight attach alone and is
 * answered inside its deadline either way.
 */

import {
  CMD_CELL_INFO,
  CMD_DETAIL_LOG,
  CMD_DEVICE_INFO,
  CMD_LOGBOOK,
  FRAME_CELL_INFO,
  FRAME_DETAIL_LOG,
  FRAME_DEVICE_INFO,
  FRAME_LOGBOOK,
  FRAME_SETTINGS,
  FrameAssembler,
  JK_CHARACTERISTIC,
  JK_SERVICE,
  buildCommand,
  frameType,
} from '../../domain/bms/protocol'
import { decodeCellInfo, decodeDeviceInfo, decodeSettings } from '../../domain/bms/decode'
import { decodeLogbook } from '../../domain/bms/logbook'
import type { LogbookEvent } from '../../domain/bms/logbook'
import type { DetailLogTransfer } from '../../domain/bms/DetailLogTransfer'
import { toArrayBuffer } from '../../domain/bytes'
import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../../domain/bms/types'
import { DetailLogRun } from './DetailLogRun'
import type { ReconnectPatience } from './ReconnectPatience'
import { ReconnectRefusedError } from './ReconnectRefusedError'

const STALL_TIMEOUT_MS = 8_000
const STALL_CHECK_MS = 2_000
/**
 * How long a blind reconnect waits before giving up — the whole of the attempt wherever there is no
 * sighting behind it to fall back on: a browser with no `watchAdvertisements`, and a caller that has
 * no window to hold a watch in. A permitted device that is not advertising leaves `gatt.connect()`
 * pending with nothing to answer it, so without this bound an auto-reconnect to a pack that is
 * simply out of range would sit on 'connecting' forever. Six seconds is a presence probe as much as
 * a deadline, which is exactly what a sighting replaces — and it is longer than the probe below
 * because a handshake cut short here has nothing coming along behind it to pick the pack up again.
 */
const BLIND_RECONNECT_TIMEOUT_MS = 6_000
/**
 * How long the straight attach ahead of a sighting may run before the sighting is asked for
 * instead.
 *
 * A pack the adapter map has forgotten rejects at once and without the radio being touched, so this
 * deadline is never what tells a purged device from a present one. What it bounds is the case in
 * between: a map entry that outlived the pack's range, where `gatt.connect()` has nothing to answer
 * it and the platform underneath is under no obligation to ever give up. That is the ordinary shape
 * of the three minutes after a drop, and every second spent there is a second the sighting is not
 * being waited for — so this is a probe, not a wait. Two and a half seconds covers a healthy
 * connect and handshake with room over, and the handshake it does cut short is not lost: the pack
 * is in range by definition, so the sighting behind it picks the pack up again within seconds.
 */
const BLIND_PROBE_TIMEOUT_MS = 2_500
/**
 * How long the handshake may take once a sighting has already proved the pack is present.
 *
 * The blind budget above is short because it is guessing at presence. Here that question is
 * answered, so what is left to bound is the handshake itself — a GATT connect, service and
 * characteristic discovery, a subscribe and three commands, over a band shared with every other
 * radio on the boat. Twenty seconds leaves a slow but real handshake room to finish, and still puts
 * a pack that answered its advertisement and then went quiet back in front of a retry inside half a
 * minute. It stays a timer rather than a pure cancellation because `gatt.disconnect()` is confirmed
 * only to reject the outstanding Blink promise; whether the cancel reaches the OS stack underneath
 * is not, so nothing here may depend on it arriving.
 */
const SIGHTED_ATTACH_TIMEOUT_MS = 20_000
/**
 * How long a sighting watch may say nothing before it is torn down and asked for again. Chromium
 * stalls a watch after roughly fifteen seconds while `watchingAdvertisements` still reads true, and
 * kills every watch outright when the tab loses focus without firing anything — so silence is never
 * evidence on its own, and the only way to tell a dead watch from an absent pack is to keep asking
 * for a fresh one.
 */
const SIGHTING_REARM_MS = 10_000
/**
 * A GATT link can stay "connected" while the BMS quietly stops notifying — a firmware
 * hiccup, a dropped subscription, an MTU loss — with no gattserverdisconnected to tell us.
 * The stall poke below is then our only prod. After this many consecutive stalls with no
 * frame in between (roughly STALL_TIMEOUT_MS apart, so about twenty-four seconds of silence)
 * we stop hoping and tear the link down, so the UI leaves 'live' instead of trusting a
 * frozen reading forever.
 */
const MAX_STALL_STRIKES = 3

/**
 * How the link ended. 'dropped' is the radio going away underneath us — out of range, unit
 * powered down, another client taking the single connection the JK allows. 'stalled' is a link
 * the browser still calls connected that stopped notifying and stopped answering the pokes.
 * A recording says which one it was, because they mean different things to whoever reads it.
 */
export type DisconnectReason = 'dropped' | 'stalled'

export interface JkBmsHandlers {
  onSnapshot?: (snapshot: BatterySnapshot) => void
  onDeviceInfo?: (info: DeviceInfo) => void
  onSettings?: (settings: BmsSettings) => void
  onLogbook?: (events: LogbookEvent[]) => void
  onDisconnect?: (reason: DisconnectReason) => void
  onError?: (error: Error) => void
}

/**
 * The pack link as the layers above it see one. Only JkBmsClient touches a radio; the interface
 * is what lets a fake stand in its place, which no object literal can do against the class
 * itself — private fields make it nominal.
 */
export interface BmsLink {
  readonly connected: boolean
  /**
   * The name the pack broadcasts, known from the moment the chooser returns. For a unit whose
   * device-info frame never decodes it is the only identity we ever get.
   */
  readonly deviceName: string | null
  /**
   * The opaque, origin-scoped Web Bluetooth id of the connected device, so the caller can
   * remember it and reconnect later without the chooser. Null before a connection.
   */
  readonly deviceId: string | null
  /**
   * Raise the chooser and attach to whatever the user picks. Must be called straight from the
   * gesture. A press that lands while an attempt is already running joins that attempt rather than
   * opening a second chooser; a press while a link is held rejects, because resolving would tell
   * the caller a fresh connection was made when none was.
   */
  connect(showAllDevices?: boolean): Promise<void>
  /**
   * Reconnect to a previously-permitted device by its id, without the chooser. Needs no user
   * gesture.
   *
   * Straight in, then presence. The remembered handle goes to the radio at once, because a pack
   * that dropped a moment ago is still there to be attached to and that attach needs no focus. Only
   * when it fails does the wait for a sighting take over — for as long as the caller lets it, which
   * is what `signal` is for. `patience` is where a caller says it has no window to hold a watch in,
   * and a browser that cannot watch advertisements at all says the same thing by not offering the
   * method; either way there is no second half, and the straight attach runs under a longer deadline
   * of its own instead. However far it goes, a resolved promise means a link to the pack that was
   * asked for, and nothing less.
   *
   * How long to wait and when to stand down belong to the caller: this class owns the mechanics and
   * has no policy of its own. Aborting the signal rejects with an `AbortError`, so a supervisor can
   * tell its own stand-down apart from a pack that would not answer and keep it out of any backoff.
   *
   * Three failures are worth telling apart, and they are told apart programmatically:
   * `ReconnectRefusedError` carries a `refusal` for the two that no retry can fix — the pack is no
   * longer permitted, or this browser cannot rejoin at all — an `AbortError` is the caller's own
   * stand-down, and anything else is a pack that did not answer, which is worth trying again.
   *
   * Resolves immediately when this pack is the one already connected. Any request naming a pack
   * other than the one held or being attempted rejects: only a resolved promise may mean a link to
   * the pack that was asked for. A request that joins an attempt already in flight inherits that
   * attempt's lifetime, including whichever signal started it, because there is one attempt and it
   * can only be stood down by whoever opened it.
   */
  reconnect(deviceId: string, signal?: AbortSignal, patience?: ReconnectPatience): Promise<void>
  /**
   * Read the pack's own store of sampled snapshots (command 0xA7) as a one-off diagnostic, and
   * report what came back rather than only what decoded.
   *
   * On demand, from the UI, and never from the handshake: the reply can take tens of seconds, where
   * `attachWithin` bounds the whole handshake and turns anything slower into a failed reconnect.
   *
   * `packUtcOffsetMinutes` is signed the way a zone is written, so CET is +60. It resolves the
   * records' `recordedAt` and nothing else — each record carries the pack's raw counter untouched,
   * which is what settles the convention the counter runs on.
   *
   * Rejects only when there is no link to read over. A read that heard nothing resolves, because
   * silence is the finding.
   */
  readDetailLog(packClock: { readonly packUtcOffsetMinutes: number }): Promise<DetailLogTransfer>
  disconnect(): Promise<void>
}

/**
 * A connection attempt in flight, with the pack it is for — null for a chooser connect, which does
 * not know its device until the user has picked one.
 */
interface ConnectionAttempt {
  readonly deviceId: string | null
  readonly outcome: Promise<void>
}

/**
 * The wait for a sighting, as the rest of the class needs to see it: which generation of the loop
 * it is, so a re-arm cannot resurrect a wait that has moved on, and the one call that abandons it.
 */
interface SightingWait {
  readonly generation: number
  readonly abandon: () => void
}

/**
 * The rejection for an attempt nobody wants any more — stood down by its caller, superseded by a
 * newer one, or torn down from underneath. `AbortError` is the name the layer above already reads
 * as deliberate: `describeConnectError` shows no banner for one, and a supervisor must never feed
 * its own stand-down into a backoff meant for a pack that would not answer.
 */
function standDown(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

/** Checked wherever a reconnect is about to start waiting on something, and after every wait. */
function throwIfStoodDown(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw standDown('Reconnect stood down')
}

export class JkBmsClient implements BmsLink {
  private device: BluetoothDevice | null = null
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null
  private readonly assembler = new FrameAssembler()
  private readonly handlers: JkBmsHandlers
  /**
   * Held so a second attempt joins the one already running instead of racing it — Blink does not
   * dedupe gatt.connect(), and two handshakes over one device fight over the single link the JK
   * allows. It is also why a busy client never simply resolves: one layer up a resolved connect is
   * read as a live pack, so an attempt that connected nothing would put frozen numbers on screen
   * under a 'live' badge.
   */
  private attempt: ConnectionAttempt | null = null
  private lastFrameAt = 0
  private stallStrikes = 0
  private stallTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Identifies the current attach attempt. A timeout, disconnect or newer attempt bumps it, and the
   * running `attach` checks it after every await — so a handshake that completes after its deadline
   * unwinds instead of installing a listener and a stall timer on a link nothing is holding.
   */
  private attachToken = 0
  /**
   * The sighting wait in flight, if any. Held on the instance because a teardown has to be able to
   * reach it: a watch and its re-arm timer left running would outlive the link they were opened
   * for, and Chromium keeps a stalled watch alive for as long as anyone holds it.
   */
  private sightingWait: SightingWait | null = null
  private sightingGeneration = 0
  /** The stored-log read in flight, if any. Notifications are tallied into it as they arrive. */
  private detailLogRun: DetailLogRun | null = null
  /** Held so a second press joins the running read instead of starting a rival one. */
  private detailLogRead: Promise<DetailLogTransfer> | null = null

  constructor(handlers: JkBmsHandlers = {}) {
    this.handlers = handlers
  }

  get connected(): boolean {
    return this.device?.gatt?.connected === true
  }

  get deviceName(): string | null {
    return this.device?.name ?? null
  }

  get deviceId(): string | null {
    return this.device?.id ?? null
  }

  connect(showAllDevices = false): Promise<void> {
    // Every branch here is synchronous — returning a held promise included — so requestDevice inside
    // chooseAndAttach is still reached with no await ahead of it and the gesture's transient
    // activation is intact.
    if (this.attempt !== null) {
      // A press that lands on the automatic reconnect wants the same thing it is already doing, so
      // it waits on that outcome instead of opening a second chooser behind it.
      return this.attempt.outcome
    }
    if (this.device !== null) {
      // A second connect would overwrite `device` while the first still carries our
      // gattserverdisconnected listener and nothing is left holding the reference needed to
      // unbind it — the abandoned link would then report its drop over the top of the live one.
      return Promise.reject(new Error('Already connected to a pack. Disconnect it before connecting to another.'))
    }
    return this.hold(null, this.chooseAndAttach(showAllDevices))
  }

  reconnect(
    deviceId: string,
    signal?: AbortSignal,
    patience: ReconnectPatience = 'wait-for-a-sighting',
  ): Promise<void> {
    const running = this.attempt
    if (running !== null) {
      if (running.deviceId === deviceId) return running.outcome
      // A chooser attempt counts as another pack: which one the user picks is not known until it
      // returns, so joining it could report this device as connected when a different one is.
      return Promise.reject(
        new Error('A connection to another pack is already being made. Wait for it to finish, then try again.'),
      )
    }
    if (this.device !== null) {
      if (this.device.id === deviceId) return Promise.resolve()
      return Promise.reject(new Error('Connected to a different pack. Disconnect it before reconnecting to this one.'))
    }
    return this.hold(deviceId, this.findAndAttach(deviceId, signal, patience))
  }

  /**
   * Records an attempt so the guards above can join it, and clears the record once it settles —
   * only if it is still the current one, so a superseded attempt finishing late cannot clear the
   * record of the attempt that replaced it.
   */
  private hold(deviceId: string | null, outcome: Promise<void>): Promise<void> {
    const held: Promise<void> = outcome.finally(() => {
      if (this.attempt?.outcome === held) this.attempt = null
    })
    this.attempt = { deviceId, outcome: held }
    return held
  }

  private async chooseAndAttach(showAllDevices: boolean): Promise<void> {
    const options: RequestDeviceOptions = showAllDevices
      ? { acceptAllDevices: true, optionalServices: [JK_SERVICE] }
      : { filters: [{ services: [JK_SERVICE] }, { namePrefix: 'JK' }], optionalServices: [JK_SERVICE] }

    // The chooser hands back a device the user just picked and is therefore in range, so this
    // path does not need the reconnect timeout: waiting for a device that is present is fine.
    const device = await navigator.bluetooth.requestDevice(options)
    await this.attach(device)
  }

  private async findAndAttach(
    deviceId: string,
    signal: AbortSignal | undefined,
    patience: ReconnectPatience,
  ): Promise<void> {
    throwIfStoodDown(signal)
    const device = await this.permittedDevice(deviceId)
    throwIfStoodDown(signal)

    // Asked of the handle rather than of the browser, because the handle is the thing that would be
    // watched: a build with the API on the prototype and a device that refuses to watch is the case
    // the fallback exists for, and only the handle can be asked about the second half of that.
    const handleCanBeWatched = typeof device.watchAdvertisements === 'function'
    // Neither of these has a sighting behind it, so the straight attach is the whole attempt. A
    // caller with no window to hold a watch in is not merely wasting its time by arming one:
    // Chromium tears every watch down when the tab is hidden or the window loses focus, and on
    // Android each arming spends one of the five registrations the platform allows per thirty
    // seconds, throttled with no error and no event — so a background loop that armed watches it
    // could not use would blackhole the one the owner is waiting on when they come back.
    if (patience === 'straight-in-only' || !handleCanBeWatched) {
      await this.attachWithin(device, BLIND_RECONNECT_TIMEOUT_MS, signal)
      return
    }

    if (await this.attachedStraightAway(device, signal)) return
    throwIfStoodDown(signal)

    await this.waitForSighting(device, signal)
    await this.attachWithin(device, SIGHTED_ATTACH_TIMEOUT_MS, signal)
  }

  /**
   * The straight attach, and whether it got the link.
   *
   * Worth asking because the answer is so often yes and so cheap when it is no: a pack that dropped
   * a moment ago is still in the adapter map, and one the map has forgotten rejects immediately
   * without the radio being asked at all. It is also the only half of a rejoin that works behind
   * another window, which is where the owner spends most of the day.
   *
   * A refusal or a stand-down is passed straight on rather than falling through. Permission gone is
   * raised before this ever runs, so what would reach here is an `AbortError`: the caller letting
   * go, a deliberate teardown, or a newer attempt taking the device over — and waiting for a
   * sighting after any of those would rejoin a pack nobody is asking for any more. Anything else is
   * this probe not finding the pack, which is exactly what the sighting is for.
   *
   * Nothing is torn down here. `attachWithin` unwinds its own attempt before it rejects — the drop
   * handler goes first, so none of it is heard as the pack walking away — and the fallback's
   * handshake drops a handle still marked connected as its first act. A teardown of our own would
   * only race the one already running.
   */
  private async attachedStraightAway(device: BluetoothDevice, signal: AbortSignal | undefined): Promise<boolean> {
    try {
      await this.attachWithin(device, BLIND_PROBE_TIMEOUT_MS, signal)
      return true
    } catch (error) {
      const waitingCannotFixIt = error instanceof ReconnectRefusedError || (error as Error).name === 'AbortError'
      if (waitingCannotFixIt) throw error
      return false
    }
  }

  /**
   * The remembered pack's handle, or a refusal saying which permission answer stopped us.
   *
   * A device missing from `getDevices()` says nothing whatever about range: the list is what this
   * origin is permitted to talk to, and a pack that has simply not advertised for three minutes is
   * still on it. So an absence here is permission gone, needs a chooser tap, and must never be
   * reported as an out-of-range pack that patience would fix.
   */
  private async permittedDevice(deviceId: string): Promise<BluetoothDevice> {
    const bluetooth = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined
    if (!bluetooth || typeof bluetooth.getDevices !== 'function') {
      throw new ReconnectRefusedError(
        'browser-cannot-rejoin',
        'This browser cannot reconnect without the chooser. Use Connect BMS.',
      )
    }
    let permitted: readonly BluetoothDevice[]
    try {
      permitted = await bluetooth.getDevices()
    } catch {
      throw new ReconnectRefusedError(
        'browser-cannot-rejoin',
        'This browser would not list its permitted devices. Use Connect BMS.',
      )
    }
    const device = permitted.find((candidate) => candidate.id === deviceId)
    if (!device) {
      throw new ReconnectRefusedError(
        'permission-gone',
        'This browser no longer has permission for the last pack. Use Connect BMS to pick it again.',
      )
    }
    return device
  }

  /**
   * Waits until the pack is heard from, then stops watching.
   *
   * The watch is the go-signal and nothing else — the first advertisement of any kind ends the
   * wait, because the only question being asked is whether the pack is there. Every wait is a fresh
   * generation, so a re-arm belonging to a wait that has been abandoned finds itself stale and does
   * nothing; and the watch that is dropped is aborted only after its replacement is installed, so a
   * rejection arriving out of that abort is unambiguously ours rather than the browser's.
   *
   * Nothing here bounds the wait. A pack out of range is not a failure, it is a pack that has not
   * arrived yet, and how long that is worth waiting for is the caller's business through `signal`.
   */
  private waitForSighting(device: BluetoothDevice, signal: AbortSignal | undefined): Promise<void> {
    const generation = (this.sightingGeneration += 1)
    return new Promise<void>((resolve, reject) => {
      let watch: AbortController | null = null
      let rearmTimer: ReturnType<typeof setInterval> | null = null
      let settled = false

      const settle = (failure: Error | null): void => {
        if (settled) return
        settled = true
        device.removeEventListener('advertisementreceived', noteSighting)
        signal?.removeEventListener('abort', abandon)
        if (rearmTimer !== null) clearInterval(rearmTimer)
        watch?.abort()
        watch = null
        if (this.sightingWait?.generation === generation) this.sightingWait = null
        if (failure === null) resolve()
        else reject(failure)
      }

      const noteSighting = (): void => settle(null)
      const abandon = (): void => settle(standDown('Waiting for the pack was stood down'))

      const arm = (): void => {
        if (settled || this.sightingWait?.generation !== generation) return
        const armed = new AbortController()
        const stalled = watch
        watch = armed
        stalled?.abort()
        device.watchAdvertisements({ signal: armed.signal }).catch((error: unknown) => {
          // Ours to ignore when this watch has already been replaced or aborted; a refusal of the
          // watch we are actually holding is the radio saying no, and there is nothing to wait for.
          if (settled || armed !== watch || armed.signal.aborted) return
          settle(error as Error)
        })
      }

      this.sightingWait = { generation, abandon }
      device.addEventListener('advertisementreceived', noteSighting)
      signal?.addEventListener('abort', abandon)
      arm()
      rearmTimer = setInterval(arm, SIGHTING_REARM_MS)
    })
  }

  /**
   * The post-chooser handshake, shared by `connect` and `reconnect`: open the GATT link, find the
   * characteristic, subscribe, then ask for the two frames. On any failure it unwinds through
   * `disconnect` so a half-open link never survives while the app believes it is idle.
   */
  private async attach(device: BluetoothDevice, token: number = (this.attachToken += 1)): Promise<void> {
    // A pack that power-cycled while we held its handle leaves the browser still calling it
    // connected, and `connect()` on such a handle resolves at once over a link that carries
    // nothing. Dropping it first costs one round trip and is the difference between a handshake and
    // a dead link the app would report as live. Done before the drop listener goes on, so this
    // teardown is not heard as the pack going away.
    if (device.gatt?.connected === true) device.gatt.disconnect()

    this.device = device
    device.addEventListener('gattserverdisconnected', this.handleDisconnect)

    // Thrown after any await once this attempt has been superseded — by its own timeout, a
    // disconnect, or a newer attempt — so a slow handshake that finally resolves unwinds instead of
    // wiring itself onto a link the app has already let go of.
    const abortIfSuperseded = (): void => {
      if (token !== this.attachToken) throw standDown('Reconnect superseded')
    }

    try {
      const server = await device.gatt!.connect()
      abortIfSuperseded()
      const service = await server.getPrimaryService(JK_SERVICE)
      abortIfSuperseded()
      const characteristic = await service.getCharacteristic(JK_CHARACTERISTIC)
      abortIfSuperseded()
      this.characteristic = characteristic

      // Attach the listener and subscribe before commanding, or the first response frame
      // arrives with no notification context and Chrome silently drops it.
      characteristic.addEventListener('characteristicvaluechanged', this.handleValue)
      await characteristic.startNotifications()
      abortIfSuperseded()

      await this.request(CMD_DEVICE_INFO)
      await this.request(CMD_CELL_INFO)
      // One-shot: the device answers with a single logbook frame. A unit that never sends one
      // (older firmware) simply leaves the log empty, which the view says plainly.
      await this.request(CMD_LOGBOOK)
      abortIfSuperseded()
    } catch (error) {
      // Only ever our own link to tear down. A superseded attempt is holding a device the client
      // has already let go of, and the teardown below reaches for whatever is current instead —
      // dropping a live link and, because it unbinds the drop handler first, doing it in silence.
      // Unwinding empty-handed is the whole reason the token exists.
      if (token === this.attachToken) await this.disconnect()
      throw error
    }

    this.lastFrameAt = Date.now()
    this.stallStrikes = 0
    this.stallTimer = setInterval(this.checkStall, STALL_CHECK_MS)
  }

  /**
   * `attach` under a deadline, and under the caller's signal. When either fires it supersedes the
   * attempt (bumping the token so the still-running `attach` aborts at its next checkpoint) and
   * tears the half-open link down through `disconnect` — which detaches the drop handler first, so
   * neither surfaces as a "Lost the BMS" over a reconnect that simply never found the pack.
   *
   * The teardown is also what cancels a `gatt.connect()` still outstanding: Chromium rejects it out
   * of `gatt.disconnect()`. That is worth having and is not worth trusting on its own, which is why
   * the deadline stands whether or not the cancel reaches the radio underneath.
   */
  private attachWithin(device: BluetoothDevice, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
    const token = (this.attachToken += 1)
    return new Promise<void>((resolve, reject) => {
      let settled = false

      const settle = (failure: Error | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', standDownNow)
        if (failure === null) resolve()
        else reject(failure)
      }

      /** Ends an attach that is still running, rather than waiting on one nobody is holding. */
      const abandonAttach = (failure: Error): void => {
        if (settled) return
        this.attachToken += 1
        void this.disconnect()
        settle(failure)
      }

      const standDownNow = (): void => abandonAttach(standDown('Reconnect stood down'))
      const timer = setTimeout(() => {
        abandonAttach(new Error('Reconnect timed out. The pack may be out of range or asleep. Use Connect BMS.'))
      }, timeoutMs)

      if (signal?.aborted === true) {
        standDownNow()
        return
      }
      signal?.addEventListener('abort', standDownNow)
      this.attach(device, token).then(
        () => settle(null),
        (error: unknown) => settle(error as Error),
      )
    })
  }

  async disconnect(): Promise<void> {
    await this.tearDownLink()
  }

  /**
   * Ends the link this client is holding, and answers whether it was still the client's last word
   * by the time it finished.
   *
   * Everything down to the unsubscribe is immediate and unconditional — the handlers come off, the
   * timers stop, the sighting wait is stood down and the attach token moves on — so a teardown
   * always takes the link away from whoever asked for it, the owner's own press included.
   *
   * What follows the unsubscribe cannot be. `stopNotifications()` is a descriptor write over a link
   * that may be congested enough to have blown an attach's budget in the first place, and it can
   * outlive the attempt that asked for the teardown: the probe abandons an attach mid-subscribe at
   * two and a half seconds, and the sighting behind it then hands the very same handle to a
   * handshake that succeeds. Dropping the GATT link at that point would kill a rejoin that had just
   * been made, and do it in silence, because the drop handler came off at the top. So the handle is
   * dropped only while nothing newer is holding it, and the assembler — which belongs to whoever
   * holds the link now — is reset only while this teardown is still the current generation.
   */
  private async tearDownLink(): Promise<boolean> {
    this.stopStallTimer()
    // A rejoin still waiting on a sighting is stood down here too. Nothing else would ever settle
    // it — the pack it is listening for may never come back — and its watch and re-arm timer would
    // go on running over a client the app has finished with.
    this.sightingWait?.abandon()
    // A read still in flight is settled with what it collected rather than left hanging on a
    // characteristic that is about to be unsubscribed.
    this.detailLogRun?.stop()
    // Supersede any attach still in flight, so a handshake completing after a deliberate teardown
    // aborts rather than re-establishing the link this call is tearing down.
    const generation = (this.attachToken += 1)
    // Detach the drop handler before the first await. If the physical link drops during
    // stopNotifications() below — common when the user disconnects precisely because the
    // unit is going out of range — handleDisconnect must not fire and paint a scary
    // "Lost the BMS" error over what is a deliberate teardown.
    const device = this.device
    this.device = null
    device?.removeEventListener('gattserverdisconnected', this.handleDisconnect)

    const characteristic = this.characteristic
    this.characteristic = null
    if (characteristic) {
      characteristic.removeEventListener('characteristicvaluechanged', this.handleValue)
      try {
        await characteristic.stopNotifications()
      } catch {
        // The link may already be gone; nothing to unsubscribe from.
      }
    }
    // A newer attempt that adopted this same handle has already dropped whatever was on it as its
    // own first act, and what is on it now is theirs.
    if (this.device !== device) device?.gatt?.disconnect()
    const stillOurs = generation === this.attachToken
    if (stillOurs) this.assembler.reset()
    return stillOurs
  }

  readDetailLog(packClock: { readonly packUtcOffsetMinutes: number }): Promise<DetailLogTransfer> {
    if (this.detailLogRead === null) {
      this.detailLogRead = this.collectDetailLog(packClock.packUtcOffsetMinutes).finally(() => {
        this.detailLogRead = null
      })
    }
    return this.detailLogRead
  }

  /**
   * Writes 0xA7 and measures the window behind it.
   *
   * The stall watch is suspended for the read and restarted after it, deliberately. A pack that is
   * preparing a dump goes quiet, and three quiet strikes tear the link down at about twenty-four
   * seconds — killing the very measurement this method exists to take, and doing it in a way that
   * would read as "the pack stopped answering" when the pack was busy answering. Suspending also
   * keeps the stall poke out of the window: its cell-info reply would otherwise be counted as bytes
   * 0xA7 produced, which is exactly the confusion the raw byte count is here to prevent.
   *
   * Nothing is lost by suspending. A link that genuinely dies still reports through
   * gattserverdisconnected, which is untouched, and the run settles with what it collected; the
   * ceiling inside the run bounds the blind window either way.
   */
  private async collectDetailLog(packUtcOffsetMinutes: number): Promise<DetailLogTransfer> {
    if (!this.connected || this.characteristic === null) {
      throw new Error('Connect the BMS before reading its stored log.')
    }
    this.stopStallTimer()
    const run = new DetailLogRun(packUtcOffsetMinutes)
    this.detailLogRun = run
    try {
      await this.request(CMD_DETAIL_LOG)
      return await run.transfer
    } finally {
      run.stop()
      this.detailLogRun = null
      this.resumeStallWatch()
    }
  }

  /**
   * Puts the stall watch back with a fresh grace period, so the silence the read asked for is never
   * counted against the pack. Skipped on a link that has gone away in the meantime — there is
   * nothing left to poke, and a timer over a dead radio would report a stall for a link that
   * already announced its own drop.
   */
  private resumeStallWatch(): void {
    if (!this.connected || this.stallTimer !== null) return
    this.lastFrameAt = Date.now()
    this.stallStrikes = 0
    this.stallTimer = setInterval(this.checkStall, STALL_CHECK_MS)
  }

  private async request(command: number): Promise<void> {
    const characteristic = this.characteristic
    if (!characteristic) return
    const frame = toArrayBuffer(buildCommand(command))
    if (characteristic.properties.writeWithoutResponse) {
      await characteristic.writeValueWithoutResponse(frame)
    } else {
      await characteristic.writeValueWithResponse(frame)
    }
  }

  private readonly handleValue = (event: Event): void => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value
    if (!value) return
    const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    // Counted before the assembler is given it. A pack that ignored the command and a burst the
    // transport tore up both assemble to nothing, and only the raw byte count tells them apart.
    this.detailLogRun?.noteNotification(chunk)

    for (const frame of this.assembler.feed(chunk)) {
      this.lastFrameAt = Date.now()
      this.stallStrikes = 0
      // Every frame in the window, whatever its type: a window that assembled frames and no detail
      // log is a finding of its own, and it is only visible if the other types reach the run too.
      this.detailLogRun?.noteFrame(frame)
      try {
        switch (frameType(frame)) {
          case FRAME_CELL_INFO:
            this.handlers.onSnapshot?.(decodeCellInfo(frame))
            break
          case FRAME_DEVICE_INFO:
            this.handlers.onDeviceInfo?.(decodeDeviceInfo(frame))
            break
          case FRAME_SETTINGS:
            this.handlers.onSettings?.(decodeSettings(frame))
            break
          case FRAME_LOGBOOK:
            this.handlers.onLogbook?.(decodeLogbook(frame))
            break
          case FRAME_DETAIL_LOG:
            // Decoded only while a read is running: the offset that resolves the pack's counter
            // comes from the caller, and nothing outside a transfer consumes these records. It sits
            // in the switch so a frame that will not decode reaches onError like every other type,
            // instead of failing the whole transfer.
            this.detailLogRun?.readRecordsFrom(frame)
            break
        }
      } catch (error) {
        this.handlers.onError?.(error as Error)
      }
    }
  }

  private readonly checkStall = (): void => {
    if (!this.connected) return
    if (Date.now() - this.lastFrameAt < STALL_TIMEOUT_MS) return
    this.stallStrikes += 1
    if (this.stallStrikes >= MAX_STALL_STRIKES) {
      // The link is up but the BMS has gone silent and is not answering the pokes. Give up
      // loudly: tear it down through the normal disconnect path, then run onDisconnect
      // ourselves (disconnect() detaches the drop handler, so it will not fire on its own).
      void this.giveUp()
      return
    }
    this.lastFrameAt = Date.now()
    void this.request(CMD_CELL_INFO).catch(() => undefined)
  }

  private async giveUp(): Promise<void> {
    // Only if the teardown was still the last word. A press that lands while the unsubscribe is
    // outstanding can have a fresh link up by the time this resumes, and reporting the stall then
    // would tell the app the pack went away over a link that is answering.
    if (await this.tearDownLink()) this.handlers.onDisconnect?.('stalled')
  }

  private readonly handleDisconnect = (): void => {
    this.stopStallTimer()
    // The bytes counted before the radio went are a measurement in their own right, so the read
    // ends with them rather than waiting out a ceiling nothing can answer.
    this.detailLogRun?.stop()
    // Supersede any attach still in flight. The link it is handshaking over has just gone, and
    // without this the remaining requests write to a null characteristic and return quietly — the
    // handshake would then "succeed" and start a stall timer over a dead radio.
    this.attachToken += 1
    this.characteristic = null
    this.assembler.reset()
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnect)
      this.device = null
    }
    this.handlers.onDisconnect?.('dropped')
  }

  private stopStallTimer(): void {
    if (this.stallTimer !== null) {
      clearInterval(this.stallTimer)
      this.stallTimer = null
    }
  }
}
