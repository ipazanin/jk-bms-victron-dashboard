import type { DeviceRecord, HistoryChunk, HistoryMeta, SessionRecord, WarningRecord } from '../history/types'
import type { StoredRingRecord } from '../history/StoredRingRecord'
import type { StoredRingRead } from '../history/StoredRingRead'
import type { SessionHour } from '../history/SessionHour'

export interface ArchiveStores {
  readonly sessions: readonly SessionRecord[]
  readonly chunks: readonly HistoryChunk[]
  readonly hours?: readonly SessionHour[]
  readonly devices: readonly DeviceRecord[]
  readonly meta: readonly HistoryMeta[]
  readonly warnings: readonly WarningRecord[]
  readonly ringRecords: readonly StoredRingRecord[]
  readonly ringReads: readonly StoredRingRead[]
}
