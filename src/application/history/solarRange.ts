/**
 * The Stats page's ranges, folded from the controller's own stored history.
 *
 * The counterpart to `ringRange.ts`, and shorter than it for one reason: the controller has already
 * done the folding. It integrates its own yield over each day, times its own charge stages to the
 * minute, and keeps its own extremes — so nothing here differences two readings, refuses a step it
 * cannot attribute, or values energy at an estimated voltage. Every figure below is either a number
 * the controller wrote or a sum of such numbers.
 *
 * Nothing here resolves a wall time either, and that is the deeper difference. A pack record is an
 * instant on a clock face this browser can only bound, which is why the ring's folds carry a clock
 * context through every function. A Victron record is a calendar day: it was already placed, at the
 * sweep that filed it, using nothing but the date that sweep ran on. So these folds take a window of
 * days and compare dates as dates, and there is no zone, no offset and no correction anywhere in
 * them.
 *
 * The per-day series are DENSE across the window, with `recorded` false on a day the ledger has no
 * row for. A day the controller never wrote is not a day of zero yield — a boat under cover produces
 * recorded days of 0.14 kWh, and a fabricated zero would read exactly like one.
 */

import { calendarDatesBetween } from '../../domain/history/calendarDays'
import { higherOf, lowerOf } from '../../domain/history/geometry'
import type { CalendarDate } from '../../domain/history/CalendarDate'
import type { RecordedSolarHistoryDay } from '../../domain/solar/RecordedSolarHistoryDay'
import type { SolarDayRow } from '../../domain/history/SolarDayRow'
import type { SolarDayWindow } from '../../domain/history/types'

const MINUTES_PER_HOUR = 60
const WATT_HOURS_PER_KWH = 1_000

/** One day's energy. `recorded` false means the ledger holds no row for that date at all. */
export interface SolarYieldDay {
  readonly date: CalendarDate
  readonly recorded: boolean
  /** Null on a day with no row. Never zero — zero is a reading the controller took. */
  readonly yieldKwh: number | null
  /** The load output's own tally, null on a controller without one. This boat's 100/50 has none. */
  readonly consumedKwh: number | null
}

/**
 * One day's charge stages, in the minutes the controller counts them in.
 *
 * The three do not have to add up to a day: the charger is in none of them at night, and their sum
 * is the time it spent charging at all — which is why it is stated rather than left to be inferred
 * from a subtraction the reader would have to know is wrong.
 */
export interface SolarChargeStagesDay {
  readonly date: CalendarDate
  readonly recorded: boolean
  readonly minutesInBulk: number | null
  readonly minutesInAbsorption: number | null
  readonly minutesInFloat: number | null
  /** The three summed: how long the charger was doing anything that day. */
  readonly minutesCharging: number | null
}

/** One day's peaks and troughs, exactly as the controller kept them. */
export interface SolarExtremesDay {
  readonly date: CalendarDate
  readonly recorded: boolean
  readonly maxPvPowerW: number | null
  readonly maxPvVoltage: number | null
  readonly maxBatteryVoltage: number | null
  readonly minBatteryVoltage: number | null
  readonly maxBatteryCurrentA: number | null
}

/**
 * A range's headline figures, every one of them the controller's own.
 *
 * `days` counts the days on record inside the window and `daysInWindow` counts the days the window
 * spans, and the pair is the honest statement: a month's yield off eleven recorded days is a
 * different number from a month's yield off thirty, and one figure cannot say which it is.
 */
export interface SolarRangeSummary {
  readonly window: SolarDayWindow
  readonly daysInWindow: number
  readonly days: number
  readonly yieldKwh: number
  /** Null when no day landed. A mean over nothing is not zero. */
  readonly meanDailyYieldKwh: number | null
  readonly bestDay: SolarYieldDay | null
  readonly minutesInBulk: number
  readonly minutesInAbsorption: number
  readonly minutesInFloat: number
  readonly maxPvPowerW: number | null
  readonly maxPvVoltage: number | null
  readonly maxBatteryVoltage: number | null
  readonly minBatteryVoltage: number | null
  readonly maxBatteryCurrentA: number | null
  /** Days on which the controller logged a charger error. Its own error history, not ours. */
  readonly daysWithError: number
}

/** Energy per day, dense across the window, oldest first. */
export function solarYieldPerDay(
  rows: readonly SolarDayRow[],
  window: SolarDayWindow,
): readonly SolarYieldDay[] {
  const byDate = daysByDate(rows)
  return calendarDatesBetween(window.from, window.to).map((date) => yieldDayOf(date, byDate.get(date)))
}

/** Charge-stage minutes per day, dense across the window, oldest first. */
export function solarChargeStagesPerDay(
  rows: readonly SolarDayRow[],
  window: SolarDayWindow,
): readonly SolarChargeStagesDay[] {
  const byDate = daysByDate(rows)

  return calendarDatesBetween(window.from, window.to).map((date) => {
    const day = byDate.get(date)
    if (day === undefined) {
      return {
        date,
        recorded: false,
        minutesInBulk: null,
        minutesInAbsorption: null,
        minutesInFloat: null,
        minutesCharging: null,
      }
    }
    return {
      date,
      recorded: true,
      minutesInBulk: day.minutesInBulk,
      minutesInAbsorption: day.minutesInAbsorption,
      minutesInFloat: day.minutesInFloat,
      minutesCharging: day.minutesInBulk + day.minutesInAbsorption + day.minutesInFloat,
    }
  })
}

/** Panel and battery extremes per day, dense across the window, oldest first. */
export function solarExtremesPerDay(
  rows: readonly SolarDayRow[],
  window: SolarDayWindow,
): readonly SolarExtremesDay[] {
  const byDate = daysByDate(rows)

  return calendarDatesBetween(window.from, window.to).map((date) => {
    const day = byDate.get(date)
    if (day === undefined) {
      return {
        date,
        recorded: false,
        maxPvPowerW: null,
        maxPvVoltage: null,
        maxBatteryVoltage: null,
        minBatteryVoltage: null,
        maxBatteryCurrentA: null,
      }
    }
    return {
      date,
      recorded: true,
      maxPvPowerW: day.maxPvPower,
      maxPvVoltage: day.maxPvVoltage,
      maxBatteryVoltage: day.maxBatteryVoltage,
      minBatteryVoltage: day.minBatteryVoltage,
      maxBatteryCurrentA: day.maxBatteryCurrent,
    }
  })
}

/**
 * The range's totals.
 *
 * Sums run over the recorded days only, and the extremes over the same set, so a window with a hole
 * in it reports what was actually recorded rather than a total padded with zeroes. `days` says how
 * many that was.
 */
export function solarRangeSummary(
  rows: readonly SolarDayRow[],
  window: SolarDayWindow,
): SolarRangeSummary {
  const dates = calendarDatesBetween(window.from, window.to)
  const byDate = daysByDate(rows)

  let days = 0
  let yieldKwh = 0
  let minutesInBulk = 0
  let minutesInAbsorption = 0
  let minutesInFloat = 0
  let maxPvPowerW: number | null = null
  let maxPvVoltage: number | null = null
  let maxBatteryVoltage: number | null = null
  let minBatteryVoltage: number | null = null
  let maxBatteryCurrentA: number | null = null
  let daysWithError = 0
  let bestDate: CalendarDate | null = null
  let bestYieldKwh = Number.NEGATIVE_INFINITY

  for (const date of dates) {
    const day = byDate.get(date)
    if (day === undefined) continue

    days += 1
    yieldKwh += day.yieldKwh
    minutesInBulk += day.minutesInBulk
    minutesInAbsorption += day.minutesInAbsorption
    minutesInFloat += day.minutesInFloat
    maxPvPowerW = higherOf(maxPvPowerW, day.maxPvPower)
    maxPvVoltage = higherOf(maxPvVoltage, day.maxPvVoltage)
    maxBatteryVoltage = higherOf(maxBatteryVoltage, day.maxBatteryVoltage)
    minBatteryVoltage = lowerOf(minBatteryVoltage, day.minBatteryVoltage)
    maxBatteryCurrentA = higherOf(maxBatteryCurrentA, day.maxBatteryCurrent)
    if (loggedAnError(day)) daysWithError += 1
    // Ties go to the earlier day, so the same ledger always names the same best day.
    if (day.yieldKwh > bestYieldKwh) {
      bestYieldKwh = day.yieldKwh
      bestDate = date
    }
  }

  return {
    window,
    daysInWindow: dates.length,
    days,
    yieldKwh,
    meanDailyYieldKwh: days === 0 ? null : yieldKwh / days,
    bestDay: bestDate === null ? null : yieldDayOf(bestDate, byDate.get(bestDate)),
    minutesInBulk,
    minutesInAbsorption,
    minutesInFloat,
    maxPvPowerW,
    maxPvVoltage,
    maxBatteryVoltage,
    minBatteryVoltage,
    maxBatteryCurrentA,
    daysWithError,
  }
}

/** Watt-hours, for a card that reads in watt-hours. The register counts hundredths of a kWh. */
export function wattHoursOf(kilowattHours: number): number {
  return kilowattHours * WATT_HOURS_PER_KWH
}

/** Whole hours and minutes, for a stage duration the controller counts in minutes. */
export function hoursAndMinutesOf(minutes: number): {
  readonly hours: number
  readonly minutes: number
} {
  return { hours: Math.floor(minutes / MINUTES_PER_HOUR), minutes: minutes % MINUTES_PER_HOUR }
}

// ── internals ───────────────────────────────────────────────────────────────

/**
 * The ledger's records by date.
 *
 * Two rows can share a date only where a sweep disagreed with a stored row about which day a record
 * belongs to — which the fold counts as a redating and reports rather than resolving. The later
 * reading wins here, because a screen has to draw one of them and the newer one is the one the
 * controller most recently stood behind.
 */
function daysByDate(rows: readonly SolarDayRow[]): ReadonlyMap<CalendarDate, RecordedSolarHistoryDay> {
  const byDate = new Map<CalendarDate, SolarDayRow>()
  for (const row of rows) {
    const held = byDate.get(row.date)
    if (held === undefined || row.revisedAt >= held.revisedAt) byDate.set(row.date, row)
  }

  const days = new Map<CalendarDate, RecordedSolarHistoryDay>()
  for (const [date, row] of byDate) days.set(date, row.day)
  return days
}

function yieldDayOf(date: CalendarDate, day: RecordedSolarHistoryDay | undefined): SolarYieldDay {
  if (day === undefined) return { date, recorded: false, yieldKwh: null, consumedKwh: null }
  return { date, recorded: true, yieldKwh: day.yieldKwh, consumedKwh: day.consumedKwh }
}

/** The controller's own error history for the day: the database code, or any of the four codes. */
function loggedAnError(day: RecordedSolarHistoryDay): boolean {
  return day.errorDatabase !== 0 || day.errors.some((code) => code !== 0)
}
