/**
 * The three radio ports, implemented against a recording instead of a radio.
 *
 * Each one is the same state machine the browser drives — connect, reconnect, read, disconnect —
 * with the hardware replaced by whatever the caller has armed. Nothing here decides *what* to play:
 * the links relay handler calls and settle attempts, and the controller above them owns the
 * recording, the clock and every lever. That split is what lets a control be a method call rather
 * than a rehearsal of the connect sequence.
 *
 * Every arming is sticky. A dev panel arms once and then presses the app's own buttons repeatedly,
 * where a one-shot would silently revert to the default on the second press and read as a bug in
 * the app rather than in the fake. The single exception is the report inside an attempt, which is
 * about one attempt by construction.
 */

import type { LogbookEvent } from '../../../domain/bms/logbook'
import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../../../domain/bms/types'
import type { SolarHistoryTransfer } from '../../../domain/solar/SolarHistoryTransfer'
import type { SolarReading } from '../../../domain/solar/types'
import type { BmsLink, DisconnectReason, JkBmsHandlers } from '../JkBmsClient'
import type { SolarHistoryHandlers, SolarHistoryLink } from '../VictronHistoryClient'
import type { SolarScan, VictronHandlers } from '../solarScan'

/** The name the history tunnel reports for the controller it last talked to. */
const DEMO_CONTROLLER_NAME = 'SmartSolar demo'

/**
 * A wait a caller can see on screen. Every dwell here is a real timer rather than a resolved
 * promise, because the states they exist to reach — 'Connecting…', 'Reading…', 'Sweeping…' — only
 * paint if the attempt is still outstanding when the frame is drawn.
 */
function dwell(dwellMs: number): Promise<void> {
  if (dwellMs <= 0) return Promise.resolve()
  return new Promise((settle) => setTimeout(settle, dwellMs))
}

export interface FakeBmsRadio {
  /** Hand this to `createTelemetry` as `createBmsLink`. */
  create(handlers: JkBmsHandlers): BmsLink
  readonly connected: boolean
  /**
   * What the link says the pack is, before any frame has decoded. A null name is the pack that
   * gives neither a serial nor a name and so cannot be filed against a device.
   */
  identifyAs(deviceName: string | null, deviceId: string | null): void
  /** How long `connect` and `reconnect` stay outstanding before they settle. */
  holdAttemptsFor(dwellMs: number): void
  /** How long a stored-log read stays outstanding before the armed answer is built. */
  holdStoredLogFor(dwellMs: number): void
  /** What `connect` does from now on. Null lets it succeed. */
  failConnectWith(rejection: Error | null): void
  /** What `reconnect` does from now on — an out-of-range pack, or a permission that has lapsed. */
  failReconnectWith(rejection: Error | null): void
  /**
   * Runs inside the next attempt, before it settles. A real pack that goes away mid-handshake
   * reports the drop through the handlers and the attempt rejects afterwards; both landing in the
   * one attempt is what decides which of the two banners is left standing.
   */
  reportDuringNextAttempt(report: () => void): void
  emitSnapshot(snapshot: BatterySnapshot): void
  emitDeviceInfo(info: DeviceInfo): void
  emitSettings(settings: BmsSettings): void
  emitLogbook(events: LogbookEvent[]): void
  emitDisconnect(reason: DisconnectReason): void
  emitError(error: Error): void
  /**
   * What a stored-log read comes back with from now on. It is a function of the pack clock and not
   * a finished transfer, because the app resolves the offset the records are dated against per read
   * and the answer has to be built against the one it actually supplied.
   */
  answerStoredLogWith(read: BmsLink['readDetailLog']): void
}

/**
 * `onLinkChange` fires whenever the link comes up or goes down, by any route — an attempt that
 * succeeded, a disconnect the user asked for, a drop pushed from above. The controller starts and
 * stops playback on it, so a frame can never reach a link that is not up.
 */
export function fakeBmsRadio(onLinkChange: () => void): FakeBmsRadio {
  let handlers: JkBmsHandlers = {}
  let connected = false
  let deviceName: string | null = null
  let deviceId: string | null = null
  let attemptDwellMs = 0
  let storedLogDwellMs = 0
  let connectRejection: Error | null = null
  let reconnectRejection: Error | null = null
  let reportDuringAttempt: (() => void) | null = null
  let answerStoredLog: BmsLink['readDetailLog'] = () =>
    Promise.reject(new Error('The fake pack has no stored-log answer armed.'))

  const settleAttempt = async (rejection: Error | null): Promise<void> => {
    await dwell(attemptDwellMs)
    const report = reportDuringAttempt
    reportDuringAttempt = null
    report?.()
    if (rejection !== null) throw rejection
    connected = true
    onLinkChange()
  }

  const link: BmsLink = {
    get connected() {
      return connected
    },
    get deviceName() {
      return deviceName
    },
    get deviceId() {
      return deviceId
    },
    async connect() {
      await settleAttempt(connectRejection)
    },
    async reconnect(id: string) {
      deviceId = id
      await settleAttempt(reconnectRejection)
    },
    async readDetailLog(packClock) {
      await dwell(storedLogDwellMs)
      return answerStoredLog(packClock)
    },
    async disconnect() {
      connected = false
      onLinkChange()
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
    identifyAs: (name, id) => {
      deviceName = name
      deviceId = id
    },
    holdAttemptsFor: (dwellMs) => {
      attemptDwellMs = dwellMs
    },
    holdStoredLogFor: (dwellMs) => {
      storedLogDwellMs = dwellMs
    },
    failConnectWith: (rejection) => {
      connectRejection = rejection
    },
    failReconnectWith: (rejection) => {
      reconnectRejection = rejection
    },
    reportDuringNextAttempt: (report) => {
      reportDuringAttempt = report
    },
    emitSnapshot: (snapshot) => handlers.onSnapshot?.(snapshot),
    emitDeviceInfo: (info) => handlers.onDeviceInfo?.(info),
    emitSettings: (settings) => handlers.onSettings?.(settings),
    emitLogbook: (events) => handlers.onLogbook?.(events),
    emitDisconnect: (reason) => {
      connected = false
      onLinkChange()
      handlers.onDisconnect?.(reason)
    },
    emitError: (error) => handlers.onError?.(error),
    answerStoredLogWith: (read) => {
      answerStoredLog = read
    },
  }
}

export interface FakeSolarRadio {
  /** Hand this to `createTelemetry` as `createSolarScan`. */
  create(handlers: VictronHandlers): SolarScan
  readonly scanning: boolean
  /** How long `start` stays outstanding before it settles. */
  holdStartFor(dwellMs: number): void
  /** What `start` does from now on. Null lets it succeed. */
  failStartWith(rejection: Error | null): void
  emitReading(reading: SolarReading, rssi: number): void
  emitStale(): void
  emitForeignDevice(): void
  emitIdentity(modelId: number): void
  emitError(error: Error): void
}

/** `onScanChange` fires whenever the scan starts or stops, on the same terms as the pack's link. */
export function fakeSolarRadio(onScanChange: () => void): FakeSolarRadio {
  let handlers: VictronHandlers = {}
  let scanning = false
  let startDwellMs = 0
  let startRejection: Error | null = null

  const scan: SolarScan = {
    get scanning() {
      return scanning
    },
    async start() {
      await dwell(startDwellMs)
      if (startRejection !== null) throw startRejection
      scanning = true
      onScanChange()
    },
    stop() {
      scanning = false
      onScanChange()
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
    holdStartFor: (dwellMs) => {
      startDwellMs = dwellMs
    },
    failStartWith: (rejection) => {
      startRejection = rejection
    },
    emitReading: (reading, rssi) => handlers.onReading?.(reading, rssi),
    emitStale: () => handlers.onStale?.(),
    emitForeignDevice: () => handlers.onForeignDevice?.(),
    emitIdentity: (modelId) => handlers.onIdentity?.(modelId),
    emitError: (error) => handlers.onError?.(error),
  }
}

/**
 * The controller's history tunnel, which is a one-shot errand rather than a link that stays up.
 *
 * There is no `connected` here for the same reason the real port has no `connect`: a sweep opens
 * the tunnel, reads and closes it, so between sweeps there is nothing to be connected to.
 */
export interface FakeSolarHistoryRadio {
  /** Hand this to `createTelemetry` as `createSolarHistoryLink`. */
  create(handlers: SolarHistoryHandlers): SolarHistoryLink
  readonly reading: boolean
  /** How long a sweep stays outstanding before the armed answer is built. */
  holdSweepFor(dwellMs: number): void
  /**
   * What a sweep comes back with from now on. It is handed the handlers because a real sweep talks
   * through them while it runs — progress as each register answers, and any reply it could not
   * read — and a fake that answered without them would leave those paths unreachable.
   */
  answerSweepWith(sweep: (handlers: SolarHistoryHandlers) => Promise<SolarHistoryTransfer>): void
}

export function fakeSolarHistoryRadio(): FakeSolarHistoryRadio {
  let handlers: SolarHistoryHandlers = {}
  let sweepDwellMs = 0
  let answerSweep: (given: SolarHistoryHandlers) => Promise<SolarHistoryTransfer> = () =>
    Promise.reject(new Error('The fake controller has no history answer armed.'))
  /** Held so a second press joins the running sweep instead of starting a rival session. */
  let session: Promise<SolarHistoryTransfer> | null = null

  const link: SolarHistoryLink = {
    get reading() {
      return session !== null
    },
    get deviceName() {
      return DEMO_CONTROLLER_NAME
    },
    readStoredHistory() {
      if (session !== null) return session
      const running = dwell(sweepDwellMs)
        .then(() => answerSweep(handlers))
        .finally(() => {
          session = null
        })
      session = running
      return running
    },
  }

  return {
    create(next) {
      handlers = next
      return link
    },
    get reading() {
      return session !== null
    },
    holdSweepFor: (dwellMs) => {
      sweepDwellMs = dwellMs
    },
    answerSweepWith: (sweep) => {
      answerSweep = sweep
    },
  }
}
