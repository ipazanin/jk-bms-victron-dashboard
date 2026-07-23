/**
 * Radios that report exactly what a spec tells them to.
 *
 * `createTelemetry` takes factories rather than instances because the handlers have to be bound
 * before the radio exists, and because the concrete clients are nominal — their private fields
 * mean no object literal could ever be typed as one. These fakes are the other implementation of
 * the same two ports, so a spec drives the real wiring: the same handlers, in the same order,
 * through the same guards the browser goes through.
 */

import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../../src/domain/bms/types'
import type { SolarReading } from '../../src/domain/solar/types'
import type { BmsLink, DisconnectReason, JkBmsHandlers } from '../../src/infrastructure/ble/JkBmsClient'
import type { SolarScan, VictronHandlers } from '../../src/infrastructure/ble/VictronScanner'

export interface FakeBmsLink {
  /** Hand this to `createTelemetry` as `createBmsLink`. */
  create(handlers: JkBmsHandlers): BmsLink
  readonly connected: boolean
  emitSnapshot(snapshot: BatterySnapshot): void
  emitDeviceInfo(info: DeviceInfo): void
  emitSettings(settings: BmsSettings): void
  emitDisconnect(reason?: DisconnectReason): void
  emitError(error: Error): void
  /** How a dismissed chooser reaches the app: connect() rejects and nothing else changes. */
  failNextConnectWith(error: Error): void
  /** How an out-of-range or permission-gone pack reaches the app: reconnect() rejects. */
  failNextReconnectWith(error: Error): void
  /** The last id reconnect() was asked for, so a spec can assert the persisted id was used. */
  readonly lastReconnectId: string | null
}

export function fakeBmsLink(
  options: { readonly deviceName?: string | null; readonly deviceId?: string | null } = {},
): FakeBmsLink {
  let handlers: JkBmsHandlers = {}
  let connected = false
  let nextConnectError: Error | null = null
  let nextReconnectError: Error | null = null
  let lastReconnectId: string | null = null

  const link: BmsLink = {
    deviceName: options.deviceName ?? null,
    deviceId: options.deviceId ?? null,
    get connected() {
      return connected
    },
    async connect() {
      const failure = nextConnectError
      nextConnectError = null
      if (failure !== null) throw failure
      connected = true
    },
    async reconnect(deviceId: string) {
      lastReconnectId = deviceId
      const failure = nextReconnectError
      nextReconnectError = null
      if (failure !== null) throw failure
      connected = true
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
    get connected() {
      return connected
    },
    get lastReconnectId() {
      return lastReconnectId
    },
    emitSnapshot: (snapshot) => handlers.onSnapshot?.(snapshot),
    emitDeviceInfo: (info) => handlers.onDeviceInfo?.(info),
    emitSettings: (settings) => handlers.onSettings?.(settings),
    emitDisconnect: (reason = 'dropped') => {
      connected = false
      handlers.onDisconnect?.(reason)
    },
    emitError: (error) => handlers.onError?.(error),
    failNextConnectWith: (error) => {
      nextConnectError = error
    },
    failNextReconnectWith: (error) => {
      nextReconnectError = error
    },
  }
}

export interface FakeSolarScan {
  /** Hand this to `createTelemetry` as `createSolarScan`. */
  create(handlers: VictronHandlers): SolarScan
  readonly scanning: boolean
  emitReading(reading: SolarReading, rssi?: number): void
  emitForeignDevice(): void
  emitStale(): void
  emitIdentity(modelId: number): void
  emitError(error: Error): void
  failNextStartWith(error: Error): void
}

export function fakeSolarScan(): FakeSolarScan {
  let handlers: VictronHandlers = {}
  let scanning = false
  let nextStartError: Error | null = null

  const scan: SolarScan = {
    get scanning() {
      return scanning
    },
    async start() {
      const failure = nextStartError
      nextStartError = null
      if (failure !== null) throw failure
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
    emitReading: (reading, rssi = -67) => handlers.onReading?.(reading, rssi),
    emitForeignDevice: () => handlers.onForeignDevice?.(),
    emitStale: () => handlers.onStale?.(),
    emitIdentity: (modelId) => handlers.onIdentity?.(modelId),
    emitError: (error) => handlers.onError?.(error),
    failNextStartWith: (error) => {
      nextStartError = error
    },
  }
}
