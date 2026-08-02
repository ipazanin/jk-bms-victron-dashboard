import type { RingReadRow } from './RingReadRow'
import type { RingRecordRow } from './RingRecordRow'
import type { DeviceKey, DeviceRecord } from './types'

/**
 * One pack's whole ring ledger as the archive holds it: the rows, the read journal, and the device
 * row the two owner-set clock fields live on.
 *
 * Whole rather than windowed. Wall time is derived through a correction that can change, so an
 * index over wall time would freeze today's correction into the archive, and one contiguous
 * key-range read folded in memory is what the Stats cards already do with sessions.
 */
export interface StoredRingLedger {
  readonly deviceKey: DeviceKey
  /** Ascending by seq — the pack's write order. Never sorted by counter. */
  readonly records: readonly RingRecordRow[]
  /** Newest read first, capped at MAX_RING_READS_PER_DEVICE. */
  readonly reads: readonly RingReadRow[]
  /** The device row, for the label and the two owner-set clock fields. Null if never upserted. */
  readonly device: DeviceRecord | null
  /** Set when pruning cut this ledger's head. */
  readonly retainedFromSeq: number | null
}
