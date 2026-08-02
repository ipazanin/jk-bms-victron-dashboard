/**
 * What folding one read into a ledger did, as far as the fold itself can know.
 *
 * The port's `RingIngestOutcome` widens this with the four figures only a store can supply — that
 * the write happened at all, how many rows the ledger now holds, how many pruning gave up, and the
 * reason when the archive was unusable. Keeping them apart is what lets the fold stay a pure
 * function over bytes with no notion of storage, availability or budget.
 */
export interface RingMergeOutcome {
  readonly appended: number
  /** Records that matched rows the ledger already held. */
  readonly overlap: number
  /** See `RingReadRow.ringShift`. Null when no run aligned. */
  readonly ringShift: number | null
  readonly gapDeclared: boolean
  readonly runsDiscarded: number
}
