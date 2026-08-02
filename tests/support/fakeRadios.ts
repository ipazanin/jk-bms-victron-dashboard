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
import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../../src/domain/bms/types'
import type { SolarHistoryTransfer } from '../../src/domain/solar/SolarHistoryTransfer'
import type { SolarReading } from '../../src/domain/solar/types'
import type { BmsLink, DisconnectReason, JkBmsHandlers } from '../../src/infrastructure/ble/JkBmsClient'
import type {
  SolarHistoryHandlers,
  SolarHistoryLink,
} from '../../src/infrastructure/ble/VictronHistoryClient'
import type { SolarScan, VictronHandlers } from '../../src/infrastructure/ble/VictronScanner'

/**
 * What a radio says over its own link from inside an attempt that then fails. The real client
 * reports a drop, or a frame it could not read, through the handlers while the handshake is still
 * running, and the rejection follows; a spec pairs the two so both land in the one attempt.
 */
interface InterruptedAttempt {
  readonly report: () => void
  readonly rejection: Error
}

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
  let connected = false
  let nextConnectError: Error | null = null
  let nextReconnectError: Error | null = null
  let interruptedConnect: InterruptedAttempt | null = null
  let interruptedReconnect: InterruptedAttempt | null = null
  let lastReconnectId: string | null = null
  let nextDetailLog: DetailLogTransfer = NOTHING_CAME_BACK
  let nextDetailLogError: Error | null = null
  let lastDetailLogOffsetMinutes: number | null = null

  const link: BmsLink = {
    deviceName: options.deviceName ?? null,
    deviceId: options.deviceId ?? null,
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
      const failure = nextConnectError
      nextConnectError = null
      if (failure !== null) throw failure
      connected = true
    },
    async reconnect(deviceId: string) {
      lastReconnectId = deviceId
      const interrupted = interruptedReconnect
      interruptedReconnect = null
      if (interrupted !== null) {
        interrupted.report()
        throw interrupted.rejection
      }
      const failure = nextReconnectError
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
    get connected() {
      return connected
    },
    get lastReconnectId() {
      return lastReconnectId
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

/**
 * The controller's history tunnel, which is a one-shot errand rather than a link that stays up.
 *
 * There is no `connected` here for the same reason the real port has no `connect`: a sweep opens
 * the tunnel, reads and closes it, so between sweeps there is nothing to be connected to.
 */
export interface FakeSolarHistoryLink {
  /** Hand this to `createTelemetry` as `createSolarHistoryLink`. */
  create(handlers: SolarHistoryHandlers): SolarHistoryLink
  /** What the next sweep comes back with. Silence, until a spec says otherwise. */
  answerNextSweepWith(transfer: SolarHistoryTransfer): void
  /** How a dismissed chooser or a controller that will not connect reaches the app. */
  failNextSweepWith(error: Error): void
  /** How many sweeps the app asked for, so a spec can assert a guard actually guarded. */
  readonly sweeps: number
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

export function fakeSolarHistoryLink(options: { readonly deviceName?: string | null } = {}): FakeSolarHistoryLink {
  let reading = false
  let sweeps = 0
  let nextTransfer: SolarHistoryTransfer = NO_TUNNEL_ANSWER
  let nextError: Error | null = null

  const link: SolarHistoryLink = {
    get reading() {
      return reading
    },
    get deviceName() {
      return options.deviceName ?? 'SmartSolar HQ2'
    },
    async readStoredHistory() {
      sweeps += 1
      reading = true
      try {
        const failure = nextError
        nextError = null
        if (failure !== null) throw failure
        return nextTransfer
      } finally {
        reading = false
      }
    },
  }

  return {
    create() {
      return link
    },
    answerNextSweepWith: (transfer) => {
      nextTransfer = transfer
    },
    failNextSweepWith: (error) => {
      nextError = error
    },
    get sweeps() {
      return sweeps
    },
  }
}
