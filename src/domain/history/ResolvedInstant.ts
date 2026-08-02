import type { ClockBasis } from './ClockBasis'

/**
 * A ring record placed on the real clock, carrying the uncertainty that placed it.
 *
 * The two fields travel together on purpose. A wall time handed over on its own invites a screen
 * that prints a minute it does not have, and the bound is wide enough after one read — half an hour
 * either way — that the difference matters.
 */
export interface ResolvedInstant {
  /** Midpoint of the interval. */
  readonly at: number
  /** Half-width. Zero only under an owner pin, and infinite when nothing anchors the ledger. */
  readonly uncertaintyMs: number
  readonly basis: ClockBasis
}
