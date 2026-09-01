/**
 * Radios that report exactly what a spec tells them to.
 *
 * `createTelemetry` takes factories rather than instances because the handlers have to be bound
 * before the radio exists, and because the concrete clients are nominal — their private fields
 * mean no object literal could ever be typed as one. These fakes are the other implementation of
 * the same two ports, so a spec drives the real wiring: the same handlers, in the same order,
 * through the same guards the browser goes through.
 */

import type { DetailLogTransfer } from '../../src/domain/bms/DetailLogTransfer'
import type { BatterySnapshot, DeviceInfo } from '../../src/domain/bms/types'
import type { SolarHistoryTransfer } from '../../src/domain/solar/SolarHistoryTransfer'
import type { SolarReading } from '../../src/domain/solar/types'
import type { BmsLink, DisconnectReason, JkBmsHandlers } from '../../src/infrastructure/ble/JkBmsClient'
import type { ReconnectPatience } from '../../src/infrastructure/ble/ReconnectPatience'
import type {
  SolarHistoryHandlers,
  SolarHistoryLink,
} from '../../src/infrastructure/ble/VictronHistoryClient'
import type { SolarScan, VictronHandlers } from '../../src/infrastructure/ble/solarScan'

/**
 * What a radio says over its own link from inside an attempt that then fails. The real client
 * reports a drop, or a frame it could not read, through the handlers while the handshake is still
 * running, and the rejection follows; a spec pairs the two so both land in the one attempt.
 */
interface InterruptedAttempt {
  readonly report: () => void
  readonly rejection: Error
}

/** A reconnect parked until the pack is heard from, with the two ways that wait can end. */
interface ParkedRejoin {
  readonly proceed: () => void
  readonly standDown: () => void
}

export interface FakeBmsLink {
  /** Hand this to `createTelemetry` as `createBmsLink`. */
  create(handlers: JkBmsHandlers): BmsLink
  emitSnapshot(snapshot: BatterySnapshot): void
  emitDeviceInfo(info: DeviceInfo): void
  emitDisconnect(reason?: DisconnectReason): void
  emitError(error: Error): void
  /**
   * How a pack that would not answer reaches the app: reconnect() rejects, once. One-shot by
   * design, so a spec about a single attempt cannot accidentally poison the next one — a supervisor
   * that retries wants `failEveryReconnectWith` instead.
   */
  failNextReconnectWith(error: Error): void
  /**
   * The same failure, for every reconnect from now on. Null lifts it, which is how a spec plays the
   * pack coming back after a run of failed attempts. A `ReconnectRefusedError` armed here is how
   * permission being gone reaches the app, since the real client refuses that before it ever
   * reaches the radio.
   */
  failEveryReconnectWith(error: Error | null): void
  /**
   * The pack is not in range: reconnect() parks, waiting for a sighting, exactly as the real client
   * does rather than failing. It stays parked until `sightPack`, or until the caller's signal
   * stands it down — unless the caller said it could not wait for one, which fails instead.
   */
  holdReconnectUntilSighted(): void
  /** The pack arrives in range. Every parked reconnect proceeds, and later ones no longer park. */
  sightPack(): void
  /** How many reconnects are parked waiting for a sighting, so a spec can assert none attached. */
  readonly reconnectsAwaitingSighting: number
  /**
   * The chooser hands back a different pack. Everything the link reports from here on is that
   * one's — its handle and its name — which is the whole of what the app can tell about the swap
   * until a device-info frame arrives to say so.
   */
  becomesAnotherPack(deviceId: string, deviceName?: string | null): void
  /**
   * Arms the next connect() to run `report` — a drop, a decode failure, anything the handlers
   * carry — and only then reject with `rejection`. Both land inside the one attempt, in that
   * order, which is what a spec about the resulting banner needs.
   */
  reportDuringNextConnect(report: () => void, rejection: Error): void
  /** The same one-shot on the chooser-free path. */
  reportDuringNextReconnect(report: () => void, rejection: Error): void
  /** The last id reconnect() was asked for, so a spec can assert the persisted id was used. */
  readonly lastReconnectId: string | null
  /** How patient the last reconnect was allowed to be, which is what the page decided. */
  readonly lastReconnectPatience: ReconnectPatience | null
  /** What the next stored-log read comes back with. Silence, until a spec says otherwise. */
  answerNextDetailLogWith(transfer: DetailLogTransfer): void
  /** How a read over a link that has gone reaches the app: readDetailLog() rejects. */
  failNextDetailLogWith(error: Error): void
  /** The pack UTC offset the app supplied, so a spec can assert what it resolved records against. */
  readonly lastDetailLogOffsetMinutes: number | null
}

const NOTHING_CAME_BACK: DetailLogTransfer = {
  outcome: 'no-answer',
  notificationBytes: 0,
  notificationCount: 0,
  assembledFrameCount: 0,
  frames: [],
  records: [],
  rawRecords: [],
  elapsedMs: 8_000,
}

export function fakeBmsLink(
  options: { readonly deviceName?: string | null; readonly deviceId?: string | null } = {},
): FakeBmsLink {
  let handlers: JkBmsHandlers = {}
  let deviceName = options.deviceName ?? null
  let deviceId = options.deviceId ?? null
  let connected = false
  let nextReconnectError: Error | null = null
  let everyReconnectError: Error | null = null
  let interruptedConnect: InterruptedAttempt | null = null
  let interruptedReconnect: InterruptedAttempt | null = null
  let lastReconnectId: string | null = null
  let lastReconnectPatience: ReconnectPatience | null = null
  let packInRange = true
  const parkedRejoins: ParkedRejoin[] = []
  let nextDetailLog: DetailLogTransfer = NOTHING_CAME_BACK
  let nextDetailLogError: Error | null = null
  let lastDetailLogOffsetMinutes: number | null = null

  /** What the real client rejects with when its caller stands the attempt down. */
  const standDown = (): DOMException => new DOMException('Reconnect stood down', 'AbortError')

  const waitForSighting = (signal: AbortSignal | undefined): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      const parked: ParkedRejoin = {
        proceed: () => {
          signal?.removeEventListener('abort', parked.standDown)
          resolve()
        },
        standDown: () => {
          parkedRejoins.splice(parkedRejoins.indexOf(parked), 1)
          signal?.removeEventListener('abort', parked.standDown)
          reject(standDown())
        },
      }
      parkedRejoins.push(parked)
      signal?.addEventListener('abort', parked.standDown)
    })
  }

  const link: BmsLink = {
    get deviceName() {
      return deviceName
    },
    get deviceId() {
      return deviceId
    },
    get connected() {
      return connected
    },
    async connect() {
      const interrupted = interruptedConnect
      interruptedConnect = null
      if (interrupted !== null) {
        interrupted.report()
        throw interrupted.rejection
      }
      connected = true
    },
    async reconnect(deviceId: string, signal?: AbortSignal, patience: ReconnectPatience = 'wait-for-a-sighting') {
      lastReconnectId = deviceId
      lastReconnectPatience = patience
      if (signal?.aborted === true) throw standDown()
      // In range, the real client attaches straight away and this resolves the same way. Out of
      // range, its straight attach fails and it parks on a sighting, which is the whole of what a
      // caller can see of the difference — unless the caller cannot hold a watch, in which case
      // there is no second half to park on and the attempt is simply the pack not being there.
      if (!packInRange) {
        if (patience === 'straight-in-only') {
          throw new Error('Reconnect timed out. The pack may be out of range or asleep. Use Connect BMS.')
        }
        await waitForSighting(signal)
      }
      const interrupted = interruptedReconnect
      interruptedReconnect = null
      if (interrupted !== null) {
        interrupted.report()
        throw interrupted.rejection
      }
      const failure = nextReconnectError ?? everyReconnectError
      nextReconnectError = null
      if (failure !== null) throw failure
      connected = true
    },
    async readDetailLog({ packUtcOffsetMinutes }) {
      lastDetailLogOffsetMinutes = packUtcOffsetMinutes
      const failure = nextDetailLogError
      nextDetailLogError = null
      if (failure !== null) throw failure
      return nextDetailLog
    },
    async disconnect() {
      connected = false
    },
  }

  return {
    create(next) {
      handlers = next
      return link
    },
    get lastReconnectId() {
      return lastReconnectId
    },
    get lastReconnectPatience() {
      return lastReconnectPatience
    },
    get lastDetailLogOffsetMinutes() {
      return lastDetailLogOffsetMinutes
    },
    answerNextDetailLogWith: (transfer) => {
      nextDetailLog = transfer
    },
    failNextDetailLogWith: (error) => {
      nextDetailLogError = error
    },
    emitSnapshot: (snapshot) => handlers.onSnapshot?.(snapshot),
    emitDeviceInfo: (info) => handlers.onDeviceInfo?.(info),
    emitDisconnect: (reason = 'dropped') => {
      connected = false
      handlers.onDisconnect?.(reason)
    },
    emitError: (error) => handlers.onError?.(error),
    failNextReconnectWith: (error) => {
      nextReconnectError = error
    },
    failEveryReconnectWith: (error) => {
      everyReconnectError = error
    },
    holdReconnectUntilSighted: () => {
      packInRange = false
    },
    sightPack: () => {
      packInRange = true
      for (const parked of parkedRejoins.splice(0)) parked.proceed()
    },
    get reconnectsAwaitingSighting() {
      return parkedRejoins.length
    },
    becomesAnotherPack: (nextDeviceId, nextDeviceName = null) => {
      deviceId = nextDeviceId
      deviceName = nextDeviceName
    },
    reportDuringNextConnect: (report, rejection) => {
      interruptedConnect = { report, rejection }
    },
    reportDuringNextReconnect: (report, rejection) => {
      interruptedReconnect = { report, rejection }
    },
  }
}

export interface FakeSolarScan {
  /** Hand this to `createTelemetry` as `createSolarScan`. */
  create(handlers: VictronHandlers): SolarScan
  readonly scanning: boolean
  /**
   * The controller the chooser would have handed back, reported once a start has the watch up.
   * A null id is the route that names no device — the browser's own scan, or the bridge.
   */
  reportsDevice(deviceId: string | null, deviceName?: string | null): void
  /** Whether the route this browser would take could come up with no gesture at all. */
  allowResume(allowed: boolean): void
  /**
   * The bridge's shape rather than the watch's. A WebSocket needs no device handle at all, so it
   * answers `canResume` the same however little this browser remembers — which is the case where
   * a supervisor leaning on the transport to know when to stop gets it wrong.
   */
  resumesWithNoHandle(): void
  /** What `resume` does from now on. Null lets it succeed. */
  failResumeWith(rejection: Error | null): void
  /**
   * What `start` does from now on — a radio refusing the press, or a prompt dismissed. Null lets it
   * succeed. It is the one way a watch goes back to idle with nothing said to the supervisor.
   */
  failStartWith(rejection: Error | null): void
  /**
   * Holds the next resume outstanding and hands back what settles it, so a spec can land a press
   * in the middle of one — which on a real radio is the whole of a second or two.
   */
  parkNextResume(): () => void
  /** Every remembered id `resume` was asked for, in order, so a spec can read the loop off. */
  readonly resumeCalls: readonly (string | null)[]
  emitReading(reading: SolarReading, rssi?: number): void
  emitStale(): void
  /** A complaint from a scan that is still up — an advertisement that would not decode, say. */
  emitError(error: Error): void
  /**
   * The watch going away without being asked: a re-arm the radio refused takes the whole scan down,
   * staleness clock and all, and `onError` is the only word the transport has for it.
   */
  reportsWatchTornDown(error: Error): void
}

export function fakeSolarScan(): FakeSolarScan {
  let handlers: VictronHandlers = {}
  let scanning = false
  let watchedDevice: { id: string; name: string | null } | null = null
  let resumeAllowed = false
  let handleNeeded = true
  let resumeRejection: Error | null = null
  let startRejection: Error | null = null
  let parkedResume: Promise<void> | null = null
  const resumeCalls: (string | null)[] = []

  const scan: SolarScan = {
    get scanning() {
      return scanning
    },
    async start() {
      if (startRejection !== null) throw startRejection
      scanning = true
      if (watchedDevice) handlers.onWatchedDevice?.(watchedDevice.id, watchedDevice.name)
    },
    // Shaped like the watch by default, which is the route this matters on: a browser that could
    // resume still cannot resume to a controller it has never been shown. `resumesWithNoHandle`
    // swaps in the bridge's answers, which are about the route alone — yes to both, whatever is
    // remembered and whatever `allowResume` says, exactly as `BridgeSolarScan` answers.
    canResume: (rememberedDeviceId) => !handleNeeded || (resumeAllowed && rememberedDeviceId !== null),
    // The route on its own, which is what `allowResume` has always meant: whether a controller has
    // been shown to it yet is the other question.
    canEverResume: () => !handleNeeded || resumeAllowed,
    async resume(_keyHex, rememberedDeviceId) {
      resumeCalls.push(rememberedDeviceId)
      const parked = parkedResume
      parkedResume = null
      if (parked !== null) await parked
      if (resumeRejection !== null) throw resumeRejection
      scanning = true
    },
    stop() {
      scanning = false
    },
  }

  return {
    create(next) {
      handlers = next
      return scan
    },
    get scanning() {
      return scanning
    },
    reportsDevice: (deviceId, deviceName = null) => {
      watchedDevice = deviceId === null ? null : { id: deviceId, name: deviceName }
    },
    allowResume: (allowed) => {
      resumeAllowed = allowed
    },
    resumesWithNoHandle: () => {
      handleNeeded = false
    },
    failResumeWith: (rejection) => {
      resumeRejection = rejection
    },
    failStartWith: (rejection) => {
      startRejection = rejection
    },
    parkNextResume() {
      let settle = (): void => undefined
      parkedResume = new Promise<void>((resolve) => {
        settle = () => resolve()
      })
      return settle
    },
    get resumeCalls() {
      return [...resumeCalls]
    },
    emitReading: (reading, rssi = -67) => handlers.onReading?.(reading, rssi),
    emitStale: () => handlers.onStale?.(),
    emitError: (error) => handlers.onError?.(error),
    reportsWatchTornDown: (error) => {
      scanning = false
      handlers.onError?.(error)
    },
  }
}

/**
 * The controller's history tunnel, which is a one-shot errand rather than a link that stays up.
 *
 * There is no `connected` here for the same reason the real port has no `connect`: a sweep opens
 * the tunnel, reads and closes it, so between sweeps there is nothing to be connected to.
 */
export interface FakeSolarHistoryLink {
  /** Hand this to `createTelemetry` as `createSolarHistoryLink`. */
  create(handlers: SolarHistoryHandlers): SolarHistoryLink
  /**
   * What a sweep comes back with from here on, by either route. Silence, until a spec says
   * otherwise — which is what every spec that never mentions the tunnel is relying on.
   */
  answerNextSweepWith(transfer: SolarHistoryTransfer): void
  /**
   * How a tunnel that would not open reaches the app: the sweep rejects, once. One-shot by design,
   * so a spec about a single refused sweep cannot poison the read that follows it — which is the
   * shape a spec about the app trying again needs.
   */
  failNextSweepWith(error: Error): void
  /**
   * Holds the next sweep outstanding and hands back what settles it, so a spec can land a second
   * read, a stand-down or a live watch in the middle of one — which on a real tunnel is the better
   * part of a minute, and the whole window the two radios are contending for.
   */
  parkNextSweep(): () => void
  /** How many sweeps went through the chooser, which is how many gestures a spec has spent. */
  readonly chooserSweepCount: number
  /**
   * Every controller id the chooser-free route was asked for, in order, so a spec can read off both
   * how often history gathered itself and which controller it went back to.
   */
  readonly rememberedSweepCalls: readonly string[]
}

const NO_TUNNEL_ANSWER: SolarHistoryTransfer = {
  outcome: 'no-answer',
  totals: null,
  days: [],
  refusedRegisters: [],
  notificationBytes: 0,
  notificationCount: 0,
  controlNotificationCount: 4,
  pduCount: 0,
  unreadableReplyCount: 0,
  elapsedMs: 9_000,
}

export function fakeSolarHistoryLink(): FakeSolarHistoryLink {
  let nextSweep: SolarHistoryTransfer = NO_TUNNEL_ANSWER
  let nextSweepError: Error | null = null
  let parkedSweep: Promise<void> | null = null
  /** Held so a second read joins the running sweep instead of opening a rival tunnel. */
  let session: Promise<SolarHistoryTransfer> | null = null
  let chooserSweepCount = 0
  const rememberedSweepCalls: string[] = []

  const sweep = (): Promise<SolarHistoryTransfer> => {
    if (session !== null) return session
    const parked = parkedSweep
    parkedSweep = null
    const running = (parked ?? Promise.resolve())
      .then(() => {
        const failure = nextSweepError
        nextSweepError = null
        if (failure !== null) throw failure
        return nextSweep
      })
      .finally(() => {
        session = null
      })
    session = running
    return running
  }

  const link: SolarHistoryLink = {
    get reading() {
      return session !== null
    },
    get deviceName() {
      return 'SmartSolar HQ2'
    },
    readStoredHistory() {
      chooserSweepCount += 1
      return sweep()
    },
    readRememberedHistory(deviceId: string) {
      rememberedSweepCalls.push(deviceId)
      return sweep()
    },
  }

  return {
    create() {
      return link
    },
    answerNextSweepWith: (transfer) => {
      nextSweep = transfer
    },
    failNextSweepWith: (error) => {
      nextSweepError = error
    },
    parkNextSweep() {
      let settle = (): void => undefined
      parkedSweep = new Promise<void>((resolve) => {
        settle = () => resolve()
      })
      return settle
    },
    get chooserSweepCount() {
      return chooserSweepCount
    },
    get rememberedSweepCalls() {
      return [...rememberedSweepCalls]
    },
  }
}
