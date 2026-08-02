/**
 * A stretch of the ledger over which the pack's clock face never moved.
 *
 * Bounded in seq and not in counter. A backward rewrite makes two stretches overlap in counter
 * space, so a counter-keyed segment has to declare records ambiguous that write order places
 * without any ambiguity at all.
 */
export interface RingClockSegment {
  readonly fromSeq: number
  /** Exclusive. Number.MAX_SAFE_INTEGER for the current segment. */
  readonly toSeq: number
  /** Add this to a counter in this segment to bring it onto the CURRENT segment's face. */
  readonly toCurrentFaceSeconds: number
}
