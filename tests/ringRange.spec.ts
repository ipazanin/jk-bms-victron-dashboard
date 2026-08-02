/**
 * What these tests establish.
 *
 * The folds behind the Stats cards, now that every figure on them comes from the pack's own ring
 * rather than from a session. Three things here are judgement rather than arithmetic, and each has
 * its own case because each was got wrong first:
 *
 * The pack resets its own coulomb counter at the end of a charge, and the reset looks exactly like
 * a 35 Ah hour. Nineteen of them in the captured ring carry a fifth of the raw positive total, so
 * folding them in over-reports charge by about 21 %. The signature is the step landing EXACTLY on
 * nominal capacity — not a plausibility test on the endpoint currents, which are instantaneous
 * samples an hour apart and would throw away 452 Ah of real hours to catch it.
 *
 * A step across a clock rewrite or across a hole in the ledger spans an unknown stretch of time, so
 * neither is charge either. The rewrite is tested before the hole, because a rewrite also stretches
 * the counter span and reporting it as an unexplained hole would name the symptom over the cause.
 *
 * And a record whose clock segment no read ever observed cannot be placed on a real clock, so it
 * cannot be excluded by a wall-clock window either. It counts in the totals and appears in no
 * bucket and on no trace. Counting without dating is honest; a guessed day is not.
 *
 * The clock is pinned throughout at a zero offset and a zero error, so a record's resolved instant
 * is exactly the instant its counter was built from and every expectation reads as a wall clock.
 */

import { describe, expect, it } from 'vitest'

import {
  ringEnergyBuckets,
  ringEventsPerDay,
  ringRangeSummary,
  ringTrack,
} from '../src/application/history/ringRange'
import { RTC_EPOCH_UTC_MS } from '../src/domain/bms/detailLog'
import { logbookLabel } from '../src/domain/bms/logbook'
import { PACK_SAMPLING_PERIOD_SECONDS, ringClockContextOf } from '../src/domain/history/ringClock'
import type { RingClockContext } from '../src/domain/history/RingClockContext'
import type { RingRecordRow } from '../src/domain/history/RingRecordRow'
import type { StoredRingLedger } from '../src/domain/history/StoredRingLedger'
import type { TimeWindow } from '../src/domain/history/types'
import type { RingRecordSpec } from './support/samples'
import { PACK_DEVICE_KEY, deviceRecord, ringRecordBytes, ringRecordRow } from './support/samples'

/** Zero, so a counter's face IS the wall-clock instant it was built from and nothing needs a shift. */
const PACK_OFFSET_MINUTES = 0

const PERIOD_MS = PACK_SAMPLING_PERIOD_SECONDS * 1_000
const CLOCK_REWRITE_EVENT_CODE = 0x3b
const PROTECTION_EVENT_CODE = 0x02

/** June, so no daylight-saving seam falls inside any window under test. */
const DAY_ONE = at(2025, 5, 15, 0)
const DAY_TWO = at(2025, 5, 16, 0)
const DAY_THREE = at(2025, 5, 17, 0)

/** A local wall-clock instant, so bucketing is deterministic whatever the runner's timezone. */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month, day, hour, minute, 0).getTime()
}

/** The counter whose face lands exactly on a wall-clock instant under `PACK_OFFSET_MINUTES`. */
function counterAt(instant: number): number {
  return Math.round((instant - RTC_EPOCH_UTC_MS) / 1_000)
}

function row(
  seq: number,
  counterSeconds: number,
  spec: Partial<RingRecordSpec> = {},
  followsGap = false,
): RingRecordRow {
  return ringRecordRow({ seq, followsGap, bytes: ringRecordBytes({ counterSeconds, ...spec }) })
}

/** Consecutive scheduled records one sampling period apart, from a wall-clock instant. */
function hourly(from: number, specs: readonly Partial<RingRecordSpec>[]): RingRecordRow[] {
  const base = counterAt(from)
  return specs.map((spec, seq) => row(seq, base + seq * PACK_SAMPLING_PERIOD_SECONDS, spec))
}

/** Capacity readings alone, which is what most of these cases vary. */
function capacities(from: number, readings: readonly number[]): RingRecordRow[] {
  return hourly(
    from,
    readings.map((remainingCapacity) => ({ remainingCapacity })),
  )
}

function ledgerOf(records: readonly RingRecordRow[], device: StoredRingLedger['device']): StoredRingLedger {
  return { deviceKey: PACK_DEVICE_KEY, records, reads: [], device, retainedFromSeq: null }
}

/** The owner has answered both questions, so every record resolves exactly and to the second. */
function pinnedContext(records: readonly RingRecordRow[]): RingClockContext {
  const device = deviceRecord({
    packUtcOffsetMinutes: PACK_OFFSET_MINUTES,
    packClockAheadSeconds: 0,
  })
  return ringClockContextOf(ledgerOf(records, device), PACK_OFFSET_MINUTES)
}

/** No pin and no read that carried a counter, so nothing anchors the ledger to a real clock. */
function unanchoredContext(records: readonly RingRecordRow[]): RingClockContext {
  return ringClockContextOf(ledgerOf(records, null), PACK_OFFSET_MINUTES)
}

const WHOLE_RANGE: TimeWindow = { from: DAY_ONE - 7 * 24 * 3_600_000, to: DAY_THREE + 24 * 3_600_000 }

describe('ringRangeSummary · charge', () => {
  it('folds charge in and out from the pack’s own remaining-capacity counter', () => {
    const records = capacities(DAY_ONE, [300, 310, 305, 295])
    const summary = ringRangeSummary(records, pinnedContext(records), WHOLE_RANGE)

    expect(summary.records).toBe(4)
    expect(summary.coveredMs).toBe(4 * PERIOD_MS)
    expect(summary.chargedAh).toBeCloseTo(10, 6)
    expect(summary.drawnAh).toBeCloseTo(15, 6)
    expect(summary.unattributed['counter-snap'].steps).toBe(0)
    expect(summary.unattributed['clock-rewrite'].steps).toBe(0)
    expect(summary.unattributed.gap.steps).toBe(0)
  })

  it('refuses a step that lands exactly on nominal capacity and reports it as a counter snap', () => {
    const records = capacities(DAY_ONE, [279.5, 315, 310])
    const summary = ringRangeSummary(records, pinnedContext(records), WHOLE_RANGE)

    // The 35.5 Ah the counter jumped is the pack correcting itself, not an hour of charge.
    expect(summary.chargedAh).toBeCloseTo(0, 6)
    expect(summary.drawnAh).toBeCloseTo(5, 6)
    expect(summary.unattributed['counter-snap'].steps).toBe(1)
    expect(summary.unattributed['counter-snap'].ah).toBeCloseTo(35.5, 6)
  })

  it('keeps folding once the counter is already sitting on nominal', () => {
    const records = capacities(DAY_ONE, [315, 315, 312])
    const summary = ringRangeSummary(records, pinnedContext(records), WHOLE_RANGE)

    expect(summary.unattributed['counter-snap'].steps).toBe(0)
    expect(summary.drawnAh).toBeCloseTo(3, 6)
  })

  it('attributes a −10 Ah hour between two near-zero endpoint currents rather than discarding it', () => {
    // The endpoint currents say nothing about the hour's average, so they are not a plausibility
    // test: 10 Ah in an hour reads as 10 A, and both samples read a tenth of that.
    const records = hourly(DAY_ONE, [
      { remainingCapacity: 300, current: 0.1 },
      { remainingCapacity: 290, current: -0.1 },
    ])
    const summary = ringRangeSummary(records, pinnedContext(records), WHOLE_RANGE)

    expect(summary.drawnAh).toBeCloseTo(10, 6)
    expect(summary.unattributed.gap.steps).toBe(0)
    expect(summary.unattributed['counter-snap'].steps).toBe(0)
  })

  it('discards a step across a calibration and counts it', () => {
    const records = rewrittenClockLedger()
    const summary = ringRangeSummary(records, pinnedContext(records), WHOLE_RANGE)

    // The rewrite pair spans 7 h 01 m 08 s of counter, which the rewrite explains and a hole would
    // not — so it is named for its cause rather than for its symptom.
    expect(summary.unattributed['clock-rewrite'].steps).toBe(1)
    expect(summary.unattributed['clock-rewrite'].ah).toBeCloseTo(5, 6)
    expect(summary.unattributed.gap.steps).toBe(0)
    expect(summary.chargedAh).toBeCloseTo(0, 6)
  })

  it('discards a step across a ledger gap and counts it', () => {
    // Counters stay contiguous, so only the gap marker can be what refuses this step.
    const base = counterAt(DAY_ONE)
    const records = [
      row(0, base, { remainingCapacity: 300 }),
      row(1, base + PACK_SAMPLING_PERIOD_SECONDS, { remainingCapacity: 200 }, true),
      row(2, base + 2 * PACK_SAMPLING_PERIOD_SECONDS, { remainingCapacity: 195 }),
    ]
    const summary = ringRangeSummary(records, pinnedContext(records), WHOLE_RANGE)

    expect(summary.unattributed.gap.steps).toBe(1)
    expect(summary.unattributed.gap.ah).toBeCloseTo(100, 6)
    expect(summary.drawnAh).toBeCloseTo(5, 6)
  })

  it('discards a step whose counter span is wider than two sampling periods', () => {
    const base = counterAt(DAY_ONE)
    const records = [
      row(0, base, { remainingCapacity: 300 }),
      row(1, base + 3 * PACK_SAMPLING_PERIOD_SECONDS, { remainingCapacity: 250 }),
    ]
    const summary = ringRangeSummary(records, pinnedContext(records), WHOLE_RANGE)

    expect(summary.unattributed.gap.steps).toBe(1)
    expect(summary.unattributed.gap.ah).toBeCloseTo(50, 6)
    expect(summary.drawnAh).toBeCloseTo(0, 6)
  })
})

describe('ringRangeSummary · extremes and events', () => {
  it('reports deepest charge as remaining over nominal', () => {
    const records = capacities(DAY_ONE, [300, 220.5, 280])
    const summary = ringRangeSummary(records, pinnedContext(records), WHOLE_RANGE)

    expect(summary.deepestChargeRatio).toBeCloseTo(220.5 / 315, 9)
  })

  it('reports the widest cell spread and the hottest probe of any record', () => {
    const records = hourly(DAY_ONE, [
      { highestCellVoltage: 3.4, lowestCellVoltage: 3.398, mosfetTemperature: 30 },
      { highestCellVoltage: 3.42, lowestCellVoltage: 3.39, mosfetTemperature: 41 },
    ])
    const summary = ringRangeSummary(records, pinnedContext(records), WHOLE_RANGE)

    expect(summary.widestCellSpreadMv).toBe(30)
    expect(summary.hottestC).toBe(41)
  })

  it('counts event records and leaves calibrations out of the tally', () => {
    const records = rewrittenClockLedger([{ seq: 3, eventCode: PROTECTION_EVENT_CODE }])
    const summary = ringRangeSummary(records, pinnedContext(records), WHOLE_RANGE)

    expect(summary.events).toBe(1)
  })

  it('leaves a record outside the window out of every figure', () => {
    const records = capacities(DAY_ONE, [300, 310, 305])
    const context = pinnedContext(records)
    const window: TimeWindow = { from: DAY_ONE + PERIOD_MS, to: DAY_ONE + 3 * PERIOD_MS }
    const summary = ringRangeSummary(records, context, window)

    // Two records land, and with them the two hours ENDING inside the window — the hour that
    // brought the pack to the window's first record is the window's own first hour.
    expect(summary.records).toBe(2)
    expect(summary.chargedAh).toBeCloseTo(10, 6)
    expect(summary.drawnAh).toBeCloseTo(5, 6)
  })

  it('reports nothing rather than zero for a window the ring never covered', () => {
    const records = capacities(DAY_ONE, [300, 310])
    const summary = ringRangeSummary(records, pinnedContext(records), {
      from: DAY_THREE,
      to: DAY_THREE + 3_600_000,
    })

    expect(summary.records).toBe(0)
    expect(summary.deepestChargeRatio).toBeNull()
    expect(summary.widestCellSpreadMv).toBeNull()
    expect(summary.hottestC).toBeNull()
  })
})

describe('ringEnergyBuckets', () => {
  it('emits a dense bucket per unit and marks the ones the ring never covered', () => {
    const records = hourly(DAY_ONE, [
      { remainingCapacity: 300, packVoltage: 13 },
      { remainingCapacity: 310, packVoltage: 13.4 },
    ])
    const buckets = ringEnergyBuckets(records, pinnedContext(records), {
      from: DAY_ONE,
      to: DAY_THREE + 12 * 3_600_000,
    }, 'day')

    expect(buckets).toHaveLength(3)
    expect(buckets.map((bucket) => bucket.start)).toEqual([DAY_ONE, DAY_TWO, DAY_THREE])
    expect(buckets[0].recorded).toBe(true)
    // 10 Ah at the mean of the interval's two ends, which the ring carries at both.
    expect(buckets[0].inWh).toBeCloseTo(10 * 13.2, 6)
    expect(buckets[0].outWh).toBeCloseTo(0, 6)
    expect(buckets[1].recorded).toBe(false)
    expect(buckets[2].recorded).toBe(false)
  })

  it('marks a bucket covered even when nothing moved in it', () => {
    const records = capacities(DAY_ONE, [300, 300])
    const buckets = ringEnergyBuckets(records, pinnedContext(records), {
      from: DAY_ONE,
      to: DAY_TWO + 12 * 3_600_000,
    }, 'day')

    expect(buckets[0].recorded).toBe(true)
    expect(buckets[0].inWh).toBeCloseTo(0, 6)
    expect(buckets[1].recorded).toBe(false)
  })

  it('keeps a refused step out of the bars as well as out of the tiles', () => {
    const records = capacities(DAY_ONE, [279.5, 315])
    const buckets = ringEnergyBuckets(records, pinnedContext(records), {
      from: DAY_ONE,
      to: DAY_ONE + 12 * 3_600_000,
    }, 'day')

    expect(buckets[0].recorded).toBe(true)
    expect(buckets[0].inWh).toBeCloseTo(0, 6)
  })
})

describe('ringEventsPerDay', () => {
  it('tallies events per local day under the resolved clock', () => {
    const records = hourly(
      DAY_ONE,
      Array.from({ length: 30 }, (_unused, index) =>
        index === 10 || index === 26 ? { eventCode: PROTECTION_EVENT_CODE } : {},
      ),
    )
    const days = ringEventsPerDay(records, pinnedContext(records), {
      from: DAY_ONE,
      to: DAY_TWO + 12 * 3_600_000,
    })

    expect(days.map((day) => day.day)).toEqual([DAY_ONE, DAY_TWO])
    expect(days[0].total).toBe(1)
    expect(days[1].total).toBe(1)
    expect(days[0].labels).toEqual([logbookLabel(PROTECTION_EVENT_CODE)])
    expect(days[0].codes).toEqual([PROTECTION_EVENT_CODE])
  })

  it('excludes calibration events from the event tally', () => {
    const records = rewrittenClockLedger()
    const context = pinnedContext(records)
    const days = ringEventsPerDay(records, context, { from: DAY_ONE, to: DAY_ONE + 12 * 3_600_000 })

    // The rewrite is on record as a rewrite; it is simply not a fact about the pack.
    expect(context.calibrations).toHaveLength(1)
    expect(days.every((day) => day.total === 0)).toBe(true)
  })

  it('zero-fills a clean day rather than omitting it', () => {
    const records = hourly(DAY_ONE, [{ eventCode: PROTECTION_EVENT_CODE }, {}])
    const days = ringEventsPerDay(records, pinnedContext(records), {
      from: DAY_ONE,
      to: DAY_THREE + 12 * 3_600_000,
    })

    expect(days).toHaveLength(3)
    expect(days[1]).toEqual({ day: DAY_TWO, total: 0, labels: [], codes: [] })
    expect(days[2]).toEqual({ day: DAY_THREE, total: 0, labels: [], codes: [] })
  })

  it('lists one entry per distinct code, in the order it first fired that day', () => {
    const records = hourly(DAY_ONE, [
      { eventCode: 0x04 },
      { eventCode: PROTECTION_EVENT_CODE },
      { eventCode: 0x04 },
    ])
    const days = ringEventsPerDay(records, pinnedContext(records), {
      from: DAY_ONE,
      to: DAY_ONE + 12 * 3_600_000,
    })

    expect(days[0].total).toBe(3)
    expect(days[0].codes).toEqual([0x04, PROTECTION_EVENT_CODE])
    expect(days[0].labels).toEqual([logbookLabel(0x04), logbookLabel(PROTECTION_EVENT_CODE)])
  })
})

describe('ringTrack', () => {
  it('emits one point per record and never resamples', () => {
    const records = capacities(DAY_ONE, [300, 305, 310, 308])
    const track = ringTrack(records, pinnedContext(records), WHOLE_RANGE)

    expect(track.points).toHaveLength(4)
    expect(track.empty).toBe(false)
    expect(track.points.map((point) => point.at)).toEqual([
      DAY_ONE,
      DAY_ONE + PERIOD_MS,
      DAY_ONE + 2 * PERIOD_MS,
      DAY_ONE + 3 * PERIOD_MS,
    ])
    expect(track.points[2].chargeRatio).toBeCloseTo(310 / 315, 9)
    expect(track.points.every((point) => point.uncertaintyMs === 0)).toBe(true)
  })

  it('reads its axes off the points rather than off the window', () => {
    const records = hourly(DAY_ONE, [
      { packVoltage: 13, current: -8.4 },
      { packVoltage: 13.6, current: 22.5 },
    ])
    const track = ringTrack(records, pinnedContext(records), WHOLE_RANGE)

    expect(track.voltageSpanV).toEqual({ low: 13, high: 13.6 })
    expect(track.currentMagnitudeA).toBeCloseTo(22.5, 6)
  })

  it('breaks the timeline at a gap rather than bridging it', () => {
    const base = counterAt(DAY_ONE)
    const records = [
      row(0, base, { remainingCapacity: 300 }),
      row(1, base + 5 * PACK_SAMPLING_PERIOD_SECONDS, { remainingCapacity: 250 }),
      row(2, base + 6 * PACK_SAMPLING_PERIOD_SECONDS, { remainingCapacity: 248 }),
    ]
    const track = ringTrack(records, pinnedContext(records), WHOLE_RANGE)

    expect(track.points).toHaveLength(3)
    expect(track.gaps).toEqual([{ from: DAY_ONE, to: DAY_ONE + 5 * PERIOD_MS }])
  })

  it('runs straight through a clock rewrite rather than folding back on itself', () => {
    const records = rewrittenClockLedger()
    const track = ringTrack(records, pinnedContext(records), WHOLE_RANGE)

    expect(track.gaps).toEqual([])
    // The segment correction puts both faces of the rewrite on one timeline; without it the two
    // pre-rewrite records would sit seven hours behind the two after them.
    const instants = track.points.map((point) => point.at)
    expect([...instants].sort((left, right) => left - right)).toEqual(instants)
    // Two sampling periods end to end. Uncorrected, the four faces would span nine hours.
    expect(instants[3] - instants[0]).toBeGreaterThan(PERIOD_MS)
    expect(instants[3] - instants[0]).toBeLessThan(3 * PERIOD_MS)
  })

  it('does not break the timeline where the pack only corrected its own counter', () => {
    // A counter snap is refused as charge, but it is not a hole in coverage: the ring was watching
    // that hour, and a break drawn there would claim it was not.
    const records = capacities(DAY_ONE, [279.5, 315, 310])
    const track = ringTrack(records, pinnedContext(records), WHOLE_RANGE)

    expect(track.points).toHaveLength(3)
    expect(track.gaps).toEqual([])
  })

  it('is empty when no record lands in the window', () => {
    const records = capacities(DAY_ONE, [300, 310])
    const track = ringTrack(records, pinnedContext(records), { from: DAY_THREE, to: DAY_THREE + 3_600_000 })

    expect(track.empty).toBe(true)
    expect(track.points).toEqual([])
    expect(track.voltageSpanV).toBeNull()
  })
})

describe('a ledger no read has ever placed on a real clock', () => {
  it('counts an undated record in the totals and leaves it out of the day buckets', () => {
    const records = capacities(DAY_ONE, [300, 310, 305])
    const context = unanchoredContext(records)
    // A window nowhere near the records: an undated record cannot be ruled out by one.
    const window: TimeWindow = { from: DAY_THREE, to: DAY_THREE + 3_600_000 }

    const summary = ringRangeSummary(records, context, window)
    expect(summary.records).toBe(3)
    expect(summary.undatedRecords).toBe(3)
    expect(summary.chargedAh).toBeCloseTo(10, 6)
    expect(summary.drawnAh).toBeCloseTo(5, 6)

    const buckets = ringEnergyBuckets(records, context, window, 'day')
    expect(buckets.every((bucket) => !bucket.recorded)).toBe(true)
    expect(buckets.every((bucket) => bucket.inWh === 0 && bucket.outWh === 0)).toBe(true)

    expect(ringTrack(records, context, window).empty).toBe(true)
  })

  it('dates nothing on the event chart either', () => {
    const records = hourly(DAY_ONE, [{ eventCode: PROTECTION_EVENT_CODE }, {}])
    const context = unanchoredContext(records)
    const days = ringEventsPerDay(records, context, { from: DAY_ONE, to: DAY_ONE + 12 * 3_600_000 })

    expect(days.every((day) => day.total === 0)).toBe(true)
    expect(ringRangeSummary(records, context, WHOLE_RANGE).events).toBe(1)
  })
})

/**
 * Four records around the rewrite the captured ring actually holds: two scheduled samples, then the
 * 0x3b pair the pack writes when its clock is set, about seven hours forward.
 *
 * Counters are built backwards from the TRUE instants — the first two carry a face seven hours
 * behind the real clock — so a correctly segmented fold puts all four back on one timeline and a
 * fold that ignores the rewrite scatters them across seven hours. The pair is written two seconds
 * apart rather than simultaneously, as the captured pair was, so a break wrongly drawn across the
 * rewrite would have real width instead of collapsing to nothing.
 */
function rewrittenClockLedger(
  events: readonly { readonly seq: number; readonly eventCode: number }[] = [],
): RingRecordRow[] {
  const behindSeconds = 25_268
  const truth = [DAY_ONE, DAY_ONE + PERIOD_MS, DAY_ONE + PERIOD_MS + 2_000, DAY_ONE + 2 * PERIOD_MS]
  const onOldFace = [true, true, false, false]
  const remaining = [300, 300, 305, 305]
  const codes = [0, CLOCK_REWRITE_EVENT_CODE, CLOCK_REWRITE_EVENT_CODE, 0]

  return truth.map((instant, seq) =>
    row(seq, counterAt(instant) - (onOldFace[seq] ? behindSeconds : 0), {
      remainingCapacity: remaining[seq],
      eventCode: events.find((each) => each.seq === seq)?.eventCode ?? codes[seq],
    }),
  )
}
