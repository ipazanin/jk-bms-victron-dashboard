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

export interface JkBmsHandlers {
  onSnapshot?: (snapshot: BatterySnapshot) => void
  onDeviceInfo?: (info: DeviceInfo) => void
  onSettings?: (settings: BmsSettings) => void
  onDisconnect?: () => void
  onError?: (error: Error) => void
}

export class JkBmsClient {
  private device: BluetoothDevice | null = null
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null
  private readonly assembler = new FrameAssembler()
  private readonly handlers: JkBmsHandlers
  private lastFrameAt = 0
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
    const options: RequestDeviceOptions = showAllDevices
      ? { acceptAllDevices: true, optionalServices: [JK_SERVICE] }
      : { filters: [{ services: [JK_SERVICE] }, { namePrefix: 'JK' }], optionalServices: [JK_SERVICE] }

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
    this.stallTimer = setInterval(this.checkStall, STALL_CHECK_MS)
  }

  async disconnect(): Promise<void> {
    this.stopStallTimer()
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
    const device = this.device
    this.device = null
    if (device) {
      device.removeEventListener('gattserverdisconnected', this.handleDisconnect)
      device.gatt?.disconnect()
    }
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
    this.lastFrameAt = Date.now()
    void this.request(CMD_CELL_INFO).catch(() => undefined)
  }

  private readonly handleDisconnect = (): void => {
    this.stopStallTimer()
    this.characteristic = null
    this.assembler.reset()
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnect)
      this.device = null
    }
    this.handlers.onDisconnect?.()
  }

  private stopStallTimer(): void {
    if (this.stallTimer !== null) {
      clearInterval(this.stallTimer)
      this.stallTimer = null
    }
  }
}
