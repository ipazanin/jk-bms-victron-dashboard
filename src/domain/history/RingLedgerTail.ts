import type { RingRecordRow } from './RingRecordRow'

/**
 * As much of one ledger's newest end as a merge needs to place a read against it.
 *
 * A tail rather than the whole ledger because alignment only ever succeeds near the head: the ring
 * drops from its own tail, so a read can never reach further back than what the pack still holds.
 * `nextSeq` is carried separately because an empty ledger has no row to read it off, and because a
 * ledger whose head was pruned still hands out seq values above everything it ever stored.
 */
export interface RingLedgerTail {
  readonly nextSeq: number
  /** Up to ALIGNMENT_TAIL_RECORDS newest rows, seq-ascending. */
  readonly rows: readonly RingRecordRow[]
}
