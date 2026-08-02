/**
 * How much of each pack's own ring to keep.
 *
 * Ring rows are counted apart from the Log's sample budget, and the two can never evict each other.
 * Folding them together would let a long recording prune away device history to make room — which
 * inverts the very decision that made the pack's records what Stats is scoped to — and would let a
 * ring merge drag the session counter into its transaction.
 *
 * Pruning is per device and trivial, because the ledger is a dense ascending range: over the cap,
 * the lowest seq values go first, down to the target rather than to the cap so the next merge does
 * not fire another prune. The row that survives at the head declares the break, exactly as
 * `retainedFrom` does for a truncated session. Past the device cap the least recently read ledger
 * goes whole; a ledger nobody has read in months is the fairest thing to lose.
 *
 * This module decides; it does not act.
 */

import type { DeviceKey } from './types'

/** ≈2.3 years of hourly records. Bounded, predictable, and it loads into memory in one read. */
export const MAX_RING_RECORDS_PER_DEVICE = 20_000

export const RING_PRUNE_TARGET_RATIO = 0.9

export const MAX_RING_DEVICES = 8

/** The journal is an audit trail, not a series: enough reads to narrow the clock and to show a
 *  pack that stopped answering, and no more. */
export const MAX_RING_READS_PER_DEVICE = 50

export interface RingDeviceExtent {
  readonly deviceKey: DeviceKey
  readonly records: number
  readonly oldestSeq: number
  readonly lastReadAt: number
}

export interface RingEviction {
  readonly deviceKey: DeviceKey
  /** Drop rows below this seq. */
  readonly fromSeq: number
  readonly freedRecords: number
}

export interface RingPrunePlan {
  readonly trim: readonly RingEviction[]
  /** Ledgers dropped whole, least recently read first, past MAX_RING_DEVICES. */
  readonly dropWhole: readonly DeviceKey[]
}

/**
 * Chooses what each ledger gives up, given one extent per device.
 *
 * A ledger going whole is never also trimmed: the two would free the same rows twice and the
 * adapter would carry out a plan whose figures do not add up.
 */
export function planRingPrune(extents: readonly RingDeviceExtent[]): RingPrunePlan {
  const dropWhole = ledgersOverDeviceCap(extents)
  const dropped = new Set<DeviceKey>(dropWhole)
  const target = Math.floor(MAX_RING_RECORDS_PER_DEVICE * RING_PRUNE_TARGET_RATIO)
  const trim: RingEviction[] = []

  for (const extent of extents) {
    if (dropped.has(extent.deviceKey)) continue
    if (extent.records <= MAX_RING_RECORDS_PER_DEVICE) continue

    const freedRecords = extent.records - target
    trim.push({
      deviceKey: extent.deviceKey,
      // seq is dense from oldestSeq, so the survivor's seq is a count away from the oldest.
      fromSeq: extent.oldestSeq + freedRecords,
      freedRecords,
    })
  }

  return { trim, dropWhole }
}

function ledgersOverDeviceCap(extents: readonly RingDeviceExtent[]): readonly DeviceKey[] {
  if (extents.length <= MAX_RING_DEVICES) return []

  return [...extents]
    .sort((left, right) => left.lastReadAt - right.lastReadAt || left.deviceKey.localeCompare(right.deviceKey))
    .slice(0, extents.length - MAX_RING_DEVICES)
    .map((extent) => extent.deviceKey)
}
