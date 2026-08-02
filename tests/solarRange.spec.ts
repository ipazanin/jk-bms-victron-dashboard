/**
 * The Stats folds over the controller's own stored history.
 *
 * The ledger under every case is the real capture, folded exactly as the archive would fold it, and
 * the expected numbers come out of VictronConnect's export of the same registers. So a per-day
 * series is checked against the vendor's own reading of that day, day by day, rather than against a
 * number this code produced.
 *
 * What is asserted beyond the arithmetic is the treatment of a day with no record. The series are
 * dense and such a day is `recorded: false` with null figures — a day the controller never wrote is
 * not a day of zero yield, and the capture holds recorded days down to 0.14 kWh to prove the two
 * would be indistinguishable.
 */

import { describe, expect, it } from 'vitest'

import { calendarDateBefore, calendarDatesBetween } from '../src/domain/history/calendarDays'
import { foldSolarHistorySnapshot } from '../src/domain/history/solarLedger'
import {
  hoursAndMinutesOf,
  solarChargeStagesPerDay,
  solarExtremesPerDay,
  solarRangeSummary,
  solarYieldPerDay,
  wattHoursOf,
} from '../src/application/history/solarRange'
import type { SolarDayRow } from '../src/domain/history/SolarDayRow'
import type { SolarDayWindow } from '../src/domain/history/types'
import {
  CAPTURED_DAYS,
  CAPTURE_READ_ON_DATE,
  capturedDayBytes,
  capturedSolarSnapshot,
  dayReading,
  withYield,
} from './support/solarHistoryFixture'
import wire from './fixtures/solarHistoryWire.json'

const FILED_AT = Date.UTC(2026, 7, 2, 9, 15)
const WATT_HOURS_PER_KWH = 1_000
const HUNDREDTHS_PER_KWH = 100

const LEDGER: readonly SolarDayRow[] = foldSolarHistorySnapshot(
  [],
  capturedSolarSnapshot(),
  FILED_AT,
).rows

/** Exactly the days the capture covers: the oldest register through today. */
const WHOLE_BACKLOG: SolarDayWindow = {
  from: calendarDateBefore(CAPTURE_READ_ON_DATE, CAPTURED_DAYS - 1),
  to: CAPTURE_READ_ON_DATE,
}

/** The vendor's rows by the date the vendor printed on them. */
const EXPORTED = new Map(wire.expectedFromVendorExport.map((day) => [day.date, day]))

describe('energy per day', () => {
  it('reports the yield the vendor’s own export reports, day for day', () => {
    const days = solarYieldPerDay(LEDGER, WHOLE_BACKLOG)

    let compared = 0
    for (const day of days) {
      const exported = EXPORTED.get(day.date)
      if (exported === undefined) continue
      expect(day.recorded).toBe(true)
      expect(wattHoursOf(day.yieldKwh ?? 0)).toBeCloseTo(exported.yieldWh, 6)
      compared += 1
    }
    expect(compared).toBe(wire.expectedFromVendorExport.length)
  })

  it('runs dense across the window, oldest first', () => {
    const days = solarYieldPerDay(LEDGER, WHOLE_BACKLOG)

    expect(days.map((day) => day.date)).toEqual(
      calendarDatesBetween(WHOLE_BACKLOG.from, WHOLE_BACKLOG.to),
    )
    expect(days).toHaveLength(CAPTURED_DAYS)
    expect(days.every((day) => day.recorded)).toBe(true)
  })

  it('says a day it has no record for is absent, never zero', () => {
    const before: SolarDayWindow = {
      from: calendarDateBefore(WHOLE_BACKLOG.from, 3),
      to: WHOLE_BACKLOG.from,
    }

    const days = solarYieldPerDay(LEDGER, before)

    expect(days.slice(0, 3).map((day) => day.recorded)).toEqual([false, false, false])
    expect(days.slice(0, 3).map((day) => day.yieldKwh)).toEqual([null, null, null])
    expect(days[3].recorded).toBe(true)
  })

  it('reports the load tally as absent on a controller that keeps none', () => {
    // This boat's 100/50 has no load output, and the register reads 0xFFFFFFFF for it on every
    // captured day. A zero here would read as a day the boat drew nothing.
    const days = solarYieldPerDay(LEDGER, WHOLE_BACKLOG)

    expect(days.every((day) => day.consumedKwh === null)).toBe(true)
  })
})

describe('charge stages per day', () => {
  it('reports the minutes in each stage the vendor’s export reports', () => {
    const days = solarChargeStagesPerDay(LEDGER, WHOLE_BACKLOG)

    for (const day of days) {
      const exported = EXPORTED.get(day.date)
      if (exported === undefined) continue
      expect(day.minutesInBulk).toBe(exported.minutesInBulk)
      expect(day.minutesInAbsorption).toBe(exported.minutesInAbsorption)
      expect(day.minutesInFloat).toBe(exported.minutesInFloat)
    }
  })

  it('states how long the charger was doing anything, rather than leaving it to a subtraction', () => {
    const [day] = solarChargeStagesPerDay(LEDGER, WHOLE_BACKLOG)

    expect(day.minutesCharging).toBe(
      (day.minutesInBulk ?? 0) + (day.minutesInAbsorption ?? 0) + (day.minutesInFloat ?? 0),
    )
    // The three do not fill a day: the charger is in none of them at night.
    expect(day.minutesCharging).toBeLessThan(24 * 60)
  })

  it('carries nothing at all for a day with no record', () => {
    const [missing] = solarChargeStagesPerDay(LEDGER, {
      from: calendarDateBefore(WHOLE_BACKLOG.from, 1),
      to: WHOLE_BACKLOG.from,
    })

    expect(missing.recorded).toBe(false)
    expect(missing.minutesCharging).toBeNull()
  })

  it('reads a stage duration as hours and minutes', () => {
    expect(hoursAndMinutesOf(441)).toEqual({ hours: 7, minutes: 21 })
  })
})

describe('extremes per day', () => {
  it('reports the panel and battery extremes the vendor’s export reports', () => {
    const days = solarExtremesPerDay(LEDGER, WHOLE_BACKLOG)

    for (const day of days) {
      const exported = EXPORTED.get(day.date)
      if (exported === undefined) continue
      expect(day.maxPvPowerW).toBe(exported.maxPvPowerW)
      expect(day.maxPvVoltage).toBeCloseTo(exported.maxPvVoltage, 6)
      expect(day.minBatteryVoltage).toBeCloseTo(exported.minBatteryVoltage, 6)
      expect(day.maxBatteryVoltage).toBeCloseTo(exported.maxBatteryVoltage, 6)
    }
  })

  it('carries nothing at all for a day with no record', () => {
    const [missing] = solarExtremesPerDay(LEDGER, {
      from: calendarDateBefore(WHOLE_BACKLOG.from, 1),
      to: WHOLE_BACKLOG.from,
    })

    expect(missing).toEqual({
      date: calendarDateBefore(WHOLE_BACKLOG.from, 1),
      recorded: false,
      maxPvPowerW: null,
      maxPvVoltage: null,
      maxBatteryVoltage: null,
      minBatteryVoltage: null,
      maxBatteryCurrentA: null,
    })
  })
})

describe('the range summary', () => {
  it('totals only the days on record, and says how many that was', () => {
    const wider: SolarDayWindow = {
      from: calendarDateBefore(WHOLE_BACKLOG.from, 10),
      to: WHOLE_BACKLOG.to,
    }

    const summary = solarRangeSummary(LEDGER, wider)

    expect(summary.days).toBe(CAPTURED_DAYS)
    expect(summary.daysInWindow).toBe(CAPTURED_DAYS + 10)
    const yieldOfRows = LEDGER.reduce((total, row) => total + row.day.yieldKwh, 0)
    expect(summary.yieldKwh).toBeCloseTo(yieldOfRows, 6)
    expect(summary.meanDailyYieldKwh).toBeCloseTo(yieldOfRows / CAPTURED_DAYS, 6)
  })

  it('names the best day on record', () => {
    const summary = solarRangeSummary(LEDGER, WHOLE_BACKLOG)

    const best = [...LEDGER].sort((left, right) => right.day.yieldKwh - left.day.yieldKwh)[0]
    expect(summary.bestDay?.date).toBe(best.date)
    expect(summary.bestDay?.yieldKwh).toBeCloseTo(best.day.yieldKwh, 6)
  })

  it('carries the widest reading on any day in the window', () => {
    const summary = solarRangeSummary(LEDGER, WHOLE_BACKLOG)

    expect(summary.maxPvPowerW).toBe(Math.max(...LEDGER.map((row) => row.day.maxPvPower)))
    expect(summary.minBatteryVoltage).toBeCloseTo(
      Math.min(...LEDGER.map((row) => row.day.minBatteryVoltage)),
      6,
    )
    expect(summary.maxBatteryVoltage).toBeCloseTo(
      Math.max(...LEDGER.map((row) => row.day.maxBatteryVoltage)),
      6,
    )
    expect(summary.minutesInFloat).toBe(
      LEDGER.reduce((total, row) => total + row.day.minutesInFloat, 0),
    )
  })

  it('counts the days the controller logged an error of its own', () => {
    // Two months of captured days on this boat carry 0,0,0,0. A fault-free controller is a real
    // reading and reads as zero here, not as an absence.
    const summary = solarRangeSummary(LEDGER, WHOLE_BACKLOG)

    expect(summary.daysWithError).toBe(0)
  })

  it('has no mean and no best day over a window it holds nothing in', () => {
    const summary = solarRangeSummary(LEDGER, {
      from: calendarDateBefore(WHOLE_BACKLOG.from, 5),
      to: calendarDateBefore(WHOLE_BACKLOG.from, 1),
    })

    expect(summary.days).toBe(0)
    expect(summary.yieldKwh).toBe(0)
    expect(summary.meanDailyYieldKwh).toBeNull()
    expect(summary.bestDay).toBeNull()
    expect(summary.maxPvPowerW).toBeNull()
  })

  it('draws the later reading when two rows claim one date', () => {
    // Two rows can share a date only where a sweep disagreed with a stored row about which day a
    // record belongs to, which the fold reports rather than resolves. A screen still has to draw one.
    const held = LEDGER[LEDGER.length - 1]
    const grown = foldSolarHistorySnapshot(
      [],
      capturedSolarSnapshot({
        days: [dayReading(0, withYield(capturedDayBytes(0), 900))],
      }),
      FILED_AT + 3_600_000,
    ).rows[0]
    const disputed: readonly SolarDayRow[] = [...LEDGER, { ...grown, seq: 99, date: held.date }]

    const summary = solarRangeSummary(disputed, { from: held.date, to: held.date })

    expect(summary.days).toBe(1)
    expect(summary.yieldKwh).toBeCloseTo(900 / HUNDREDTHS_PER_KWH, 6)
    expect(wattHoursOf(summary.yieldKwh)).toBeCloseTo(9_000, 6)
  })
})

describe('reading a figure in the unit a card wants', () => {
  it('states a kilowatt-hour figure in watt-hours', () => {
    expect(wattHoursOf(1.66)).toBeCloseTo(1_660, 6)
    expect(wattHoursOf(LEDGER[0].day.yieldKwh) / WATT_HOURS_PER_KWH).toBeCloseTo(
      LEDGER[0].day.yieldKwh,
      6,
    )
  })
})
