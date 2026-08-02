/**
 * What these tests establish.
 *
 * All that survives in this module is the range plumbing: which instants a preset names, and how
 * wide a bar should be for the span it covers. Every fold moved to `ringRange.ts` when Stats
 * re-sourced onto the pack's own records, so the cases here are about calendar boundaries and
 * nothing else.
 *
 * They matter more than they look. A range boundary that steps by a fixed 24 h instead of by a
 * local day shaves or adds a bucket across a clock change, and the resulting off-by-one day is
 * invisible on screen until someone counts bars.
 */

import { describe, expect, it } from 'vitest'

import {
  bucketUnitFor,
  startOfLocalDay,
  windowFor,
} from '../src/application/history/statsRange'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** A local wall-clock instant, so bucketing is deterministic whatever the runner's timezone. */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month, day, hour, minute, 0).getTime()
}

/** June, so no daylight-saving seam falls inside the week or month under test. */
const NOW = at(2025, 5, 15, 12, 0)

describe('startOfLocalDay', () => {
  it('lands on the local midnight of the day an instant falls in', () => {
    const midnight = startOfLocalDay(at(2025, 5, 15, 14, 30))
    expect(midnight).toBe(at(2025, 5, 15, 0))
    expect(startOfLocalDay(midnight)).toBe(midnight)
  })
})

describe('windowFor', () => {
  it('rolls the day range straight back from now', () => {
    const now = at(2025, 5, 15, 14, 30)
    expect(windowFor('day', now)).toEqual({ from: now - DAY_MS, to: now })
  })

  it('starts a multi-day range at a local midnight so its buckets are whole days', () => {
    const week = windowFor('week', NOW)
    expect(week.to).toBe(NOW)
    // 7 local days including today: today's midnight, minus six whole days.
    expect(week.from).toBe(startOfLocalDay(NOW) - 6 * DAY_MS)
    expect(startOfLocalDay(week.from)).toBe(week.from)

    const month = windowFor('month', NOW)
    expect(month.from).toBe(startOfLocalDay(NOW) - 29 * DAY_MS)
    expect(startOfLocalDay(month.from)).toBe(month.from)
  })
})

describe('windowFor · all and custom', () => {
  it('spans the whole ledger from the oldest held record to now', () => {
    const oldest = at(2025, 3, 2, 9)
    const window = windowFor('all', NOW, { oldest })
    expect(window.to).toBe(NOW)
    expect(window.from).toBe(startOfLocalDay(oldest))
  })

  it('falls back to today when nothing is held', () => {
    const window = windowFor('all', NOW, { oldest: null })
    expect(window.from).toBe(startOfLocalDay(NOW))
    expect(window.to).toBe(NOW)
  })

  it('runs a custom range from the earlier day to the later day whole, whatever the order', () => {
    const early = at(2025, 5, 3, 15)
    const late = at(2025, 5, 9, 6)
    const forward = windowFor('custom', NOW, { custom: { from: early, to: late } })
    const reversed = windowFor('custom', NOW, { custom: { from: late, to: early } })
    expect(forward).toEqual(reversed)
    expect(forward.from).toBe(startOfLocalDay(early))
    // The later day is covered whole — its last instant, not its midnight.
    expect(startOfLocalDay(forward.to)).toBe(startOfLocalDay(late))
    expect(forward.to).toBeGreaterThan(startOfLocalDay(late) + 23 * HOUR_MS)
  })

  it('never lets a custom range run past now', () => {
    const window = windowFor('custom', NOW, { custom: { from: at(2025, 5, 10, 0), to: at(2025, 5, 20, 0) } })
    expect(window.to).toBe(NOW)
  })

  it('covers the day itself when a custom range is asked for without dates', () => {
    const window = windowFor('custom', NOW)
    expect(window).toEqual({ from: startOfLocalDay(NOW), to: NOW })
  })
})

describe('bucketUnitFor', () => {
  it('folds by day up to a month and a half, then week, then month', () => {
    const from = at(2025, 5, 1, 0)
    expect(bucketUnitFor({ from, to: from + 10 * DAY_MS })).toBe('day')
    expect(bucketUnitFor({ from, to: from + 200 * DAY_MS })).toBe('week')
    expect(bucketUnitFor({ from, to: from + 3 * 365 * DAY_MS })).toBe('month')
  })
})
