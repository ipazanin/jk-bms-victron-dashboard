/**
 * What the read path hands the archive, and when it decides to go and get it.
 *
 * One stored-log read is a window onto the pack's ring, and the archive takes it as the bytes the
 * pack sent rather than as this build's reading of them. Everything here is a pure function over a
 * finished transfer: nothing decodes, nothing stores, and nothing resolves a wall time — which is
 * why the offset the receipt was rendered with cannot reach a stored row.
 */

import type { DetailLogTransfer } from '../../domain/bms/DetailLogTransfer'
import type { RingRecordBytes } from '../../domain/history/RingRecordBytes'
import type { RingRun } from '../../domain/history/RingRun'
import type { RingSnapshot } from '../../domain/history/RingSnapshot'
import type { DeviceKey } from '../../domain/history/types'
import type { StoredRingLedger } from './port'

/**
 * How long a pack's stored log may go unread before a connection fetches it by itself.
 *
 * A day, against a ring that holds about a month: far enough inside the margin that a boat visited
 * weekly loses nothing, and far enough outside the sampling period that a second connection on the
 * same afternoon costs nobody thirty seconds of radio.
 */
export const RING_STALE_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Splits one read's records into the maximal stretches that arrived unbroken.
 *
 * Records are sorted and deduplicated by ring index, last one wins, before anything is split. A
 * burst that repeated a frame inside the window would otherwise produce a run whose bytes sit at
 * the wrong positions, and the fold aligns on position — so a torn snapshot would be filed as real
 * history rather than rejected.
 *
 * A hole in the indices ends a run. The records either side of one are not adjacent in the pack's
 * own history, and the whole merge rests on a run being contiguous.
 */
export function ringRunsOf(rawRecords: readonly RingRecordBytes[]): readonly RingRun[] {
  const byIndex = new Map<number, Uint8Array>()
  for (const record of rawRecords) byIndex.set(record.index, record.bytes)

  const runs: { firstIndex: number; records: Uint8Array[] }[] = []
  const ordered = [...byIndex].sort(([left], [right]) => left - right)
  for (const [index, bytes] of ordered) {
    const open = runs[runs.length - 1]
    if (open !== undefined && index === open.firstIndex + open.records.length) {
      open.records.push(bytes)
      continue
    }
    runs.push({ firstIndex: index, records: [bytes] })
  }
  return runs
}

/**
 * One read as the archive takes it.
 *
 * The transport figures ride along whatever the outcome, because a read that carried no record at
 * all is exactly the one whose journal row is the only evidence it ever happened.
 */
export function ringSnapshotOf(
  transfer: DetailLogTransfer,
  deviceKey: DeviceKey,
  observedAt: number,
): RingSnapshot {
  return {
    deviceKey,
    observedAt,
    outcome: transfer.outcome,
    runs: ringRunsOf(transfer.rawRecords),
    transport: {
      notificationBytes: transfer.notificationBytes,
      notificationCount: transfer.notificationCount,
      assembledFrameCount: transfer.assembledFrameCount,
      logFrameCount: transfer.frames.length,
      elapsedMs: transfer.elapsedMs,
    },
  }
}

/**
 * Whether this browser's copy of a pack's ring has fallen far enough behind to be worth fetching.
 *
 * Measured against the newest read that came back with records, and never against a resolved
 * record time. A successful read always carries the ring's head, so the newest stored record is at
 * most one sampling period older than the read that filed it — which makes the journal's own
 * `observedAt`, a reading of this browser's clock, the same quantity as the record's age without
 * borrowing any of the pack clock's uncertainty to state it.
 *
 * A ledger nothing has ever been filed under, and one whose reads all came back empty, are both
 * due: there is nothing here that the pack has not got.
 */
export function ringReadIsDue(ledger: StoredRingLedger | null, now: number): boolean {
  const answered = ledger?.reads.find((read) => read.outcome === 'records-read')
  if (answered === undefined) return true
  return now - answered.observedAt >= RING_STALE_AFTER_MS
}
