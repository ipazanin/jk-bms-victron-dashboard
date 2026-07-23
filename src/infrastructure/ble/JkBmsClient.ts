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
  FRAME_CELL_INFO,
  FRAME_DEVICE_INFO,
  FRAME_SETTINGS,
  FrameAssembler,
  JK_CHARACTERISTIC,
  JK_SERVICE,
  buildCommand,
  frameType,
} from '../../domain/bms/protocol'
import { decodeCellInfo, decodeDeviceInfo, decodeSettings } from '../../domain/bms/decode'
import { toArrayBuffer } from '../../domain/bytes'
import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../../domain/bms/types'

const STALL_TIMEOUT_MS = 8_000
const STALL_CHECK_MS = 2_000
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
  connect(showAllDevices?: boolean): Promise<void>
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

  constructor(handlers: JkBmsHandlers = {}) {
    this.handlers = handlers
  }

  get connected(): boolean {
    return this.device?.gatt?.connected === true
  }

  get deviceName(): string | null {
    return this.device?.name ?? null
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
      const device = await navigator.bluetooth.requestDevice(options)
      this.device = device
      device.addEventListener('gattserverdisconnected', this.handleDisconnect)

      try {
        const server = await device.gatt!.connect()
        const service = await server.getPrimaryService(JK_SERVICE)
        const characteristic = await service.getCharacteristic(JK_CHARACTERISTIC)
        this.characteristic = characteristic

        // Attach the listener and subscribe before commanding, or the first response frame
        // arrives with no notification context and Chrome silently drops it.
        characteristic.addEventListener('characteristicvaluechanged', this.handleValue)
        await characteristic.startNotifications()

        await this.request(CMD_DEVICE_INFO)
        await this.request(CMD_CELL_INFO)
      } catch (error) {
        // A failure part-way through leaves listeners bound and the link open while the app
        // believes it is idle. Unwind before surfacing.
        await this.disconnect()
        throw error
      }

      this.lastFrameAt = Date.now()
      this.stallStrikes = 0
      this.stallTimer = setInterval(this.checkStall, STALL_CHECK_MS)
    } finally {
      this.connecting = false
    }
  }

  async disconnect(): Promise<void> {
    this.stopStallTimer()
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
