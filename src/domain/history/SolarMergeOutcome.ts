/**
 * What folding one history sweep into a ledger did, as far as the fold itself can know.
 *
 * The port's `SolarHistoryIngestOutcome` widens this with the figures only a store can supply. Every
 * reading the sweep carried lands in exactly one of the first four counters, which is what makes a
 * receipt add up: a register that answered and left no row has said which reason applied.
 */
export interface SolarMergeOutcome {
  /** Days the ledger had never seen. */
  readonly appended: number
  /** Days already held whose record has changed — today, still being written. */
  readonly revised: number
  /** Days already held, field for field. A re-read of a settled backlog is all of these. */
  readonly unchanged: number
  /** Registers the controller has not written yet. Never stored: an unwritten day is not a zero. */
  readonly unwritten: number
  /**
   * Days whose stored date disagrees with the one this sweep computed, counted among the revised and
   * unchanged rather than instead of them. The stored date stands; the disagreement is reported.
   */
  readonly redated: number
}
