/**
 * How far the pack's clock runs ahead of the real one, bounded rather than stated.
 *
 * A read places the newest scheduled record somewhere inside one sampling period of the moment it
 * was taken, and no closer. Reads land at different phases of that period, so the intersection of
 * two intervals is narrower than either — the bound only ever tightens, and it tightens for free
 * with use.
 */
export interface ClockErrorInterval {
  readonly lowMs: number
  readonly highMs: number
  readonly observations: number
}
