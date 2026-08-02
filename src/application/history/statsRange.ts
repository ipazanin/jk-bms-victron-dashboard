/**
 * The Stats page's ranges: the window a preset names, and the bucket width a window earns.
 *
 * Nothing here folds data any more. The cards are scoped to the records the devices themselves
 * kept, so the folds live in `ringRange.ts` over the pack's own ring; per-session figures stay in
 * the Log tab, where a session is the subject rather than an approximation of one.
 *
 * `startOfLocalDay` sits here because every range boundary is a local calendar boundary rather than
 * a rolling 24 h: a bucket that starts at a local midnight survives a clock change, and one that
 * starts 86,400,000 ms back does not.
 */

import type { TimeWindow } from '../../domain/history/types'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

// ── range → window ──────────────────────────────────────────────────────────

/**
 * No `hour`. The ring holds at most one record an hour, so an hour preset is empty by construction
 * and reads on screen as a bug rather than as an empty hour. `custom` covers a short span.
 */
export type RangeKind = 'day' | 'week' | 'month' | 'all' | 'custom'

/** What a caller must hand `windowFor` for the two ranges that are not a fixed roll-back from now. */
export interface WindowOptions {
  /** The oldest instant the archive can place, for the 'all' range. Null when nothing is held. */
  readonly oldest?: number | null
  /** The two dates a 'custom' range was set from. Normalised here, so either order is accepted. */
  readonly custom?: TimeWindow
}

/** The local midnight an instant falls after. */
export function startOfLocalDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * The precise instant window a range covers, ending at `now`.
 *
 * The day range rolls straight back from now; multi-day ranges start at a local midnight so their
 * day buckets are whole days. The multi-day start is stepped back by whole local days rather than
 * by a fixed 24 h, so a clock change inside the range does not shave or add a bucket.
 *   day    → [now − 24h, now]
 *   week   → [startOfLocalDay(now) − 6 local days, now]   (7 local days incl. today)
 *   month  → [startOfLocalDay(now) − 29 local days, now]  (30 local days incl. today)
 *   all    → [startOfLocalDay(oldest held record), now]   (the whole ledger; today when empty)
 *   custom → [start of the earlier local day, end of the later local day, clamped to now]
 */
export function windowFor(kind: RangeKind, now: number, options: WindowOptions = {}): TimeWindow {
  switch (kind) {
    case 'day':
      return { from: now - DAY_MS, to: now }
    case 'week':
      return { from: localMidnightDaysBefore(now, 6), to: now }
    case 'month':
      return { from: localMidnightDaysBefore(now, 29), to: now }
    case 'all': {
      const oldest = options.oldest ?? null
      return { from: startOfLocalDay(oldest ?? now), to: now }
    }
    case 'custom': {
      const picked = options.custom
      if (picked === undefined) return { from: startOfLocalDay(now), to: now }
      // Either date order is accepted; the window runs from the earlier day's midnight to the later
      // day's last instant, and never past now — a future 'to' would claim data that cannot exist.
      const from = startOfLocalDay(Math.min(picked.from, picked.to))
      const to = Math.min(now, endOfLocalDay(Math.max(picked.from, picked.to)))
      return { from, to: Math.max(from, to) }
    }
  }
}

// ── window → bucket width ───────────────────────────────────────────────────

/** The bucket a range folds its energy into, chosen so a span shows tens of bars, not hundreds. */
export type BucketUnit = 'day' | 'week' | 'month'

const WEEK_MS = 7 * DAY_MS

/**
 * day up to a month and a half, then week, then month — so a week reads day-by-day, a year
 * week-by-week, and the whole ledger month-by-month, each landing roughly 8–45 bars wide.
 */
export function bucketUnitFor(window: TimeWindow): BucketUnit {
  const span = window.to - window.from
  if (span <= 45 * DAY_MS) return 'day'
  if (span <= 72 * WEEK_MS) return 'week'
  return 'month'
}

export interface EnergyBucket {
  /** Local start of the bucket, in wall-clock milliseconds. */
  readonly start: number
  /** Exclusive local end — the next bucket's start. */
  readonly end: number
  /** Charge into the pack, in watt-hours: its own counter valued at the interval's mean voltage. */
  readonly inWh: number
  /** Charge out of the pack, on the same terms. */
  readonly outWh: number
  /** False for a bucket the ring never covered — drawn as a gap, never a fabricated zero. */
  readonly recorded: boolean
}

// ── internals ───────────────────────────────────────────────────────────────

/** The last instant of an instant's local day, so a custom 'to' covers the whole day it names. */
function endOfLocalDay(at: number): number {
  const date = new Date(at)
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

function localMidnightDaysBefore(now: number, daysBack: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - daysBack)
  return date.getTime()
}
