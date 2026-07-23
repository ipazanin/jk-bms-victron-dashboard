/**
 * Web Bluetooth GATT transport for the JK-BMS.
 *
 * `connect` must be called synchronously from a user gesture: requestDevice is the first
 * statement, before any await, or the browser rejects it for lack of transient activation.
 *
 * The chooser matches on ADVERTISED service UUIDs, not on services discovered after
 * connecting. Some units advertise 0xFFE0; others advertise only their serial number as
 * the device name. Both filters are offered, and `showAllDevices` is the escape hatch when
 * a unit advertises neither.
 */

import {
  CMD_CELL_INFO,
  CMD_DEVICE_INFO,
  CMD_LOGBOOK,
  FRAME_CELL_INFO,
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
import { toArrayBuffer } from '../../domain/bytes'
import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../../domain/bms/types'

const STALL_TIMEOUT_MS = 8_000
const STALL_CHECK_MS = 2_000
/**
 * How long a chooser-free reconnect waits before giving up. A permitted device that is not
 * advertising leaves `gatt.connect()` pending with nothing to answer it, so without this bound an
 * auto-reconnect to a pack that is simply out of range would sit on 'connecting' forever.
 */
const RECONNECT_TIMEOUT_MS = 6_000
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
  connect(showAllDevices?: boolean): Promise<void>
  /**
   * Reconnect to a previously-permitted device by its id, without the chooser. Needs no user
   * gesture. Rejects if the browser cannot list permitted devices, the id is not among them
   * (out of range, or permission gone), or the connection does not complete in time.
   */
  reconnect(deviceId: string): Promise<void>
  disconnect(): Promise<void>
}

export class JkBmsClient implements BmsLink {
  private device: BluetoothDevice | null = null
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null
  private readonly assembler = new FrameAssembler()
  private readonly handlers: JkBmsHandlers
  private connecting = false
  private lastFrameAt = 0
  private stallStrikes = 0
  private stallTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Identifies the current attach attempt. A timeout, disconnect or newer attempt bumps it, and the
   * running `attach` checks it after every await — so a handshake that completes after its deadline
   * unwinds instead of installing a listener and a stall timer on a link nothing is holding.
   */
  private attachToken = 0

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

  async connect(showAllDevices = false): Promise<void> {
    // One device at a time, and the guard is synchronous so it costs no transient activation.
    // A second connect would overwrite `device` while the first still carries our
    // gattserverdisconnected listener and nothing is left holding the reference needed to
    // unbind it — the abandoned link would then report its drop over the top of the live one.
    if (this.connecting || this.device !== null) return
    this.connecting = true

    const options: RequestDeviceOptions = showAllDevices
      ? { acceptAllDevices: true, optionalServices: [JK_SERVICE] }
      : { filters: [{ services: [JK_SERVICE] }, { namePrefix: 'JK' }], optionalServices: [JK_SERVICE] }

    try {
      // The chooser hands back a device the user just picked and is therefore in range, so this
      // path does not need the reconnect timeout: waiting for a device that is present is fine.
      const device = await navigator.bluetooth.requestDevice(options)
      await this.attach(device)
    } finally {
      this.connecting = false
    }
  }

  async reconnect(deviceId: string): Promise<void> {
    if (this.connecting || this.device !== null) return
    const bluetooth = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined
    if (!bluetooth || typeof bluetooth.getDevices !== 'function') {
      throw new Error('This browser cannot reconnect without the chooser. Use Connect BMS.')
    }
    this.connecting = true
    try {
      const permitted = await bluetooth.getDevices()
      const device = permitted.find((candidate) => candidate.id === deviceId)
      if (!device) {
        throw new Error('The last pack isn’t available to reconnect — it may be out of range. Use Connect BMS.')
      }
      await this.attachWithin(device, RECONNECT_TIMEOUT_MS)
    } finally {
      this.connecting = false
    }
  }

  /**
   * The post-chooser handshake, shared by `connect` and `reconnect`: open the GATT link, find the
   * characteristic, subscribe, then ask for the two frames. On any failure it unwinds through
   * `disconnect` so a half-open link never survives while the app believes it is idle.
   */
  private async attach(device: BluetoothDevice, token: number = (this.attachToken += 1)): Promise<void> {
    this.device = device
    device.addEventListener('gattserverdisconnected', this.handleDisconnect)

    // Thrown after any await once this attempt has been superseded — by its own timeout, a
    // disconnect, or a newer attempt — so a slow handshake that finally resolves unwinds instead of
    // wiring itself onto a link the app has already let go of.
    const abortIfSuperseded = (): void => {
      if (token !== this.attachToken) throw new DOMException('Reconnect superseded', 'AbortError')
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
      await this.disconnect()
      throw error
    }

    this.lastFrameAt = Date.now()
    this.stallStrikes = 0
    this.stallTimer = setInterval(this.checkStall, STALL_CHECK_MS)
  }

  /**
   * `attach` under a deadline. When the timer fires it supersedes the attempt (bumping the token so
   * the still-running `attach` aborts at its next checkpoint) and tears the half-open link down
   * through `disconnect` — which detaches the drop handler first, so the timeout does not surface as
   * a "Lost the BMS" over a reconnect that simply never found the pack.
   */
  private attachWithin(device: BluetoothDevice, timeoutMs: number): Promise<void> {
    const token = (this.attachToken += 1)
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.attachToken += 1
        void this.disconnect()
        reject(new Error('Reconnect timed out. The pack may be out of range or asleep. Use Connect BMS.'))
      }, timeoutMs)
      this.attach(device, token).then(
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error as Error)
        },
      )
    })
  }

  async disconnect(): Promise<void> {
    this.stopStallTimer()
    // Supersede any attach still in flight, so a handshake completing after a deliberate teardown
    // aborts rather than re-establishing the link this call is tearing down.
    this.attachToken += 1
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
    device?.gatt?.disconnect()
    this.assembler.reset()
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

    for (const frame of this.assembler.feed(chunk)) {
      this.lastFrameAt = Date.now()
      this.stallStrikes = 0
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
    await this.disconnect()
    this.handlers.onDisconnect?.('stalled')
  }

  private readonly handleDisconnect = (): void => {
    this.stopStallTimer()
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
