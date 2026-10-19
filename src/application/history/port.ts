import type { SessionHour } from '../../domain/history/SessionHour'
import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../../domain/bms/types'
import type { RingMergeOutcome } from '../../domain/history/RingMergeOutcome'
import type { RingSnapshot } from '../../domain/history/RingSnapshot'
import type { SolarHistorySnapshot } from '../../domain/history/SolarHistorySnapshot'
import type { SolarMergeOutcome } from '../../domain/history/SolarMergeOutcome'
import type { StoredRingLedger } from '../../domain/history/StoredRingLedger'
import type {
  CoverageRun,
  DeviceKey,
  DeviceRecord,
  HistoryChunk,
  PackChunk,
  SessionEndReason,
  SessionEntry,
  SessionId,
  SessionLedger,
  SessionRecord,
  SolarChunk,
  StreamName,
  TimeWindow,
  WarningRecord,
} from '../../domain/history/types'
import type { SolarReading } from '../../domain/solar/types'

export type { StoredRingLedger }

export type HistoryUnavailableReason =

  | 'no-indexeddb'
  /** open() rejected. */
  | 'open-denied'
  /** Another tab holds an older version of the database open. */
  | 'open-blocked'
  /** What is on disk was written by a newer build of this page, and is never deleted for it. */
  | 'version-newer'
  /** Writes are aborting. */
  | 'quota-exhausted'

export interface HistoryAvailability {
  readonly usable: boolean
  readonly reason: HistoryUnavailableReason | null

  readonly persisted: boolean | null

  readonly estimatedBytes: number | null
  readonly quotaBytes: number | null
}

export interface CommitOutcome {
  readonly stored: boolean
  readonly totalSamples: number
  readonly prunedSessionIds: readonly SessionId[]

  readonly truncatedFrom: number | null
  readonly failure: HistoryUnavailableReason | null
}

export interface RingIngestOutcome extends RingMergeOutcome {
  readonly stored: boolean

  readonly totalRecords: number

  readonly prunedRecords: number
  readonly failure: HistoryUnavailableReason | null
}

export interface SolarHistoryIngestOutcome extends SolarMergeOutcome {
  readonly stored: boolean

  readonly totalDays: number

  readonly prunedRecords: number
  readonly failure: HistoryUnavailableReason | null
}

export interface RingLedgerSummary {
  readonly deviceKey: DeviceKey
  readonly kind: DeviceRecord['kind']
  readonly label: string
  readonly records: number
  readonly lastReadAt: number
  readonly oldestPackClockSeconds: number
  readonly newestPackClockSeconds: number
}

export interface SessionPatch {
  readonly heartbeatAt: number
  readonly packSamples: number
  readonly solarSamples: number
  readonly packChunks: number
  readonly solarChunks: number
  readonly droppedChunks: number
  readonly coverage: readonly CoverageRun[]
  readonly ledger: SessionLedger
  readonly entries: readonly SessionEntry[]
  readonly packDeviceKey: DeviceKey | null
  readonly solarDeviceKey: DeviceKey | null
  readonly groupKey: DeviceKey
  readonly deviceInfo: DeviceInfo | null
  readonly settings: BmsSettings | null
  readonly finalBattery: BatterySnapshot | null
  readonly finalSolar: SolarReading | null
}

export interface SessionClosure extends SessionPatch {
  readonly endedAt: number
  readonly endReason: SessionEndReason
}

export interface SessionListing {
  readonly record: SessionRecord

  readonly device: DeviceRecord | null

  readonly label: string
}

export interface StoredSession {
  readonly record: SessionRecord
  readonly packDevice: DeviceRecord | null
  readonly solarDevice: DeviceRecord | null

  readonly pack: readonly PackChunk[]
  readonly solar: readonly SolarChunk[]

  readonly windowClamped: boolean
  readonly hours?: readonly SessionHour[]
}

export const MAX_RENDER_WINDOW_MS = 24 * 60 * 60_000

export interface RenderWindow {
  readonly window: TimeWindow
  readonly clamped: boolean
}

export function renderWindowFor(available: TimeWindow, requested?: TimeWindow): RenderWindow {
  const from = requested === undefined ? available.from : Math.max(available.from, requested.from)
  const requestedTo = requested === undefined ? available.to : Math.min(available.to, requested.to)

  const to = Math.max(from, requestedTo)

  if (to - from <= MAX_RENDER_WINDOW_MS) return { window: { from, to }, clamped: false }
  return { window: { from: to - MAX_RENDER_WINDOW_MS, to }, clamped: true }
}

export interface HistoryStore {
  readonly availability: HistoryAvailability

  openSession(record: SessionRecord): Promise<void>

  commitChunk(chunk: HistoryChunk, patch: SessionPatch, hours?: readonly SessionHour[]): Promise<CommitOutcome>

  compactSession?(id: SessionId): Promise<void>
  closeSession(id: SessionId, closure: SessionClosure): Promise<void>

  deleteSession(id: SessionId): Promise<void>

  appendWarning(record: WarningRecord): Promise<void>

  warningsOf(id: SessionId): Promise<readonly WarningRecord[]>

  listWarnings(limit?: number): Promise<readonly WarningRecord[]>

  warningsInWindow(window: TimeWindow): Promise<readonly WarningRecord[]>

  listSessions(limit?: number): Promise<readonly SessionListing[]>
  listDevices(): Promise<readonly DeviceRecord[]>
  readSession(id: SessionId, window?: TimeWindow): Promise<StoredSession | null>

  streamChunks(
    id: SessionId,
    stream: StreamName,
    window: TimeWindow,
    visit: (chunk: HistoryChunk) => void,
  ): Promise<void>

  upsertDevice(record: DeviceRecord): Promise<DeviceRecord>

  renameDevice(key: DeviceKey, label: string | null): Promise<DeviceRecord | null>

  appendRingSnapshot(snapshot: RingSnapshot): Promise<RingIngestOutcome>

  appendSolarHistory(snapshot: SolarHistorySnapshot): Promise<SolarHistoryIngestOutcome>

  readRingLedger(deviceKey: DeviceKey): Promise<StoredRingLedger | null>

  listRingLedgers(): Promise<readonly RingLedgerSummary[]>

  setPackClock(
    deviceKey: DeviceKey,
    clock: {
      readonly utcOffsetMinutes: number | null
      readonly aheadSeconds: number | null
    },
  ): Promise<DeviceRecord | null>

  deleteRingLedger(deviceKey: DeviceKey): Promise<void>

  recover(now: number): Promise<{ readonly closed: number; readonly orphansRemoved: number }>

  usage(): Promise<{
    readonly totalSamples: number
    readonly sessions: number
    readonly ringRecords: number
    readonly rawBytes?: number
    readonly rawCapacityBytes?: number
  }>

  watch(onChanged: () => void): () => void
  close(): void

  noteViewing?(id: SessionId | null): void
}

export function unavailableHistoryStore(reason: HistoryUnavailableReason): HistoryStore {
  const availability: HistoryAvailability = {
    usable: false,
    reason,
    persisted: null,
    estimatedBytes: null,
    quotaBytes: null,
  }

  return {
    availability,
    openSession: async () => undefined,
    commitChunk: async () => ({
      stored: false,
      totalSamples: 0,
      prunedSessionIds: [],
      truncatedFrom: null,
      failure: reason,
    }),
    closeSession: async () => undefined,
    deleteSession: async () => undefined,
    appendWarning: async () => undefined,
    warningsOf: async () => [],
    listWarnings: async () => [],
    warningsInWindow: async () => [],
    listSessions: async () => [],
    listDevices: async () => [],
    readSession: async () => null,
    streamChunks: async () => undefined,

    upsertDevice: async (record: DeviceRecord) => record,
    renameDevice: async () => null,
    appendRingSnapshot: async () => ({
      stored: false,
      appended: 0,
      overlap: 0,
      ringShift: null,
      gapDeclared: false,
      runsDiscarded: 0,
      totalRecords: 0,
      prunedRecords: 0,
      failure: reason,
    }),
    appendSolarHistory: async () => ({
      stored: false,
      appended: 0,
      revised: 0,
      unchanged: 0,
      unwritten: 0,
      redated: 0,
      totalDays: 0,
      prunedRecords: 0,
      failure: reason,
    }),
    readRingLedger: async () => null,
    listRingLedgers: async () => [],
    setPackClock: async () => null,
    deleteRingLedger: async () => undefined,
    recover: async () => ({ closed: 0, orphansRemoved: 0 }),
    usage: async () => ({ totalSamples: 0, sessions: 0, ringRecords: 0 }),
    watch: () => () => undefined,
    close: () => undefined,
  }
}
