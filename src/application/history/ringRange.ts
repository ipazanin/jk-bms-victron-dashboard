/**
 * The Stats page's ranges, folded from the pack's own stored ring.
 *
 * Energy comes from the pack's coulomb counter and never from re-integrating current. An hourly
 * current sample is not an integrand — one captured record reads −88.3 A across an hour that moved
 * 3.1 Ah — so the only trustworthy quantity at this cadence is the difference between two
 * `remainingCapacity` readings. That difference is also why every energy figure here is a FLOOR:
 * charge and discharge that cancel inside one hour are invisible to a counter sampled hourly.
 *
 * Three kinds of step are refused rather than folded into charge. A step landing exactly on the
 * pack's nominal capacity is the BMS resetting its own counter at end of charge — measured on the
 * real ring, 19 such intervals carry 235.4 Ah, about a fifth of the raw positive total. A step
 * across a clock rewrite or across a hole in the ledger spans an unknown stretch of time, so its
 * endpoints are not comparable at all. Each is reported on its own line, never silently dropped and
 * never counted as charge. Endpoint currents are deliberately not used as a plausibility test: a
 * rule keyed on them flags 130 of 835 intervals and throws away 452 Ah of real data.
 *
 * Windowing runs on the resolved wall clock, with one exception the design insists on. A record
 * whose clock segment no read has ever observed cannot be placed on a real clock at all, so it
 * cannot be excluded by a window either. Such records are counted in the totals, reported as
 * `undatedRecords`, and left out of every bucket and out of the timeline — counting without dating
 * is honest, and a guessed day reads exactly like a known one.
 *
 * The ledger arrives in seq order, the pack's write order, and nothing here re-sorts it. A backward
 * rewrite makes counter order disagree with write order, and a fold walking counter-ascending rows
 * would pair records written seven hours apart as consecutive hours.
 */

import type { DetailLogRecord } from '../../domain/bms/detailLog'
import { decodeDetailLogRecord } from '../../domain/bms/detailLog'
import { logbookLabel } from '../../domain/bms/logbook'
import { extentOf, higherOf, lowerOf, maxMagnitudeOf } from '../../domain/history/geometry'
import { PACK_SAMPLING_PERIOD_SECONDS, resolveRingInstant } from '../../domain/history/ringClock'
import type { RingClockContext } from '../../domain/history/RingClockContext'
import type { RingRecordRow } from '../../domain/history/RingRecordRow'
import type { TimeWindow } from '../../domain/history/types'
import type { BucketUnit, EnergyBucket } from './statsRange'
import { startOfLocalDay } from './statsRange'

/** The event a record carries when the pack's clock was set. A fact about the clock, not the pack. */
const CLOCK_REWRITE_EVENT_CODE = 0x3b
/** What a scheduled sample carries where an event record carries its code. */
const SCHEDULED_EVENT_CODE = 0

/**
 * The widest counter step still readable as one sampling interval. Two periods leaves room for a
 * single missed sample; past that the two readings bracket an unknown stretch of pack history.
 */
const MAX_ATTRIBUTABLE_STEP_SECONDS = 2 * PACK_SAMPLING_PERIOD_SECONDS

const MILLIVOLTS_PER_VOLT = 1_000

/**
 * The decoder carries a ring index through untouched and reads nothing from it. A stored row knows
 * its write order and not its position in the ring, and decoding through the one decoder rather
 * than reaching for the bytes is what keeps a correction to the record layout reinterpreting every
 * stored row.
 */
const UNREAD_RING_INDEX = 0

/**
 * A charge step this browser will not attribute.
 *
 * `counter-snap` is the BMS resetting its own coulomb count at end of charge — measured on the real
 * ring, 19 intervals land exactly on nominalCapacity and carry 235.4 Ah, about a fifth of the raw
 * positive total. The signature is exact and costs nothing else: no other interval in 835 implies
 * more than 16.3 A at p99.
 *
 * Endpoint currents are deliberately NOT used as a plausibility test. They are instantaneous samples
 * an hour apart and say almost nothing about the hour's average — one record reads −88.3 A across an
 * hour that moved 3.1 Ah — and a rule keyed on them flags 130 of 835 intervals and discards 452 Ah
 * of real data.
 */
export type UnattributedStep = 'counter-snap' | 'clock-rewrite' | 'gap'

/** What one refusal cost the totals: how many steps, and the charge movement they carried. */
export interface UnattributedTally {
  readonly steps: number
  /** Magnitude, summed. A refused step's direction is not a claim worth making. */
  readonly ah: number
}

export interface RingRangeSummary {
  readonly window: TimeWindow
  readonly records: number
  /** records × 3,601 s inside the window — the span the ring actually covers. */
  readonly coveredMs: number
  readonly chargedAh: number
  readonly drawnAh: number
  /** min(remaining / nominal) across the window. Null when no record landed. */
  readonly deepestChargeRatio: number | null
  /** max(highestCellMv − lowestCellMv). */
  readonly widestCellSpreadMv: number | null
  /** The hottest reading on any of the pack's three probes, including the MOSFET channel. */
  readonly hottestC: number | null
  /** Records with a non-zero event code, excluding 0x3b. */
  readonly events: number
  readonly unattributed: Readonly<Record<UnattributedStep, UnattributedTally>>
  /** Records the clock cannot place. Counted in the sums above; absent from the day buckets. */
  readonly undatedRecords: number
}

export interface RingEventDay {
  /** Local midnight, in wall-clock milliseconds. */
  readonly day: number
  readonly total: number
  /** Distinct labels, in the order they first fired that day. */
  readonly labels: readonly string[]
  /** The event codes behind `labels`, index for index, so a wrong label stays falsifiable on screen. */
  readonly codes: readonly number[]
}

export interface RingTrackPoint {
  readonly at: number
  readonly uncertaintyMs: number
  readonly packVoltageV: number
  readonly currentA: number
  readonly chargeRatio: number
  readonly cellSpreadMv: number
}

export interface RingTrack {
  readonly window: TimeWindow
  /** One point per record, ascending by seq. Never resampled — the ring is already sparse. */
  readonly points: readonly RingTrackPoint[]
  /** From `followsGap` rows and from any counter span over two sampling periods. Never bridged. */
  readonly gaps: readonly TimeWindow[]
  readonly voltageSpanV: { readonly low: number; readonly high: number } | null
  readonly currentMagnitudeA: number
  readonly empty: boolean
}

/**
 * A range's headline figures, every one of them the pack's own.
 *
 * Records and steps are counted on different terms on purpose. A record is a snapshot and belongs
 * to the window its own instant falls in; a step is the hour ENDING at its later record, so the
 * window's first hour is kept rather than shaved off at the edge.
 */
export function ringRangeSummary(
  records: readonly RingRecordRow[],
  context: RingClockContext,
  window: TimeWindow,
): RingRangeSummary {
  const readings = readingsOf(records, context)

  let counted = 0
  let deepestChargeRatio: number | null = null
  let widestCellSpreadMv: number | null = null
  let hottestC: number | null = null
  let events = 0
  let undatedRecords = 0

  for (const reading of readings) {
    if (!countsIn(reading, window)) continue
    counted += 1
    deepestChargeRatio = lowerOf(deepestChargeRatio, chargeRatioOf(reading.record))
    widestCellSpreadMv = higherOf(widestCellSpreadMv, cellSpreadMvOf(reading.record))
    hottestC = higherOf(hottestC, hottestProbeOf(reading.record))
    if (isEvent(reading.record)) events += 1
    if (!reading.datable) undatedRecords += 1
  }

  let chargedAh = 0
  let drawnAh = 0
  const unattributed = emptyTallies()

  for (const step of stepsOf(readings, context)) {
    if (!countsIn(step.to, window)) continue
    if (step.unattributed !== null) {
      const tally = unattributed[step.unattributed]
      tally.steps += 1
      tally.ah += Math.abs(step.deltaAh)
      continue
    }
    if (step.deltaAh > 0) chargedAh += step.deltaAh
    else drawnAh += -step.deltaAh
  }

  return {
    window,
    records: counted,
    coveredMs: counted * PACK_SAMPLING_PERIOD_SECONDS * 1_000,
    chargedAh,
    drawnAh,
    deepestChargeRatio,
    widestCellSpreadMv,
    hottestC,
    events,
    unattributed,
    undatedRecords,
  }
}

/**
 * Charge into the pack against charge out of it, per bucket, DENSE across the window so the bars
 * form an unbroken timeline.
 *
 * Valued at the mean pack voltage across each interval, which the ring carries at BOTH ends — less
 * estimated than the session fold this replaces, which valued a whole day's solar at one final
 * voltage. A bucket the ring never covered is `recorded: false` and carries no bars: an unread
 * stretch is not a stretch of zero energy, and a fabricated zero asserts a reading nobody took.
 */
export function ringEnergyBuckets(
  records: readonly RingRecordRow[],
  context: RingClockContext,
  window: TimeWindow,
  unit: BucketUnit,
): EnergyBucket[] {
  const buckets: MutableEnergy[] = []
  const byStart = new Map<number, MutableEnergy>()

  const cursor = new Date(startOfBucket(window.from, unit))
  while (cursor.getTime() <= window.to) {
    const start = cursor.getTime()
    advanceBucket(cursor, unit)
    const bucket: MutableEnergy = { start, end: cursor.getTime(), inWh: 0, outWh: 0, recorded: false }
    buckets.push(bucket)
    byStart.set(start, bucket)
  }

  const readings = readingsOf(records, context)

  // A record marks its bucket covered whether or not the hour moved any charge: an idle hour is
  // still an hour the ring was watching.
  for (const reading of readings) {
    if (!lands(reading, window)) continue
    const bucket = byStart.get(startOfBucket(reading.at, unit))
    if (bucket !== undefined) bucket.recorded = true
  }

  for (const step of stepsOf(readings, context)) {
    if (step.unattributed !== null) continue
    if (!lands(step.to, window)) continue
    const bucket = byStart.get(startOfBucket(step.to.at, unit))
    if (bucket === undefined) continue
    const wattHours = Math.abs(step.deltaAh) * meanPackVoltageOf(step)
    if (step.deltaAh > 0) bucket.inWh += wattHours
    else bucket.outWh += wattHours
  }

  return buckets.map((bucket) => ({
    start: bucket.start,
    end: bucket.end,
    inWh: bucket.inWh,
    outWh: bucket.outWh,
    recorded: bucket.recorded,
  }))
}

/**
 * One row per local day the window touches, OLDEST FIRST, zeros included — a clean day is a true
 * "0 on record", not an absent one.
 *
 * Clock rewrites are excluded. The pack files them in the same ring under the same event vocabulary,
 * but they are a fact about the clock and belong in the clock panel; tallying them here would show a
 * spike of pack events on the day someone opened the vendor app.
 *
 * Labels are deduplicated by CODE rather than by wording, so two codes that share a label stay two
 * entries and the hex beside each one keeps a wrong label falsifiable.
 */
export function ringEventsPerDay(
  records: readonly RingRecordRow[],
  context: RingClockContext,
  window: TimeWindow,
): RingEventDay[] {
  const byDay = new Map<number, MutableEventDay>()

  const lastDay = startOfLocalDay(window.to)
  const cursor = new Date(startOfLocalDay(window.from))
  // Stepping the date rather than adding 24 h keeps every row on a local midnight across a clock
  // change, so a spring-forward day is still exactly one row.
  while (cursor.getTime() <= lastDay) {
    byDay.set(cursor.getTime(), { total: 0, labels: [], codes: [] })
    cursor.setDate(cursor.getDate() + 1)
  }

  for (const reading of readingsOf(records, context)) {
    if (!isEvent(reading.record)) continue
    if (!lands(reading, window)) continue
    const day = byDay.get(startOfLocalDay(reading.at))
    if (day === undefined) continue
    day.total += 1
    const code = reading.record.eventCode
    if (day.codes.includes(code)) continue
    day.codes.push(code)
    day.labels.push(logbookLabel(code))
  }

  const rows: RingEventDay[] = []
  for (const [day, tally] of byDay) {
    rows.push({ day, total: tally.total, labels: tally.labels, codes: tally.codes })
  }
  return rows
}

/**
 * A gap-aware step trace at the ring's own cadence: one point per record, never resampled.
 *
 * A gap is a step the fold already refused as a hole — a row following a break, or a counter span
 * wider than two sampling periods. A clock rewrite is NOT a gap: the segment correction places both
 * of its records on one face, so the trace runs straight through it rather than folding back on
 * itself. Undated records carry no x and are absent from the trace, though they still count in the
 * range summary.
 */
export function ringTrack(
  records: readonly RingRecordRow[],
  context: RingClockContext,
  window: TimeWindow,
): RingTrack {
  const readings = readingsOf(records, context)

  const points: RingTrackPoint[] = []
  for (const reading of readings) {
    if (!lands(reading, window)) continue
    points.push({
      at: reading.at,
      uncertaintyMs: reading.uncertaintyMs,
      packVoltageV: reading.record.packVoltage,
      currentA: reading.record.current,
      chargeRatio: chargeRatioOf(reading.record),
      cellSpreadMv: cellSpreadMvOf(reading.record),
    })
  }

  const gaps: TimeWindow[] = []
  for (const step of stepsOf(readings, context)) {
    if (step.unattributed !== 'gap') continue
    if (!step.from.datable || !step.to.datable) continue
    const from = Math.max(window.from, step.from.at)
    const to = Math.min(window.to, step.to.at)
    if (to > from) gaps.push({ from, to })
  }

  const voltages = extentOf(points.map((point) => point.packVoltageV))

  return {
    window,
    points,
    gaps,
    voltageSpanV: voltages === null ? null : { low: voltages.min, high: voltages.max },
    currentMagnitudeA: maxMagnitudeOf(points.map((point) => point.currentA)),
    empty: points.length === 0,
  }
}

// ── internals ───────────────────────────────────────────────────────────────

/** One stored row, decoded once and placed on the real clock once. */
interface RingReading {
  readonly row: RingRecordRow
  readonly record: DetailLogRecord
  readonly at: number
  readonly uncertaintyMs: number
  /** False when nothing anchors this record's clock segment to a real clock. */
  readonly datable: boolean
}

/** The interval between two consecutive rows, and why it is or is not charge. */
interface RingStep {
  readonly from: RingReading
  readonly to: RingReading
  readonly deltaAh: number
  readonly unattributed: UnattributedStep | null
}

interface MutableTally {
  steps: number
  ah: number
}

interface MutableEnergy {
  start: number
  end: number
  inWh: number
  outWh: number
  recorded: boolean
}

interface MutableEventDay {
  total: number
  labels: string[]
  codes: number[]
}

function readingsOf(
  records: readonly RingRecordRow[],
  context: RingClockContext,
): readonly RingReading[] {
  return records.map((row) => {
    const record = decodeDetailLogRecord(row.bytes, UNREAD_RING_INDEX, {
      packUtcOffsetMinutes: context.packUtcOffsetMinutes,
    })
    const instant = resolveRingInstant(row, context)
    return {
      row,
      record,
      at: instant.at,
      uncertaintyMs: instant.uncertaintyMs,
      datable: Number.isFinite(instant.at) && Number.isFinite(instant.uncertaintyMs),
    }
  })
}

/** Consecutive rows in write order. Never in counter order: a backward rewrite reverses the two. */
function stepsOf(readings: readonly RingReading[], context: RingClockContext): readonly RingStep[] {
  const rewriteSeqs = new Set(context.calibrations.map((calibration) => calibration.atSeq))
  const steps: RingStep[] = []

  for (let at = 1; at < readings.length; at += 1) {
    const from = readings[at - 1]
    const to = readings[at]
    steps.push({
      from,
      to,
      deltaAh: to.record.remainingCapacity - from.record.remainingCapacity,
      unattributed: unattributabilityOf(from, to, rewriteSeqs),
    })
  }
  return steps
}

/**
 * Why a step is not charge, in the order the reasons explain each other.
 *
 * The rewrite test runs first because a rewrite also stretches the counter span, and reporting a
 * recorded cause as an unexplained hole names the symptom instead of the cause. A negative span
 * counts as a hole for the same reason a wide one does: without a rewrite to explain it, the two
 * readings are not two ends of one interval.
 */
function unattributabilityOf(
  from: RingReading,
  to: RingReading,
  rewriteSeqs: ReadonlySet<number>,
): UnattributedStep | null {
  if (rewriteSeqs.has(to.row.seq)) return 'clock-rewrite'
  if (to.row.followsGap) return 'gap'

  const spanSeconds = to.row.packClockSeconds - from.row.packClockSeconds
  if (Math.abs(spanSeconds) > MAX_ATTRIBUTABLE_STEP_SECONDS) return 'gap'

  // Both capacities are a uint16 divided by ten, so identical readings are identical doubles and
  // exact equality is the whole signature: the counter was reset, it did not drift onto the mark.
  if (
    to.record.remainingCapacity === to.record.nominalCapacity &&
    from.record.remainingCapacity !== from.record.nominalCapacity
  ) {
    return 'counter-snap'
  }

  return null
}

/**
 * Whether a record counts toward a range's totals. An undated record always does: it cannot be
 * placed on a real clock, so it cannot be ruled out by a wall-clock window either.
 */
function countsIn(reading: RingReading, window: TimeWindow): boolean {
  return !reading.datable || (reading.at >= window.from && reading.at <= window.to)
}

/** Whether a record can be put in a bucket at all — dated, and inside the window. */
function lands(reading: RingReading, window: TimeWindow): boolean {
  return reading.datable && reading.at >= window.from && reading.at <= window.to
}

function isEvent(record: DetailLogRecord): boolean {
  return record.eventCode !== SCHEDULED_EVENT_CODE && record.eventCode !== CLOCK_REWRITE_EVENT_CODE
}

/** Nominal capacity is the pack's rating and every decoded record carries it, so this never divides
 *  by zero on a record the pack wrote. */
function chargeRatioOf(record: DetailLogRecord): number {
  return record.remainingCapacity / record.nominalCapacity
}

/** Both extremes are a uint16 of millivolts read as volts, so the round recovers the wire exactly. */
function cellSpreadMvOf(record: DetailLogRecord): number {
  return Math.round((record.highestCellVoltage - record.lowestCellVoltage) * MILLIVOLTS_PER_VOLT)
}

/** Null only when every channel is absent, which no captured record is. */
function hottestProbeOf(record: DetailLogRecord): number | null {
  return higherOf(
    higherOf(record.highestTemperature, record.lowestTemperature),
    record.mosfetTemperature,
  )
}

function meanPackVoltageOf(step: RingStep): number {
  return (step.from.record.packVoltage + step.to.record.packVoltage) / 2
}

function emptyTallies(): Record<UnattributedStep, MutableTally> {
  return {
    'counter-snap': { steps: 0, ah: 0 },
    'clock-rewrite': { steps: 0, ah: 0 },
    gap: { steps: 0, ah: 0 },
  }
}

/** The local start of the bucket an instant falls in: its midnight, its Monday, or its 1st. */
function startOfBucket(at: number, unit: BucketUnit): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  if (unit === 'week') date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  else if (unit === 'month') date.setDate(1)
  return date.getTime()
}

/** Steps a bucket cursor by one unit, walking the calendar so a DST day is still one whole bucket. */
function advanceBucket(date: Date, unit: BucketUnit): void {
  if (unit === 'day') date.setDate(date.getDate() + 1)
  else if (unit === 'week') date.setDate(date.getDate() + 7)
  else date.setMonth(date.getMonth() + 1)
}
