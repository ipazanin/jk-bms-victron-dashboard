import type { RingReadRow } from './RingReadRow'
import type { RingRecordRow } from './RingRecordRow'
import type { SolarDayRow } from './SolarDayRow'
import type { SolarHistoryReadRow } from './SolarHistoryReadRow'
import type { DeviceKey, DeviceRecord } from './types'

/**
 * One device's whole ledger as the archive holds it: the rows, the read journal, and the device row
 * the two owner-set clock fields live on.
 *
 * Whole rather than windowed. Wall time is derived through a correction that can change, so an
 * index over wall time would freeze today's correction into the archive, and one contiguous
 * key-range read folded in memory is what the Stats cards already do with sessions.
 *
 * Both radios keep history of their own and both file it in the same two stores, so the rows arrive
 * already separated by format rather than as one list every caller has to sift. A device key belongs
 * to a pack or to a controller and never to both, so exactly one pair of these lists is ever
 * populated — and separating them at the read is what lets every fold above keep the exact row type
 * it was written against, with no cast and no runtime check of its own.
 */
export interface StoredRingLedger {
  readonly deviceKey: DeviceKey
  /** Ascending by seq — the pack's write order. Never sorted by counter. */
  readonly records: readonly RingRecordRow[]
  /** Ascending by seq, which for a controller's backlog is calendar order. */
  readonly solarDays: readonly SolarDayRow[]
  /** Newest read first, capped at MAX_RING_READS_PER_DEVICE. */
  readonly reads: readonly RingReadRow[]
  /** Newest sweep first, under the same cap and out of the same store. */
  readonly solarReads: readonly SolarHistoryReadRow[]
  /** The device row, for the label and the two owner-set clock fields. Null if never upserted. */
  readonly device: DeviceRecord | null
  /** Set when pruning cut this ledger's head. */
  readonly retainedFromSeq: number | null
}
