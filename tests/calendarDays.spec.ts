/**
 * Stepping the calendar the archive dates Victron days on.
 *
 * The cases that matter are the boundaries a local-time implementation gets wrong. Stepping a day
 * back across the spring clock change moves 23 hours in a zone that keeps summer time, so a fold
 * counting registers back from a read would land a day out — twice a year, in the one boundary case
 * nobody is watching. Every step here runs in UTC, where a day is always 86,400,000 ms, and these
 * assertions hold whatever zone the machine running them is in.
 */

import { describe, expect, it } from 'vitest'

import {
  calendarDateBefore,
  calendarDateNow,
  calendarDatesBetween,
  calendarDaysBetween,
} from '../src/domain/history/calendarDays'

/** The night the EU advances its clocks in 2026. Nothing below may see it. */
const SPRING_FORWARD = '2026-03-29'

describe('stepping back a day at a time', () => {
  it('crosses a summer-time boundary without gaining or losing a day', () => {
    expect(calendarDateBefore('2026-03-30', 1)).toBe(SPRING_FORWARD)
    expect(calendarDateBefore('2026-03-30', 2)).toBe('2026-03-28')
    expect(calendarDaysBetween('2026-03-28', '2026-03-30')).toBe(2)
  })

  it('crosses the autumn boundary the same way', () => {
    expect(calendarDateBefore('2026-10-26', 1)).toBe('2026-10-25')
    expect(calendarDaysBetween('2026-10-24', '2026-10-26')).toBe(2)
  })

  it('walks off the end of a month, a year and a leap February', () => {
    expect(calendarDateBefore('2026-03-01', 1)).toBe('2026-02-28')
    expect(calendarDateBefore('2024-03-01', 1)).toBe('2024-02-29')
    expect(calendarDateBefore('2026-01-01', 1)).toBe('2025-12-31')
  })

  it('counts forward on a negative step, which is how a register’s age reads', () => {
    expect(calendarDateBefore('2026-08-02', -2)).toBe('2026-08-04')
  })
})

describe('enumerating a window', () => {
  it('is dense and inclusive at both ends, oldest first', () => {
    expect(calendarDatesBetween('2026-03-28', '2026-03-31')).toEqual([
      '2026-03-28',
      SPRING_FORWARD,
      '2026-03-30',
      '2026-03-31',
    ])
  })

  it('is one day for a window of one day, and nothing for an inverted one', () => {
    expect(calendarDatesBetween('2026-08-02', '2026-08-02')).toEqual(['2026-08-02'])
    expect(calendarDatesBetween('2026-08-02', '2026-08-01')).toEqual([])
  })

  it('refuses to enumerate an unbounded span a wrong clock could ask for', () => {
    expect(calendarDatesBetween('1970-01-01', '2999-01-01').length).toBeLessThan(4_000)
  })
})

describe('the day a read happened on', () => {
  it('is the host’s own date, which is where the zone belongs', () => {
    const noon = new Date(2026, 7, 2, 12, 0, 0).getTime()

    expect(calendarDateNow(noon)).toBe('2026-08-02')
  })

  it('rejects a string that is not a date at all rather than stepping from a guess', () => {
    expect(() => calendarDateBefore('02/08/2026', 1)).toThrow(/not a calendar date/)
  })
})
