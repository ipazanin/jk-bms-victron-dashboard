import type { DeviceRecord, HistoryChunk, HistoryMeta, SessionRecord, WarningRecord } from '../history/types'
import type { StoredRingRecord } from '../history/StoredRingRecord'
import type { StoredRingRead } from '../history/StoredRingRead'

export interface ArchiveStores {
  readonly sessions: readonly SessionRecord[]
  readonly chunks: readonly HistoryChunk[]
  readonly devices: readonly DeviceRecord[]
  readonly meta: readonly HistoryMeta[]
  readonly warnings: readonly WarningRecord[]
  readonly ringRecords: readonly StoredRingRecord[]
  readonly ringReads: readonly StoredRingRead[]
}
