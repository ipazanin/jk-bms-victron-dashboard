/**
 * Arithmetic on calendar days.
 *
 * Every step here runs through `Date.UTC`, never through a local constructor. A calendar day has no
 * zone, so stepping one back in a zone that keeps summer time would sometimes move 23 hours and
 * sometimes 25 — and a day counted back from a read would land on the wrong date twice a year, in
 * exactly the boundary case nobody is watching for. In UTC every day is 86,400,000 ms wide and the
 * step is exact.
 *
 * `calendarDateNow` is the one function here that reads the host clock, and it is deliberately the
 * only one: a read happens on a day this browser can name, and everything downstream works from the
 * date that read was stamped with. A fold that reached for the host zone would re-date stored
 * history every time the boat is browsed from another country, which is the failure `browserZone.ts`
 * already documents for the pack's clock.
 */

import type { CalendarDate } from './CalendarDate'

const MILLISECONDS_PER_DAY = 86_400_000

/** `YYYY-MM-DD`, and nothing looser: a two-digit year or a slash is a different notation. */
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

const YEAR_DIGITS = 4
const MONTH_DIGITS = 2
const DAY_DIGITS = 2

/**
 * The widest span this module will enumerate, so a window built from a wrong clock cannot ask for a
 * million rows. Ten years is far beyond any backlog a charger holds, and still bounded.
 */
const MAX_ENUMERATED_DAYS = 3_653

/** The date an instant falls on, read in the host's own zone. Belongs at a read, never in a fold. */
export function calendarDateNow(at: number): CalendarDate {
  const local = new Date(at)
  return formatParts(local.getFullYear(), local.getMonth() + 1, local.getDate())
}

/** The date `days` days before another. A negative count moves forward. */
export function calendarDateBefore(date: CalendarDate, days: number): CalendarDate {
  return calendarDateAt(calendarDateEpoch(date) - days * MILLISECONDS_PER_DAY)
}

/** How many days later `to` is than `from`. Negative when `to` is the earlier of the two. */
export function calendarDaysBetween(from: CalendarDate, to: CalendarDate): number {
  return (calendarDateEpoch(to) - calendarDateEpoch(from)) / MILLISECONDS_PER_DAY
}

/**
 * Every date from `from` to `to` inclusive, oldest first.
 *
 * Dense, because an absent day is a day the controller has no record for, and a series that simply
 * left it out would draw a week of six days. An inverted window enumerates nothing.
 */
export function calendarDatesBetween(
  from: CalendarDate,
  to: CalendarDate,
): readonly CalendarDate[] {
  const span = calendarDaysBetween(from, to)
  if (span < 0) return []

  const dates: CalendarDate[] = []
  const last = Math.min(span, MAX_ENUMERATED_DAYS - 1)
  for (let step = 0; step <= last; step += 1) dates.push(calendarDateBefore(from, -step))
  return dates
}

/**
 * The UTC midnight a date names, which is the scale every step above is taken on.
 *
 * Exported for one purpose: an `Intl.DateTimeFormat` given `timeZone: 'UTC'` turns this back into
 * the day's name in the reader's language. Formatting it in a local zone would print the day before
 * anywhere west of Greenwich, which is the bug this whole module is written in UTC to avoid.
 */
export function calendarDateEpoch(date: CalendarDate): number {
  const parts = CALENDAR_DATE_PATTERN.exec(date)
  if (parts === null) throw new Error(`not a calendar date: ${date}`)
  return Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
}

/** The date a UTC midnight names. Every step above lands on one, so nothing here reads a zone. */
function calendarDateAt(midnight: number): CalendarDate {
  const utc = new Date(midnight)
  return formatParts(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate())
}

function formatParts(year: number, month: number, day: number): CalendarDate {
  return (
    `${String(year).padStart(YEAR_DIGITS, '0')}-` +
    `${String(month).padStart(MONTH_DIGITS, '0')}-` +
    `${String(day).padStart(DAY_DIGITS, '0')}`
  )
}
