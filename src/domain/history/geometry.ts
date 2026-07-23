/**
 * Where a mark goes.
 *
 * The archive draws three things the live panel does not: a ledger, which is the ammeter with its
 * time axis collapsed into amp-hours; a ribbon, which is the same ammeter with time added; and a
 * coverage tape, which says when the radios were reporting at all. They share one idea — a signed
 * quantity is a distance from zero, and the house term is the gap between two tips — so the
 * arithmetic behind them belongs in one place rather than in three components.
 *
 * Two rules separate this from the live instruments. A stored session's axis is a pure function of
 * that session's own reach with no hysteresis: growing fast and releasing slowly exists to stop a
 * live axis breathing, and in a scrubbed session it would make the scale depend on which direction
 * you dragged, so the same instant would read against two different scales. And no reduction here
 * spreads a series into a call: measured on V8, 100,000 arguments pass and 125,000 throw
 * RangeError, and a browsable session is not bounded by ten minutes.
 */

import type { CoverageClass, CoverageRun, SessionLedger, TimeWindow } from './types'

/** How many intervals an axis aims for. Round numbers win over the target, so it is a wish and
 *  never a count: a domain of 94.6 asked for five intervals of 18.9 gets five of 20. */
const DEFAULT_INTERVALS = 5
const CENTRED_INTERVALS = 4
/** Tenths of a viewBox unit. Below a tenth of a pixel the extra digits are file size. */
const DEFAULT_PATH_DECIMALS = 1
const STEP_MANTISSAS = [1, 2, 5, 10]
/** A mantissa that lands a hair above a stop through floating point must not climb to the next. */
const MANTISSA_TOLERANCE = 1e-9
const NOON_HOUR = 12

export interface Extent {
  readonly min: number
  readonly max: number
}

/** Null when nothing finite arrived. An absent series is not a series of zeroes, and an axis
 *  built as though it were would draw a bar at full scale over no data. */
export function extentOf(values: Iterable<number | null>): Extent | null {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let seen = false

  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
    seen = true
  }

  return seen ? { min, max } : null
}

/** The largest distance from zero in a series, for the axes that read as deflection. */
export function maxMagnitudeOf(values: Iterable<number | null>): number {
  let reach = 0
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue
    const distance = Math.abs(value)
    if (distance > reach) reach = distance
  }
  return reach
}

/**
 * Maps a value in `[from, to]` onto `[start, end]`. An inverted range is ordinary rather than an
 * error: an SVG y axis grows downwards, so it passes `end` below `start`.
 */
export interface LinearScale {
  readonly from: number
  readonly to: number
  readonly start: number
  readonly end: number
}

export function linearScale(from: number, to: number, start: number, end: number): LinearScale {
  return { from, to, start, end }
}

export function positionOn(scale: LinearScale, value: number): number {
  const span = scale.to - scale.from
  if (span === 0) return scale.start
  return scale.start + ((value - scale.from) / span) * (scale.end - scale.start)
}

/** Pins a value beyond either end of the domain to that end, so a reading past the axis is drawn
 *  at the limit rather than outside the viewBox, where it would be clipped without a trace. */
export function clampedPositionOn(scale: LinearScale, value: number): number {
  const low = Math.min(scale.from, scale.to)
  const high = Math.max(scale.from, scale.to)
  return positionOn(scale, Math.min(high, Math.max(low, value)))
}

export interface Axis {
  readonly low: number
  readonly high: number
  readonly step: number
  /** Ascending, inclusive of both ends. Zero is always among them. */
  readonly ticks: readonly number[]
}

/** Rounds an interval up to the next 1, 2 or 5 times a power of ten, so the labels read as round
 *  numbers whatever the data's magnitude. */
export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const mantissa = rough / magnitude
  const chosen = STEP_MANTISSAS.find((stop) => stop >= mantissa - MANTISSA_TOLERANCE) ?? 10
  return chosen * magnitude
}

/**
 * An axis over the signed extent actually present, always including zero.
 *
 * Deliberately not symmetric. The integral of solar cannot go negative, so a domain of ±D would
 * spend half its width on a region no mark can reach — every sunny day drawn at half scale. The
 * ends land on a tick, so a bar reaching full deflection can be checked against a printed number
 * rather than looking clipped.
 */
export function signedAxis(extent: Extent | null, targetIntervals = DEFAULT_INTERVALS): Axis {
  const low = Math.min(0, extent?.min ?? 0)
  const high = Math.max(0, extent?.max ?? 0)
  const intervals = Math.max(1, Math.round(targetIntervals))
  const step = niceStep((high - low || 1) / intervals)
  return axisFrom(Math.floor(low / step) * step, Math.ceil(high / step) * step, step)
}

/** A centre-zero axis for a quantity read as deflection either side of zero. The interval count is
 *  forced even, so zero is always a tick and never falls between two. */
export function centredAxis(magnitude: number, targetIntervals = CENTRED_INTERVALS): Axis {
  const reach = Number.isFinite(magnitude) ? Math.abs(magnitude) : 0
  const halves = Math.max(1, Math.round(targetIntervals / 2))
  const step = niceStep((reach || 1) / halves)
  const high = Math.max(step, Math.ceil(reach / step) * step)
  return axisFrom(-high, high, step)
}

export interface Bar {
  readonly x: number
  readonly width: number
}

/** A bar rooted at zero, running in whichever direction its value points. */
export function barFromZero(scale: LinearScale, value: number): Bar {
  return spanBetween(scale, 0, value)
}

/**
 * The distance between two values, as a rectangle. This is the house term: `house = solar − pack`
 * is exactly the gap between the two tips, and it reads the same whether the span brackets zero or
 * sits entirely on one side of it.
 */
export function spanBetween(scale: LinearScale, from: number, to: number): Bar {
  const start = clampedPositionOn(scale, from)
  const end = clampedPositionOn(scale, to)
  return { x: Math.min(start, end), width: Math.abs(end - start) }
}

export interface LedgerGeometry {
  readonly axis: Axis
  readonly scale: LinearScale
  readonly pack: Bar
  readonly solar: Bar
  /** The span between the two tips. Its length is the house figure; it is never a bar from zero. */
  readonly house: Bar
  /** Amp-hours out to the boat across the counted window — the length of the span, signed. */
  readonly houseAh: number
  /** Null unless the pack took more than the panels gave somewhere in the session. */
  readonly unmeasured: Bar | null
}

/**
 * The signature mark: the session's energy account on one signed amp-hour axis.
 *
 * The unmeasured-in floor shares the axis because it is the same unit and the same question, and
 * because putting it on a scale of its own would let a large unknown draw small.
 */
export function ledgerGeometry(ledger: SessionLedger, left: number, right: number): LedgerGeometry {
  const axis = signedAxis(
    extentOf([ledger.packAh, ledger.solarAh, ledger.foreignAhFloor, 0]),
  )
  const scale = linearScale(axis.low, axis.high, left, right)

  return {
    axis,
    scale,
    pack: barFromZero(scale, ledger.packAh),
    solar: barFromZero(scale, ledger.solarAh),
    house: spanBetween(scale, ledger.packAh, ledger.solarAh),
    houseAh: ledger.solarAh - ledger.packAh,
    unmeasured: ledger.foreignAhFloor > 0 ? barFromZero(scale, ledger.foreignAhFloor) : null,
  }
}

export interface TracePoint {
  readonly at: number
  readonly value: number | null
}

/**
 * One `M`/`L` run per stretch of samples. A null breaks the path rather than bridging it, because
 * an interval that passed with no sample is a gap, and a straight line across it asserts a reading
 * nobody took — which is what a three-minute BLE stall currently draws.
 */
export function tracePath(
  points: Iterable<TracePoint>,
  time: LinearScale,
  value: LinearScale,
  decimals = DEFAULT_PATH_DECIMALS,
): string {
  const parts: string[] = []
  let open = false

  for (const point of points) {
    if (point.value === null || !Number.isFinite(point.value)) {
      open = false
      continue
    }
    const x = clampedPositionOn(time, point.at).toFixed(decimals)
    const y = clampedPositionOn(value, point.value).toFixed(decimals)
    parts.push(`${open ? 'L' : 'M'}${x},${y}`)
    open = true
  }

  return parts.join('')
}

export interface BandPoint {
  readonly at: number
  readonly lower: number | null
  readonly upper: number | null
}

interface BandVertex {
  readonly x: number
  readonly lower: number
  readonly upper: number
}

/**
 * The filled region between two traces, closed once per contiguous run.
 *
 * On the ribbon this is the house load: the gap between the pack trace and the solar trace, which
 * is the same claim the live instrument's span makes, drawn across time. A run needs two vertices
 * to enclose any area, so a lone sample between two gaps contributes nothing rather than a
 * zero-width sliver the renderer would still stroke.
 */
export function bandPath(
  points: Iterable<BandPoint>,
  time: LinearScale,
  value: LinearScale,
  decimals = DEFAULT_PATH_DECIMALS,
): string {
  const parts: string[] = []
  let run: BandVertex[] = []

  for (const point of points) {
    if (
      point.lower === null ||
      point.upper === null ||
      !Number.isFinite(point.lower) ||
      !Number.isFinite(point.upper)
    ) {
      closeRun(parts, run, decimals)
      run = []
      continue
    }
    run.push({
      x: clampedPositionOn(time, point.at),
      lower: clampedPositionOn(value, point.lower),
      upper: clampedPositionOn(value, point.upper),
    })
  }
  closeRun(parts, run, decimals)

  return parts.join('')
}

export interface CoverageSegment {
  readonly kind: CoverageClass
  readonly x: number
  readonly width: number
}

/**
 * The coverage runs as rectangles, clipped to the window and dropped when they fall outside it.
 *
 * `minWidth` is the one place this module distorts what it draws: two minutes of silence inside a
 * twelve-hour session is a fraction of a unit wide and would disappear, and a gap the eye cannot
 * find is worse than one drawn a little too generously. The caller opts in, and a widened run
 * stays inside the tape rather than hanging off its end.
 */
export function coverageSegments(
  runs: readonly CoverageRun[],
  window: TimeWindow,
  scale: LinearScale,
  minWidth = 0,
): CoverageSegment[] {
  const lowEdge = Math.min(scale.start, scale.end)
  const highEdge = Math.max(scale.start, scale.end)
  const segments: CoverageSegment[] = []

  for (const run of runs) {
    const from = Math.max(run.from, window.from)
    const to = Math.min(run.to, window.to)
    if (to <= from) continue

    const first = positionOn(scale, from)
    const last = positionOn(scale, to)
    const width = Math.abs(last - first)
    const x = Math.min(first, last)

    if (width >= minWidth) {
      segments.push({ kind: run.kind, x, width })
      continue
    }

    const grown = Math.min(minWidth, highEdge - lowEdge)
    const centred = x + width / 2 - grown / 2
    segments.push({
      kind: run.kind,
      x: Math.min(highEdge - grown, Math.max(lowEdge, centred)),
      width: grown,
    })
  }

  return segments
}

/**
 * The clock band's ruler: noon, evening, midnight, morning, the next noon. The day offset is
 * carried alongside the hour because half of these ticks belong to the following date, and a
 * ruler that derived one from the other would put 18:00 on the wrong side of midnight.
 */
const CLOCK_BAND_RULER: readonly { readonly hour: number; readonly dayOffset: number }[] = [
  { hour: 12, dayOffset: 0 },
  { hour: 18, dayOffset: 0 },
  { hour: 0, dayOffset: 1 },
  { hour: 6, dayOffset: 1 },
  { hour: 12, dayOffset: 1 },
]

/** The hours the group header labels its shared ruler with. */
export const CLOCK_BAND_TICK_HOURS: readonly number[] = CLOCK_BAND_RULER.map((tick) => tick.hour)

export interface ClockBandTick {
  readonly at: number
  readonly hour: number
  /** 0…1 across the band. Not simply the tick's index over four: a clock change makes one local
   *  day 23 or 25 hours long, and the midnight seam has to sit where it really falls. */
  readonly position: number
}

export interface ClockBand {
  /** Local noon: the band's left edge. */
  readonly from: number
  /** The next local noon, so the band is exactly one local day. */
  readonly to: number
  /** 0…1 across the band, clamped, so a watch is never drawn at both edges at once. */
  readonly start: number
  readonly end: number
  /** True when the watch reaches outside the band and the row must print its real duration. */
  readonly clipped: boolean
  readonly ticks: readonly ClockBandTick[]
}

/**
 * Where a watch fell in the day, on a band that runs noon to noon.
 *
 * Midnight sits at the centre, so an overnight is one contiguous block through the middle. A band
 * running midnight to midnight draws that same watch at both edges, which the eye reads right to
 * left and then wraps, against a ruler that reads left to right and whose two halves are different
 * dates.
 *
 * The band is anchored on the noon at or before the watch's MIDPOINT, which is provably the noon
 * that leaves the least of the watch outside the band. No noon-anchored day can contain a watch
 * that crosses noon; when that happens the band clips one end and says so, which is honest,
 * whereas wrapping the remainder round to the far edge is the failure the noon seam exists to
 * prevent.
 */
export function clockBandFor(startedAt: number, endedAt: number): ClockBand {
  const first = Math.min(startedAt, endedAt)
  const last = Math.max(startedAt, endedAt)
  const from = localNoonAtOrBefore(first + (last - first) / 2)
  const to = localNoonAfter(from)
  const span = to - from || 1

  return {
    from,
    to,
    start: clampFraction((first - from) / span),
    end: clampFraction((last - from) / span),
    clipped: first < from || last > to,
    ticks: bandTicks(from, span),
  }
}

function axisFrom(low: number, high: number, step: number): Axis {
  const top = high > low ? high : low + step
  const intervals = Math.max(1, Math.round((top - low) / step))
  const ticks: number[] = []
  for (let index = 0; index <= intervals; index += 1) {
    ticks.push(roundToStep(low + index * step, step))
  }
  return { low: roundToStep(low, step), high: roundToStep(top, step), step, ticks }
}

/** Steps accumulate floating-point dust — 0.30000000000000004 on an axis labelled in tenths — so
 *  every tick is rounded to the resolution its own step implies. */
function roundToStep(value: number, step: number): number {
  const decimals = Math.min(20, Math.max(0, -Math.floor(Math.log10(step))))
  return Number(value.toFixed(decimals))
}

function closeRun(parts: string[], run: readonly BandVertex[], decimals: number): void {
  if (run.length < 2) return

  let path = ''
  for (let index = 0; index < run.length; index += 1) {
    const vertex = run[index]
    path += `${index === 0 ? 'M' : 'L'}${vertex.x.toFixed(decimals)},${vertex.upper.toFixed(decimals)}`
  }
  for (let index = run.length - 1; index >= 0; index -= 1) {
    const vertex = run[index]
    path += `L${vertex.x.toFixed(decimals)},${vertex.lower.toFixed(decimals)}`
  }
  parts.push(`${path}Z`)
}

function bandTicks(from: number, span: number): ClockBandTick[] {
  return CLOCK_BAND_RULER.map((tick) => {
    const at = instantAt(from, tick.hour, tick.dayOffset)
    return { at, hour: tick.hour, position: clampFraction((at - from) / span) }
  })
}

function localNoonAtOrBefore(at: number): number {
  const noon = new Date(at)
  noon.setHours(NOON_HOUR, 0, 0, 0)
  // Stepping the date rather than subtracting a day keeps this at local noon across a clock change.
  if (noon.getTime() > at) noon.setDate(noon.getDate() - 1)
  return noon.getTime()
}

function localNoonAfter(from: number): number {
  return instantAt(from, NOON_HOUR, 1)
}

function instantAt(anchor: number, hour: number, dayOffset: number): number {
  const when = new Date(anchor)
  when.setDate(when.getDate() + dayOffset)
  when.setHours(hour, 0, 0, 0)
  return when.getTime()
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
