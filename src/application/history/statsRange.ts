/**
 * The Stats page's ranges, as pure functions over what the archive already holds.
 *
 * Two paths, one honesty rule. The cheap path sums the cached ledgers into day buckets and a range
 * summary and reads no chunk, so week and month cost one pass over the session list at any archive
 * size. The per-sample path is only asked for the short ranges, where the browser has read each
 * overlapping session's chunks; it derives power the way the ledger derives energy — pack current
 * times pack voltage, house as `solar − pack` partitioned at strict zero — so a trace and the
 * stored ledger can never disagree about what counted as a house load.
 *
 * Nothing here bridges a hole. A break between two recordings, a stall longer than the gap bound,
 * and an instant where the pack took more than the panels gave all resolve to null, and null is
 * drawn as a break rather than a line pretending a reading was taken.
 */

import { maxMagnitudeOf } from '../../domain/history/geometry'
import type { PairedSample } from '../../domain/history/join'
import { MAX_PAIRING_AGE_MS, MAX_SAMPLE_GAP_MS, pairSamples, solarCurrentOf } from '../../domain/history/join'
import type {
  PackSample,
  SessionRecord,
  SolarSample,
  TimeWindow,
  WarningLevel,
  WarningRecord,
} from '../../domain/history/types'
import { type DailyTotal, dailyTotals, startOfLocalDay } from './daily'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

// ── range → window ──────────────────────────────────────────────────────────
export type RangeKind = 'hour' | 'day' | 'week' | 'month' | 'all' | 'custom'

/** What a caller must hand `windowFor` for the two ranges that are not a fixed roll-back from now. */
export interface WindowOptions {
  /** The archive's oldest recorded instant, for the 'all' range. Null when nothing is recorded. */
  readonly oldest?: number | null
  /** The two dates a 'custom' range was set from. Normalised here, so either order is accepted. */
  readonly custom?: TimeWindow
}

/**
 * The precise instant window a range covers, ending at `now`.
 *
 * Sub-day ranges roll straight back from now; multi-day ranges start at a local midnight so their
 * day buckets are whole days. The multi-day start is stepped back by whole local days rather than
 * by a fixed 24 h, so a clock change inside the range does not shave or add a bucket.
 *   hour   → [now − 1h, now]
 *   day    → [now − 24h, now]
 *   week   → [startOfLocalDay(now) − 6 local days, now]   (7 local days incl. today)
 *   month  → [startOfLocalDay(now) − 29 local days, now]  (30 local days incl. today)
 *   all    → [startOfLocalDay(oldest recording), now]     (the whole archive; today when empty)
 *   custom → [start of the earlier local day, end of the later local day, clamped to now]
 */
export function windowFor(kind: RangeKind, now: number, options: WindowOptions = {}): TimeWindow {
  switch (kind) {
    case 'hour':
      return { from: now - HOUR_MS, to: now }
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

export type RangeChart = 'power' | 'bars'

/**
 * Longest window still read per sample rather than folded into bars. Beyond a day and a half the
 * per-sample trace has more samples than pixels and the bars carry the story; within it the trace is
 * the more honest instrument.
 */
export const POWER_MAX_SPAN_MS = 36 * HOUR_MS

/** hour|day → 'power' (per-sample PowerTimeline); the multi-day ranges → 'bars'. */
export function chartFor(kind: RangeKind): RangeChart {
  return kind === 'hour' || kind === 'day' ? 'power' : 'bars'
}

/**
 * The chart a window earns by its span, not its name — a custom range of a single day reads per
 * sample like 'day', a custom range of a fortnight folds into bars like 'month'.
 */
export function chartForWindow(window: TimeWindow): RangeChart {
  return window.to - window.from <= POWER_MAX_SPAN_MS ? 'power' : 'bars'
}

// ── CHEAP aggregate path (all ranges) — zero chunk reads ────────────────────

/**
 * The cached-ledger day buckets for the local days the window TOUCHES, OLDEST FIRST — a bar
 * timeline reads left→old to right→new. Sparse: a day with no recording emits no bucket, because a
 * zero-energy day and an unrecorded day are different things and fabricating a zero would assert a
 * recording that never happened.
 *
 * A bucket sits at a local midnight, so it is matched against the local days at the window's ends
 * rather than the raw rolling instants: an hour window mid-afternoon still touches today, and would
 * otherwise fall between today's midnight and `from` and drop the day whole. For week and month,
 * whose `from` is already a local midnight, this is the same test.
 */
export function dailyBucketsIn(
  records: readonly SessionRecord[],
  window: TimeWindow,
  now: number,
): DailyTotal[] {
  const firstDay = startOfLocalDay(window.from)
  const lastDay = startOfLocalDay(window.to)
  return dailyTotals(records, now)
    .filter((bucket) => bucket.day >= firstDay && bucket.day <= lastDay)
    .reverse()
}

export interface ErrorTally {
  readonly warning: number
  readonly serious: number
  readonly critical: number
  readonly total: number
}

export interface RangeSummary {
  readonly window: TimeWindow
  /** Buckets represented — recorded days, not calendar days spanned. */
  readonly days: number
  readonly sessions: number
  readonly recordedMs: number
  /** Controller delivery across the counted windows. */
  readonly solarAh: number
  /** House draw. */
  readonly houseWh: number
  /** Net through the pack, signed; positive is charge. */
  readonly packAh: number
  readonly foreignAhFloor: number
  readonly deepestSoc: number | null
  readonly pvPeakW: number | null
  readonly errors: ErrorTally
}

/**
 * A range's headline figures: sums, min and max folded over the buckets already computed, plus the
 * error tally from warnings inside the precise window.
 *
 * A bucket is attributed whole to the day its session began — a cached ledger cannot be split
 * without re-integrating chunks — so for an hour or day range the summary describes the calendar
 * day the window falls in rather than the rolling window. The precise instrument for a short range
 * is the power chart beneath these tiles.
 */
export function summarize(
  buckets: readonly DailyTotal[],
  warnings: readonly WarningRecord[],
  window: TimeWindow,
): RangeSummary {
  let sessions = 0
  let recordedMs = 0
  let solarAh = 0
  let houseWh = 0
  let packAh = 0
  let foreignAhFloor = 0
  let deepestSoc: number | null = null
  let pvPeakW: number | null = null

  for (const bucket of buckets) {
    sessions += bucket.sessions
    recordedMs += bucket.recordedMs
    solarAh += bucket.solarAh
    houseWh += bucket.houseWh
    packAh += bucket.packAh
    foreignAhFloor += bucket.foreignAhFloor
    deepestSoc = lowerOf(deepestSoc, bucket.deepestSoc)
    pvPeakW = higherOf(pvPeakW, bucket.pvPeakW)
  }

  return {
    window,
    days: buckets.length,
    sessions,
    recordedMs,
    solarAh,
    houseWh,
    packAh,
    foreignAhFloor,
    deepestSoc,
    pvPeakW,
    errors: tallyErrors(warnings, window),
  }
}

// ── ENERGY IN vs OUT bars (all ranges) — cheap, from cached ledgers ─────────

/** The bucket a range folds its energy into, chosen so a span shows tens of bars, not hundreds. */
export type BucketUnit = 'day' | 'week' | 'month'

const WEEK_MS = 7 * DAY_MS

/**
 * day up to a month and a half, then week, then month — so a week reads day-by-day, a year
 * week-by-week, and the whole archive month-by-month, each landing roughly 8–45 bars wide.
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
  /** Solar energy delivered, in watt-hours. Estimated: solar amp-hours at the pack's voltage. */
  readonly inWh: number
  /** House energy drawn, in watt-hours. Exact: the ledger integrates it directly. */
  readonly outWh: number
  /** False for a bucket no session fell in — drawn as a gap, never a fabricated zero. */
  readonly recorded: boolean
}

/**
 * Absent a per-session final voltage, the pack voltage a session's solar amp-hours are valued at.
 * A pure fallback: any real session carries `finalBattery.packVoltage`, which is preferred per row,
 * so this only stands in for a session that closed before its first frame — and even then it is
 * taken from a sibling session's real voltage when the archive has one.
 */
const DEFAULT_PACK_VOLTAGE = 12.8

/**
 * Energy in (solar) against energy out (house), per bucket, DENSE across the window so the bars form
 * an unbroken timeline. A bucket no session began in is `recorded: false` and carries no bars — a
 * day with no watch is not a day of zero energy. A session is attributed whole to the bucket it
 * began in, mirroring the daily fold, because its cached ledger cannot be split without re-reading
 * chunks. Out is exact; in is solar amp-hours valued at the session's own pack voltage, so the two
 * share one watt-hour axis — the one place this file estimates rather than integrates.
 */
export function energyInOut(
  records: readonly SessionRecord[],
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

  const fallbackVoltage = firstVoltage(records) ?? DEFAULT_PACK_VOLTAGE

  for (const record of records) {
    if (record.startedAt < window.from || record.startedAt > window.to) continue
    const bucket = byStart.get(startOfBucket(record.startedAt, unit))
    if (bucket === undefined) continue
    const voltage = record.finalBattery?.packVoltage ?? fallbackVoltage
    bucket.inWh += record.ledger.solarAh * voltage
    bucket.outWh += record.ledger.houseWh
    bucket.recorded = true
  }

  return buckets.map((bucket) => ({
    start: bucket.start,
    end: bucket.end,
    inWh: bucket.inWh,
    outWh: bucket.outWh,
    recorded: bucket.recorded,
  }))
}

// ── ERRORS path — pure over WarningRecord[] ─────────────────────────────────

export interface DailyErrors {
  /** Local midnight, in wall-clock milliseconds. */
  readonly day: number
  readonly warning: number
  readonly serious: number
  readonly critical: number
  readonly total: number
  /** The day's accent; null when clean. */
  readonly worst: WarningLevel | null
}

/**
 * One row per local day the window touches, OLDEST FIRST, zeros included — a clean day is a true
 * "0 on record", not an absent one. A warning is kept when its `at` lies inside the window and
 * tallied under its own local day, so a warning at 23:59 and one at 00:01 land on different days.
 * For hour and day the span is one or two rows, which the component degrades to a compact strip.
 */
export function errorsPerDay(
  warnings: readonly WarningRecord[],
  window: TimeWindow,
): DailyErrors[] {
  const byDay = new Map<number, MutableErrors>()

  const lastDay = startOfLocalDay(window.to)
  const cursor = new Date(startOfLocalDay(window.from))
  // Stepping the date rather than adding 24 h keeps every row on a local midnight across a clock
  // change, so a spring-forward day is still exactly one row.
  while (cursor.getTime() <= lastDay) {
    byDay.set(cursor.getTime(), { warning: 0, serious: 0, critical: 0 })
    cursor.setDate(cursor.getDate() + 1)
  }

  for (const record of warnings) {
    if (record.at < window.from || record.at > window.to) continue
    const bucket = byDay.get(startOfLocalDay(record.at))
    if (bucket === undefined) continue
    bucket[record.level] += 1
  }

  const rows: DailyErrors[] = []
  for (const [day, counts] of byDay) {
    rows.push({
      day,
      warning: counts.warning,
      serious: counts.serious,
      critical: counts.critical,
      total: counts.warning + counts.serious + counts.critical,
      worst: worstLevel(counts),
    })
  }
  return rows
}

// ── PER-SAMPLE POWER path (hour/day) — pure derivation + downsample ─────────

/**
 * The three power terms at one paired instant. Every field is null where its reading is absent, and
 * house is null wherever `solar − pack` is negative: a foreign-charge instant is not a house load.
 * That is the ledger's strict-zero partition, so the trace breaks rather than dipping through a
 * value nobody measured.
 */
export interface PowerPoint {
  readonly at: number
  /** currentA × packVoltageV, signed; positive is charge, negative is discharge. */
  readonly packW: number | null
  /** The controller's PV power, never negative. */
  readonly pvW: number | null
  /** (solarCurrent − packCurrent) × packVoltageV when the difference is ≥ 0, else null. */
  readonly houseW: number | null
}

export function powerOf(sample: PairedSample): PowerPoint {
  const pack = sample.pack
  const packW = pack === null ? null : pack.currentA * pack.packVoltageV
  const pvW = sample.solar === null ? null : sample.solar.pvPowerW

  const solarCurrent = solarCurrentOf(sample)
  let houseW: number | null = null
  if (pack !== null && solarCurrent !== null) {
    const houseAmps = solarCurrent - pack.currentA
    houseW = houseAmps >= 0 ? houseAmps * pack.packVoltageV : null
  }

  return { at: sample.at, packW, pvW, houseW }
}

/** One decoded session's raw streams, as the browser hands them in already read from the store. */
export interface SessionSamples {
  readonly pack: readonly PackSample[]
  readonly solar: readonly SolarSample[]
}

/** Bounds the SVG `d` regardless of window width. day (24 h) → ~3 min columns, hour → ~7.5 s. */
export const POWER_COLUMNS = 480

/**
 * A downsampled, gap-aware power trace across every session overlapping the window.
 *
 * Each session is paired under the same staleness bound the ledger uses and derived per sample,
 * then bucketed into `columns`. Gaps are read off the raw instants the way join's `gapsOf` does: a
 * span wider than the sample-gap bound, the leading and trailing edges to the window's bounds, and
 * every inter-session boundary — the last always, even when two recordings' stamps nearly touch,
 * because a stop and a start is a real break.
 *
 * A column emits null for a field when it caught no plausible value, or when its span OVERLAPS an
 * INTERIOR break — an inter-sample stall or a session boundary — so a boundary narrower than one
 * column still breaks the trace rather than bridging two recordings. The leading and trailing edge
 * gaps deliberately do NOT null: the columns before the first sample and after the last already
 * carry no count, and nulling on the edge would erase the very column that holds the first or last
 * reading. Nothing is ever bridged.
 */
export interface PowerTracks {
  readonly window: TimeWindow
  readonly columnMs: number
  /** Per-column representative watts, signed. */
  readonly pack: readonly (number | null)[]
  readonly pv: readonly (number | null)[]
  readonly house: readonly (number | null)[]
  /** Never bridged; drawn as break bands. */
  readonly gaps: readonly TimeWindow[]
  /** Max |watts| across all three tracks, for `centredAxis`. */
  readonly magnitudeW: number
  /** True when nothing plausible landed in any column of any track. */
  readonly empty: boolean
}

interface Accumulator {
  sum: number
  count: number
}

export function powerTracks(
  sessions: readonly SessionSamples[],
  window: TimeWindow,
  columns: number,
): PowerTracks {
  const columnCount = Math.max(1, Math.floor(columns))
  const span = window.to - window.from
  const columnMs = span > 0 ? span / columnCount : 0

  const pack = emptyColumns(columnCount)
  const pv = emptyColumns(columnCount)
  const house = emptyColumns(columnCount)

  // Every gap draws a break band; only the interior ones (session boundaries and inter-sample
  // stalls) null a straddling column. The leading/trailing edges to the window bounds are drawn but
  // never null, so the column holding the first or last real sample survives.
  const gaps: TimeWindow[] = []
  const breakGaps: TimeWindow[] = []
  let cursor = window.from
  let previousWasSession = false

  if (columnMs > 0) {
    for (const session of sessions) {
      const paired = pairSamples(session.pack, session.solar, MAX_PAIRING_AGE_MS)
      let firstAt: number | null = null
      let lastAt = cursor

      for (const sample of paired) {
        if (sample.at < window.from || sample.at > window.to) continue

        if (firstAt === null) {
          firstAt = sample.at
          if (previousWasSession) {
            if (sample.at > cursor) pushGap(gaps, breakGaps, cursor, sample.at)
          } else if (sample.at - cursor > MAX_SAMPLE_GAP_MS) {
            gaps.push({ from: cursor, to: sample.at })
          }
        } else if (sample.at - lastAt > MAX_SAMPLE_GAP_MS) {
          pushGap(gaps, breakGaps, lastAt, sample.at)
        }
        lastAt = sample.at

        const point = powerOf(sample)
        const column = Math.min(columnCount - 1, Math.floor((sample.at - window.from) / columnMs))
        if (point.packW !== null) accumulate(pack[column], point.packW)
        if (point.pvW !== null) accumulate(pv[column], point.pvW)
        if (point.houseW !== null) accumulate(house[column], point.houseW)
      }

      if (firstAt !== null) {
        cursor = lastAt
        previousWasSession = true
      }
    }
  }

  if (window.to - cursor > MAX_SAMPLE_GAP_MS) gaps.push({ from: cursor, to: window.to })

  const packColumns = seal(pack, columnMs, window, breakGaps)
  const pvColumns = seal(pv, columnMs, window, breakGaps)
  const houseColumns = seal(house, columnMs, window, breakGaps)

  const magnitudeW = Math.max(
    maxMagnitudeOf(packColumns),
    maxMagnitudeOf(pvColumns),
    maxMagnitudeOf(houseColumns),
  )
  const empty = everyNull(packColumns) && everyNull(pvColumns) && everyNull(houseColumns)

  return {
    window,
    columnMs,
    pack: packColumns,
    pv: pvColumns,
    house: houseColumns,
    gaps,
    magnitudeW,
    empty,
  }
}

// ── internals ───────────────────────────────────────────────────────────────

interface MutableErrors {
  warning: number
  serious: number
  critical: number
}

interface MutableEnergy {
  start: number
  end: number
  inWh: number
  outWh: number
  recorded: boolean
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

/** The first real pack voltage the archive carries, to value solar for a session that kept none. */
function firstVoltage(records: readonly SessionRecord[]): number | null {
  for (const record of records) {
    const voltage = record.finalBattery?.packVoltage
    if (voltage !== undefined && voltage !== null && voltage > 0) return voltage
  }
  return null
}

/** The last instant of an instant's local day, so a custom 'to' covers the whole day it names. */
function endOfLocalDay(at: number): number {
  const date = new Date(at)
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

function tallyErrors(warnings: readonly WarningRecord[], window: TimeWindow): ErrorTally {
  let warning = 0
  let serious = 0
  let critical = 0
  for (const record of warnings) {
    if (record.at < window.from || record.at > window.to) continue
    if (record.level === 'warning') warning += 1
    else if (record.level === 'serious') serious += 1
    else critical += 1
  }
  return { warning, serious, critical, total: warning + serious + critical }
}

function worstLevel(counts: MutableErrors): WarningLevel | null {
  if (counts.critical > 0) return 'critical'
  if (counts.serious > 0) return 'serious'
  if (counts.warning > 0) return 'warning'
  return null
}

function localMidnightDaysBefore(now: number, daysBack: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - daysBack)
  return date.getTime()
}

/** Records an interior break: it is drawn as a band AND nulls any column it crosses. */
function pushGap(gaps: TimeWindow[], breakGaps: TimeWindow[], from: number, to: number): void {
  const gap = { from, to }
  gaps.push(gap)
  breakGaps.push(gap)
}

function emptyColumns(count: number): Accumulator[] {
  return Array.from({ length: count }, () => ({ sum: 0, count: 0 }))
}

function accumulate(column: Accumulator, value: number): void {
  column.sum += value
  column.count += 1
}

function seal(
  columns: readonly Accumulator[],
  columnMs: number,
  window: TimeWindow,
  gaps: readonly TimeWindow[],
): (number | null)[] {
  return columns.map((column, index) => {
    const start = window.from + index * columnMs
    const end = start + columnMs
    if (column.count === 0 || overlapsAnyGap(start, end, gaps)) return null
    return column.sum / column.count
  })
}

/** A column's [start, end) span against every listed gap. Testing the whole span rather than the
 *  centre guarantees a break at any boundary, however narrow — a gap thinner than one column still
 *  falls inside some column's span and nulls it. */
function overlapsAnyGap(start: number, end: number, gaps: readonly TimeWindow[]): boolean {
  for (const gap of gaps) {
    if (start < gap.to && end > gap.from) return true
  }
  return false
}

function everyNull(values: readonly (number | null)[]): boolean {
  return values.every((value) => value === null)
}

function lowerOf(current: number | null, next: number | null): number | null {
  if (next === null) return current
  if (current === null) return next
  return Math.min(current, next)
}

function higherOf(current: number | null, next: number | null): number | null {
  if (next === null) return current
  if (current === null) return next
  return Math.max(current, next)
}
