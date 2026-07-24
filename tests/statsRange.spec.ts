import { describe, expect, it } from 'vitest'

import { startOfLocalDay } from '../src/application/history/daily'
import {
  POWER_COLUMNS,
  bucketUnitFor,
  chartFor,
  chartForWindow,
  dailyBucketsIn,
  energyInOut,
  errorsPerDay,
  powerOf,
  powerTracks,
  summarize,
  windowFor,
} from '../src/application/history/statsRange'
import type { PairedSample } from '../src/domain/history/join'
import { MAX_SAMPLE_GAP_MS } from '../src/domain/history/join'
import { EMPTY_LEDGER } from '../src/domain/history/ledger'
import type { PackSample, SessionLedger, SolarSample } from '../src/domain/history/types'
import {
  SAMPLE_EPOCH,
  battery,
  packSample,
  sessionRecord,
  solarSample,
  warningRecord,
} from './support/samples'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** A local wall-clock instant, so bucketing is deterministic whatever the runner's timezone. */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month, day, hour, minute, 0).getTime()
}

function ledger(overrides: Partial<SessionLedger>): SessionLedger {
  return { ...EMPTY_LEDGER, ...overrides }
}

/** June, so no daylight-saving seam falls inside the week or month under test. */
const NOW = at(2025, 5, 15, 12, 0)

describe('windowFor', () => {
  it('rolls a sub-day range straight back from now', () => {
    const now = at(2025, 5, 15, 14, 30)
    expect(windowFor('hour', now)).toEqual({ from: now - HOUR_MS, to: now })
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

describe('chartFor', () => {
  it('routes short ranges to the power chart and long ones to bars', () => {
    expect(chartFor('hour')).toBe('power')
    expect(chartFor('day')).toBe('power')
    expect(chartFor('week')).toBe('bars')
    expect(chartFor('month')).toBe('bars')
  })
})

describe('windowFor · all and custom', () => {
  it('spans the whole archive from the oldest recording to now', () => {
    const oldest = at(2025, 3, 2, 9)
    const window = windowFor('all', NOW, { oldest })
    expect(window.to).toBe(NOW)
    expect(window.from).toBe(startOfLocalDay(oldest))
  })

  it('falls back to today when nothing is recorded', () => {
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
})

describe('bucketUnitFor', () => {
  it('folds by day up to a month and a half, then week, then month', () => {
    const from = at(2025, 5, 1, 0)
    expect(bucketUnitFor({ from, to: from + 10 * DAY_MS })).toBe('day')
    expect(bucketUnitFor({ from, to: from + 200 * DAY_MS })).toBe('week')
    expect(bucketUnitFor({ from, to: from + 3 * 365 * DAY_MS })).toBe('month')
  })
})

describe('chartForWindow', () => {
  it('reads a window up to a day and a half per sample, a longer one as bars', () => {
    const from = at(2025, 5, 10, 0)
    expect(chartForWindow({ from, to: from + HOUR_MS })).toBe('power')
    expect(chartForWindow({ from, to: from + 30 * HOUR_MS })).toBe('power')
    expect(chartForWindow({ from, to: from + 3 * DAY_MS })).toBe('bars')
  })
})

describe('energyInOut', () => {
  it('pairs solar in against house out per day, valuing solar at the session voltage', () => {
    const records = [
      sessionRecord({ id: 'd1', startedAt: at(2025, 5, 10, 9), ledger: ledger({ solarAh: 10, houseWh: 400 }), finalBattery: battery({ packVoltage: 13 }) }),
      sessionRecord({ id: 'd1b', startedAt: at(2025, 5, 10, 15), ledger: ledger({ solarAh: 4, houseWh: 120 }), finalBattery: battery({ packVoltage: 13 }) }),
      sessionRecord({ id: 'd3', startedAt: at(2025, 5, 12, 9), ledger: ledger({ solarAh: 6, houseWh: 300 }), finalBattery: battery({ packVoltage: 12 }) }),
    ]
    const window = { from: startOfLocalDay(at(2025, 5, 10, 0)), to: at(2025, 5, 12, 23) }
    const buckets = energyInOut(records, window, 'day')

    // Dense: 10, 11, 12 June — three day buckets, oldest first, on their midnights.
    expect(buckets.map((bucket) => bucket.start)).toEqual([
      startOfLocalDay(at(2025, 5, 10, 0)),
      startOfLocalDay(at(2025, 5, 11, 0)),
      startOfLocalDay(at(2025, 5, 12, 0)),
    ])
    // 10 June folds two sessions: solar (10 + 4) Ah at 13 V, house 400 + 120 Wh.
    expect(buckets[0].inWh).toBeCloseTo(14 * 13)
    expect(buckets[0].outWh).toBe(520)
    expect(buckets[0].recorded).toBe(true)
    // 11 June saw no session — a gap, never a fabricated zero.
    expect(buckets[1].recorded).toBe(false)
    expect(buckets[1].inWh).toBe(0)
    // 12 June valued at its own 12 V.
    expect(buckets[2].inWh).toBeCloseTo(6 * 12)
    expect(buckets[2].outWh).toBe(300)
  })

  it('falls back to a sibling session voltage for a session that kept none', () => {
    const records = [
      sessionRecord({ id: 'known', startedAt: at(2025, 5, 10, 9), ledger: ledger({ solarAh: 2 }), finalBattery: battery({ packVoltage: 26 }) }),
      sessionRecord({ id: 'novolt', startedAt: at(2025, 5, 11, 9), ledger: ledger({ solarAh: 5 }), finalBattery: null }),
    ]
    const window = { from: startOfLocalDay(at(2025, 5, 10, 0)), to: at(2025, 5, 11, 23) }
    const buckets = energyInOut(records, window, 'day')
    // The volt-less session borrows the archive's real 26 V rather than a hardcoded default.
    expect(buckets[1].inWh).toBeCloseTo(5 * 26)
  })
})

describe('dailyBucketsIn', () => {
  it('keeps only in-window days, oldest first, and leaves an unrecorded day sparse', () => {
    const records = [
      sessionRecord({ id: 'a1', startedAt: at(2025, 5, 10, 8), ledger: ledger({ solarAh: 10 }) }),
      sessionRecord({ id: 'a2', startedAt: at(2025, 5, 10, 20), ledger: ledger({ solarAh: 6 }) }),
      // Nothing recorded on June 11 — it must not appear as a fabricated zero.
      sessionRecord({ id: 'c1', startedAt: at(2025, 5, 12, 9), ledger: ledger({ solarAh: 8 }) }),
    ]

    const buckets = dailyBucketsIn(records, windowFor('week', NOW), NOW)

    expect(buckets.map((bucket) => bucket.day)).toEqual([
      startOfLocalDay(at(2025, 5, 10, 0)),
      startOfLocalDay(at(2025, 5, 12, 0)),
    ])
    expect(buckets[0].sessions).toBe(2)
    expect(buckets[0].solarAh).toBe(16)
  })

  it('drops a day whose midnight falls before the window', () => {
    const records = [
      sessionRecord({ id: 'old', startedAt: at(2025, 5, 1, 8), ledger: ledger({ solarAh: 99 }) }),
      sessionRecord({ id: 'in', startedAt: at(2025, 5, 14, 8), ledger: ledger({ solarAh: 5 }) }),
    ]

    const buckets = dailyBucketsIn(records, windowFor('week', NOW), NOW)

    expect(buckets.map((bucket) => bucket.day)).toEqual([startOfLocalDay(at(2025, 5, 14, 0))])
  })

  it("keeps today's bucket for an hour range mid-afternoon", () => {
    // The window rolls back one hour from mid-afternoon, so its `from` sits well after today's
    // local midnight. Matching the bucket against the days the window touches — not the raw
    // instants — keeps today's session rather than dropping it between midnight and `from`.
    const now = at(2025, 5, 15, 14, 30)
    const records = [
      sessionRecord({ id: 'today', startedAt: at(2025, 5, 15, 9), ledger: ledger({ solarAh: 7 }) }),
    ]

    const buckets = dailyBucketsIn(records, windowFor('hour', now), now)

    expect(buckets.map((bucket) => bucket.day)).toEqual([startOfLocalDay(at(2025, 5, 15, 0))])
    expect(buckets[0].solarAh).toBe(7)
  })
})

describe('summarize', () => {
  it('folds the buckets and tallies warnings inside the window', () => {
    const window = windowFor('week', NOW)
    const records = [
      sessionRecord({
        id: 'a1',
        startedAt: at(2025, 5, 10, 8),
        ledger: ledger({ solarAh: 10, houseWh: 100, packAh: 5, foreignAhFloor: 1, stateOfChargeMin: 80, pvPowerPeakW: 150 }),
      }),
      sessionRecord({
        id: 'a2',
        startedAt: at(2025, 5, 10, 20),
        ledger: ledger({ solarAh: 4, houseWh: 40, packAh: -2, stateOfChargeMin: 65, pvPowerPeakW: 90 }),
      }),
      sessionRecord({
        id: 'c1',
        startedAt: at(2025, 5, 12, 9),
        ledger: ledger({ solarAh: 8, houseWh: 60, packAh: 3, stateOfChargeMin: 72, pvPowerPeakW: 200 }),
      }),
    ]
    const warnings = [
      warningRecord({ sessionId: 'a1', seq: 0, at: at(2025, 5, 10, 9), level: 'warning' }),
      warningRecord({ sessionId: 'a1', seq: 1, at: at(2025, 5, 10, 10), level: 'critical' }),
      warningRecord({ sessionId: 'c1', seq: 0, at: at(2025, 5, 12, 10), level: 'serious' }),
      // Outside the window — must not be tallied.
      warningRecord({ sessionId: 'old', seq: 0, at: at(2025, 5, 1, 10), level: 'critical' }),
    ]

    const summary = summarize(dailyBucketsIn(records, window, NOW), warnings, window)

    expect(summary.window).toBe(window)
    expect(summary.days).toBe(2)
    expect(summary.sessions).toBe(3)
    expect(summary.solarAh).toBe(22)
    expect(summary.houseWh).toBe(200)
    expect(summary.packAh).toBe(6)
    expect(summary.foreignAhFloor).toBe(1)
    expect(summary.deepestSoc).toBe(65)
    expect(summary.pvPeakW).toBe(200)
    expect(summary.errors).toEqual({ warning: 1, serious: 1, critical: 1, total: 3 })
  })

  it('reports zeros and nulls for a range with no buckets', () => {
    const summary = summarize([], [], windowFor('week', NOW))

    expect(summary.days).toBe(0)
    expect(summary.sessions).toBe(0)
    expect(summary.solarAh).toBe(0)
    expect(summary.packAh).toBe(0)
    expect(summary.deepestSoc).toBeNull()
    expect(summary.pvPeakW).toBeNull()
    expect(summary.errors).toEqual({ warning: 0, serious: 0, critical: 0, total: 0 })
  })
})

describe('errorsPerDay', () => {
  it('emits one row per local day the window touches, oldest first, zeros included', () => {
    const days = errorsPerDay([], windowFor('week', NOW))

    expect(days).toHaveLength(7)
    expect(days[0].day).toBe(startOfLocalDay(at(2025, 5, 9, 0)))
    expect(days[6].day).toBe(startOfLocalDay(at(2025, 5, 15, 0)))
    expect(days.every((day) => day.total === 0 && day.worst === null)).toBe(true)
  })

  it('tallies a warning under its own local day and accents the day by its worst', () => {
    const warnings = [
      warningRecord({ seq: 0, at: at(2025, 5, 10, 9), level: 'warning' }),
      warningRecord({ seq: 1, at: at(2025, 5, 10, 15), level: 'critical' }),
      warningRecord({ seq: 2, at: at(2025, 5, 13, 8), level: 'serious' }),
    ]

    const days = errorsPerDay(warnings, windowFor('week', NOW))

    expect(day(days, at(2025, 5, 10, 0))).toMatchObject({
      warning: 1,
      serious: 0,
      critical: 1,
      total: 2,
      worst: 'critical',
    })
    expect(day(days, at(2025, 5, 13, 0))).toMatchObject({ serious: 1, total: 1, worst: 'serious' })
    expect(day(days, at(2025, 5, 11, 0)).total).toBe(0)
  })

  it('splits warnings across a midnight boundary into different days', () => {
    const days = errorsPerDay(
      [
        warningRecord({ seq: 0, at: at(2025, 5, 12, 23, 59), level: 'warning' }),
        warningRecord({ seq: 1, at: at(2025, 5, 13, 0, 1), level: 'warning' }),
      ],
      windowFor('week', NOW),
    )

    expect(day(days, at(2025, 5, 12, 0)).warning).toBe(1)
    expect(day(days, at(2025, 5, 13, 0)).warning).toBe(1)
  })

  it('ignores a warning outside the window', () => {
    const days = errorsPerDay(
      [warningRecord({ at: at(2025, 5, 1, 10), level: 'critical' })],
      windowFor('week', NOW),
    )

    expect(days.every((row) => row.total === 0)).toBe(true)
  })

  it('degrades a day range to the one or two calendar days it touches', () => {
    const now = at(2025, 5, 15, 14, 30)

    const days = errorsPerDay([], windowFor('day', now))

    expect(days.map((row) => row.day)).toEqual([
      startOfLocalDay(at(2025, 5, 14, 0)),
      startOfLocalDay(at(2025, 5, 15, 0)),
    ])
  })
})

describe('powerOf', () => {
  it('multiplies signed pack current by pack voltage and reads pv straight through', () => {
    const point = powerOf(
      paired(
        packSample({ currentA: -8, packVoltageV: 12.5 }),
        solarSample({ batteryCurrentA: 12, pvPowerW: 168 }),
      ),
    )

    expect(point.packW).toBe(-100)
    expect(point.pvW).toBe(168)
    expect(point.houseW).toBe((12 - -8) * 12.5)
  })

  it('withholds house where solar − pack is negative, mirroring the ledger', () => {
    const point = powerOf(
      paired(
        packSample({ currentA: 30, packVoltageV: 12.5 }),
        solarSample({ batteryCurrentA: 5, pvPowerW: 100 }),
      ),
    )

    expect(point.packW).toBe(375)
    expect(point.pvW).toBe(100)
    expect(point.houseW).toBeNull()
  })

  it('nulls a field whose reading is absent', () => {
    const packOnly = powerOf(paired(packSample(), null))
    expect(packOnly.pvW).toBeNull()
    expect(packOnly.houseW).toBeNull()

    const solarOnly = powerOf(paired(null, solarSample({ pvPowerW: 168 })))
    expect(solarOnly.packW).toBeNull()
    expect(solarOnly.houseW).toBeNull()

    const noPv = powerOf(paired(packSample(), solarSample({ pvPowerW: null })))
    expect(noPv.pvW).toBeNull()
  })
})

describe('powerTracks', () => {
  it('exposes a column budget that bounds the trace', () => {
    expect(POWER_COLUMNS).toBe(480)
  })

  it('fills every column of a continuous session and reports no gaps', () => {
    const window = { from: SAMPLE_EPOCH, to: SAMPLE_EPOCH + 100_000 }
    const offsets = every(0, 100_000, 1_000)
    const tracks = powerTracks([{ pack: packRun(offsets), solar: solarRun(offsets) }], window, 10)

    expect(tracks.columnMs).toBe(10_000)
    expect(tracks.gaps).toEqual([])
    expect(tracks.empty).toBe(false)
    expect(tracks.magnitudeW).toBeGreaterThan(0)
    expect(tracks.pack.every((value) => value !== null)).toBe(true)
    expect(tracks.pv.every((value) => value !== null)).toBe(true)
    expect(tracks.house.every((value) => value !== null)).toBe(true)
  })

  it('breaks the trace across a stall longer than the gap bound', () => {
    const window = { from: SAMPLE_EPOCH, to: SAMPLE_EPOCH + 100_000 }
    // Dense to 20 s, silent through 40 s, then resumes — a 20 s hole, well past the 8 s bound.
    const offsets = [...every(0, 20_000, 1_000), ...every(40_000, 60_000, 1_000)]
    const tracks = powerTracks([{ pack: packRun(offsets), solar: solarRun(offsets) }], window, 10)

    expect(20_000).toBeGreaterThan(MAX_SAMPLE_GAP_MS)
    expect(tracks.gaps).toContainEqual({ from: SAMPLE_EPOCH + 20_000, to: SAMPLE_EPOCH + 40_000 })
    // Column centres 25 s and 35 s land in the hole.
    expect(tracks.pack[2]).toBeNull()
    expect(tracks.pack[3]).toBeNull()
    // Centres 5 s and 45 s carry data.
    expect(tracks.pack[0]).not.toBeNull()
    expect(tracks.pack[4]).not.toBeNull()
  })

  it('always breaks between two sessions, even when their stamps nearly touch', () => {
    const window = { from: SAMPLE_EPOCH, to: SAMPLE_EPOCH + 100_000 }
    const first = every(0, 20_000, 1_000)
    // The next recording starts 2 s later — inside the gap bound, but a stop and a start.
    const second = every(22_000, 40_000, 1_000)
    const tracks = powerTracks(
      [
        { pack: packRun(first), solar: solarRun(first) },
        { pack: packRun(second), solar: solarRun(second) },
      ],
      window,
      10,
    )

    expect(2_000).toBeLessThan(MAX_SAMPLE_GAP_MS)
    expect(tracks.gaps).toContainEqual({ from: SAMPLE_EPOCH + 20_000, to: SAMPLE_EPOCH + 22_000 })
  })

  it('nulls a day-range column at a session boundary narrower than one column', () => {
    // A day's columns are ~3 min wide, so a 60 s inter-session gap is narrower than a column and
    // its centre may miss the hole entirely. Nulling on span overlap guarantees the break shows.
    const window = { from: SAMPLE_EPOCH, to: SAMPLE_EPOCH + DAY_MS }
    const first = every(0, 600_000, 1_000)
    const second = every(660_000, 1_200_000, 1_000)
    const tracks = powerTracks(
      [
        { pack: packRun(first), solar: solarRun(first) },
        { pack: packRun(second), solar: solarRun(second) },
      ],
      window,
      POWER_COLUMNS,
    )

    expect(60_000).toBeLessThan(tracks.columnMs)
    expect(tracks.gaps).toContainEqual({ from: SAMPLE_EPOCH + 600_000, to: SAMPLE_EPOCH + 660_000 })

    const boundaryColumn = Math.floor(600_000 / tracks.columnMs)
    expect(tracks.pack[boundaryColumn]).toBeNull()
    // The break is genuine: the columns on either side of the boundary still carry the two sessions.
    expect(tracks.pack[boundaryColumn - 1]).not.toBeNull()
    expect(tracks.pack[boundaryColumn + 1]).not.toBeNull()
  })

  it('renders a short session sitting inside a wide window, unbroken by the window edges', () => {
    // A day-wide window holding a single ~3-minute recording two hours in. The leading and trailing
    // edges to the window bounds are gaps, but nulling on them would erase the very columns that
    // hold the samples — so they draw a break band without consuming the data.
    const window = { from: SAMPLE_EPOCH, to: SAMPLE_EPOCH + DAY_MS }
    const start = 2 * HOUR_MS
    const offsets = every(start, start + 180_000, 1_000)
    const tracks = powerTracks([{ pack: packRun(offsets), solar: solarRun(offsets) }], window, POWER_COLUMNS)

    expect(tracks.empty).toBe(false)
    expect(tracks.pack.some((value) => value !== null)).toBe(true)
    // The edges are still reported (as break bands), but the data column survives them.
    expect(tracks.gaps.length).toBeGreaterThan(0)
    expect(tracks.pack[Math.floor(start / tracks.columnMs)]).not.toBeNull()
  })

  it('withholds house across a foreign-charge session but keeps pack and pv', () => {
    const window = { from: SAMPLE_EPOCH, to: SAMPLE_EPOCH + 20_000 }
    const offsets = every(0, 20_000, 1_000)
    const tracks = powerTracks(
      [
        {
          pack: packRun(offsets, { currentA: 30, packVoltageV: 12.5 }),
          solar: solarRun(offsets, { batteryCurrentA: 5, pvPowerW: 100 }),
        },
      ],
      window,
      10,
    )

    expect(tracks.house.every((value) => value === null)).toBe(true)
    expect(tracks.pack.some((value) => value !== null)).toBe(true)
    expect(tracks.pv.some((value) => value !== null)).toBe(true)
    expect(tracks.empty).toBe(false)
  })

  it('is empty, all-null, and one whole-window gap when nothing overlaps', () => {
    const window = { from: SAMPLE_EPOCH, to: SAMPLE_EPOCH + 100_000 }
    const tracks = powerTracks([], window, 10)

    expect(tracks.empty).toBe(true)
    expect(tracks.magnitudeW).toBe(0)
    expect(tracks.pack.every((value) => value === null)).toBe(true)
    expect(tracks.gaps).toEqual([{ from: SAMPLE_EPOCH, to: SAMPLE_EPOCH + 100_000 }])
  })
})

function paired(pack: PackSample | null, solar: SolarSample | null): PairedSample {
  return { at: 0, pack, solar }
}

function day<Row extends { readonly day: number }>(days: readonly Row[], midnight: number): Row {
  const found = days.find((row) => row.day === startOfLocalDay(midnight))
  if (found === undefined) throw new Error(`no row for ${new Date(midnight).toISOString()}`)
  return found
}

function every(from: number, to: number, step: number): number[] {
  const values: number[] = []
  for (let value = from; value <= to; value += step) values.push(value)
  return values
}

function packRun(offsets: readonly number[], overrides: Partial<PackSample> = {}): PackSample[] {
  return offsets.map((offset) => packSample({ at: SAMPLE_EPOCH + offset, ...overrides }))
}

function solarRun(offsets: readonly number[], overrides: Partial<SolarSample> = {}): SolarSample[] {
  return offsets.map((offset) => solarSample({ at: SAMPLE_EPOCH + offset, ...overrides }))
}
