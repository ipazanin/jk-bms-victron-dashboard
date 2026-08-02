<script setup lang="ts">
/**
 * The pack's own hourly trace: charge, pack voltage and cell spread across the range, as three small
 * multiples over one shared, measured time axis.
 *
 * A step and not a line. Each record is a snapshot taken once an hour, so the value it states holds
 * until the next one replaces it; drawing a slope between two of them would claim a rate of change
 * nobody measured. The trace ends at its last record rather than running on past it.
 *
 * The three terms are three bands on unrelated scales, so they never share a y-axis. Cell spread is
 * a magnitude and its band is anchored at zero; charge and pack voltage are read for their drift, so
 * their bands are the range's own reach rounded outward — a pack sitting between 26.2 V and 27.4 V
 * drawn against a zero-based axis is a flat line that hides the very thing the card is for.
 *
 * Holes are never bridged. `ringTrack` lists the gaps it refused as intervals, and each is drawn on
 * the baseline as a dashed bar with the trace broken across it.
 *
 * Uncertainty is one statement about the whole trace, not a bracket per point. Every record on a
 * ledger shares the same clock correction, so the same half-hour that is unknown for one is unknown
 * for all of them — a bracket at the end of the axis says that once, where error bars on 800 points
 * would say it 800 times and read as noise in the data.
 */
import { computed, ref, watch } from 'vue'

import { volts } from '../../application/format'
import type { RingTrack, RingTrackPoint } from '../../application/history/ringRange'
import { useMeasuredWidth } from '../../application/useMeasuredWidth'
import { extentOf, linearScale, positionOn } from '../../domain/history/geometry'
import type { LinearScale } from '../../domain/history/geometry'

const props = defineProps<{
  /** The window's records, or null before a ledger has been read. */
  track: RingTrack | null
  /** True while a fresh ledger is being read; holds the prior render dimmed rather than flashing. */
  loading?: boolean
}>()

const STRIP_HEIGHT = 46
/** viewBox units held clear at the left rail for the band labels — the TrendStrips gutter. */
const GUTTER = 46
/** A hairline of padding at both edges, so a trace at full band is drawn rather than half-clipped. */
const INSET = 1
/** The newest records the table prints in full, untouched. */
const TABLE_ROWS = 40
/** Below this, the clock correction is tighter than the label would show, and the bracket is not
 *  drawn — the same threshold at which a resolved time stops carrying its own ± on screen. */
const UNCERTAINTY_FLOOR_MS = 60_000

const PERCENT = 100
const CHARGE_BAND_STEP = 5
const VOLTAGE_BAND_STEP = 0.2
const SPREAD_BAND_STEP = 10

/**
 * One viewBox unit is one CSS pixel, so the viewBox is measured rather than fixed: a slope and a
 * stroke width then mean the same thing at 390px and 1440px. Every stroke carries
 * `vector-effect: non-scaling-stroke` so 2px stays 2px whatever the box.
 */
const plot = ref<Element | null>(null)
const plotWidth = useMeasuredWidth(plot)

/** Nothing landed in this window, or nothing has been read yet — the strips are hidden either way. */
const ready = computed(() => props.track !== null && !props.track.empty)
/** A read is in flight and there is not yet anything to hold under it. */
const reading = computed(() => props.loading === true && props.track === null)

const points = computed<readonly RingTrackPoint[]>(() => props.track?.points ?? [])

const timeScale = computed<LinearScale>(() =>
  linearScale(props.track?.window.from ?? 0, props.track?.window.to ?? 1, GUTTER, plotWidth.value),
)

// ── bands ────────────────────────────────────────────────────────────────────

interface Band {
  readonly low: number
  readonly high: number
  readonly scale: LinearScale
}

const chargeBand = computed(() =>
  bandOver(
    points.value.map((point) => point.chargeRatio * PERCENT),
    CHARGE_BAND_STEP,
    false,
  ),
)
const voltageBand = computed(() =>
  bandOver(points.value.map((point) => point.packVoltageV), VOLTAGE_BAND_STEP, false),
)
const spreadBand = computed(() =>
  bandOver(points.value.map((point) => point.cellSpreadMv), SPREAD_BAND_STEP, true),
)

/**
 * The reach the values actually take, rounded outward to a readable step. A band anchored at zero
 * is right for a magnitude and wrong for a reading that never approaches zero, so which one it is
 * is the caller's statement rather than something guessed from the numbers.
 */
function bandOver(values: readonly number[], step: number, fromZero: boolean): Band {
  const extent = extentOf(values)
  const rawLow = fromZero ? 0 : (extent?.min ?? 0)
  const rawHigh = extent?.max ?? 0
  const low = round(Math.floor(rawLow / step) * step)
  // A range that never moved still needs a band with height, or the scale divides by zero.
  const high = round(Math.max(Math.ceil(rawHigh / step) * step, low + step))
  return { low, high, scale: linearScale(low, high, STRIP_HEIGHT - INSET, INSET) }
}

/** Floating-point steps of 0.2 accumulate a tail the rail label would print in full. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

// ── the step traces ──────────────────────────────────────────────────────────

/**
 * Where the trace must break: the intervals `ringTrack` refused as holes. A gap is stated as the
 * span between the two records either side of it, so a pair whose interval a gap covers is a pair
 * the pack has no history between.
 */
function brokenAfter(index: number): boolean {
  const gaps = props.track?.gaps ?? []
  const from = points.value[index]
  const to = points.value[index + 1]
  if (from === undefined || to === undefined) return false
  return gaps.some((gap) => gap.from <= from.at && gap.to >= to.at)
}

/**
 * A run of `M`/`H`/`V` per unbroken stretch: the value holds along its own hour, then steps to the
 * next reading. Nothing is drawn across a break.
 */
function stepPath(values: readonly number[], band: Band): string {
  const parts: string[] = []
  let open = false

  values.forEach((value, index) => {
    const x = positionOn(timeScale.value, points.value[index].at)
    const y = positionOn(band.scale, value)
    if (!open) parts.push(`M${f(x)},${f(y)}`)
    else parts.push(`H${f(x)}V${f(y)}`)
    open = !brokenAfter(index)
  })

  return parts.join('')
}

const chargePath = computed(() =>
  ready.value
    ? stepPath(points.value.map((point) => point.chargeRatio * PERCENT), chargeBand.value)
    : '',
)
const voltagePath = computed(() =>
  ready.value ? stepPath(points.value.map((point) => point.packVoltageV), voltageBand.value) : '',
)
const spreadPath = computed(() =>
  ready.value ? stepPath(points.value.map((point) => point.cellSpreadMv), spreadBand.value) : '',
)

/** The holes, as bars on the strip's own floor, so a break is marked rather than merely left blank. */
const gapRuns = computed(() =>
  (props.track?.gaps ?? []).map((gap) => {
    const from = positionOn(timeScale.value, gap.from)
    return { key: gap.from, x: from, width: positionOn(timeScale.value, gap.to) - from }
  }),
)

// ── the one uncertainty statement ────────────────────────────────────────────

/** The widest half-width on any point in the window: what the whole trace could be shifted by. */
const uncertaintyMs = computed(() =>
  points.value.reduce(
    (widest, point) => (Number.isFinite(point.uncertaintyMs) ? Math.max(widest, point.uncertaintyMs) : widest),
    0,
  ),
)

const bracket = computed(() => {
  const half = uncertaintyMs.value
  if (!ready.value || half < UNCERTAINTY_FLOOR_MS) return null
  const scale = timeScale.value
  const span = scale.to - scale.from
  if (span <= 0) return null
  const halfPx = (half / span) * (scale.end - scale.start)
  const centre = scale.end - Math.min(halfPx, (scale.end - scale.start) / 4)
  return { centre, halfPx: Math.min(halfPx, (scale.end - scale.start) / 4), label: spanLabel(half) }
})

// ── cursor ───────────────────────────────────────────────────────────────────

const cursorIndex = ref<number | null>(null)

watch(
  () => props.track,
  () => {
    cursorIndex.value = null
  },
)

/**
 * The crosshair snaps to a record rather than interpolating between two, so every figure it prints
 * is one the pack actually stored.
 */
const cursor = computed(() => {
  const index = cursorIndex.value
  const point = index === null ? undefined : points.value[index]
  if (point === undefined) return null

  return {
    x: positionOn(timeScale.value, point.at),
    at: stampOf(point),
    chargeY: positionOn(chargeBand.value.scale, point.chargeRatio * PERCENT),
    voltageY: positionOn(voltageBand.value.scale, point.packVoltageV),
    spreadY: positionOn(spreadBand.value.scale, point.cellSpreadMv),
    charge: chargeLabel(point.chargeRatio),
    voltage: volts(point.packVoltageV, 2),
    spread: `${point.cellSpreadMv} mV`,
  }
})

function moveCursor(event: PointerEvent): void {
  const target = event.currentTarget as Element | null
  if (target === null || points.value.length === 0) return

  const box = target.getBoundingClientRect()
  if (box.width === 0) return
  const units = ((event.clientX - box.left) / box.width) * plotWidth.value
  cursorIndex.value = nearestTo(timeAt(units))
}

function timeAt(units: number): number {
  const scale = timeScale.value
  const width = scale.end - scale.start
  if (width === 0) return scale.from
  return scale.from + ((units - scale.start) / width) * (scale.to - scale.from)
}

function nearestTo(at: number): number | null {
  const rows = points.value
  if (rows.length === 0) return null

  let best = 0
  let bestDistance = Math.abs(rows[0].at - at)
  for (let index = 1; index < rows.length; index += 1) {
    const distance = Math.abs(rows[index].at - at)
    if (distance >= bestDistance) continue
    best = index
    bestDistance = distance
  }
  return best
}

function onKeydown(event: KeyboardEvent): void {
  const last = points.value.length - 1
  if (last < 0) return
  const current = cursorIndex.value ?? last

  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      cursorIndex.value = Math.max(0, current - 1)
      break
    case 'ArrowRight':
    case 'ArrowUp':
      cursorIndex.value = Math.min(last, current + 1)
      break
    case 'Home':
      cursorIndex.value = 0
      break
    case 'End':
      cursorIndex.value = last
      break
    case 'Escape':
      cursorIndex.value = null
      return
    default:
      return
  }
  event.preventDefault()
}

function onFocus(): void {
  if (cursorIndex.value === null && points.value.length > 0) {
    cursorIndex.value = points.value.length - 1
  }
}

// ── formatting ───────────────────────────────────────────────────────────────

const stamp = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

/** A record's own instant, carrying its own precision — the raw face is on the receipt below. */
function stampOf(point: RingTrackPoint): string {
  const shown = stamp.format(point.at)
  return point.uncertaintyMs >= UNCERTAINTY_FLOOR_MS ? `${shown} ${spanLabel(point.uncertaintyMs)}` : shown
}

/** A half-width as the reader would say it: '±45 min', '±2 h'. */
function spanLabel(halfWidthMs: number): string {
  const minutes = Math.round(halfWidthMs / 60_000)
  if (minutes < 90) return `±${minutes} min`
  return `±${(minutes / 60).toFixed(1)} h`
}

function chargeLabel(ratio: number): string {
  return `${Math.round(ratio * PERCENT)}%`
}

function f(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '0'
}

const axisEnds = computed(() => {
  const window = props.track?.window
  if (window === undefined) return null
  return { from: stamp.format(window.from), to: stamp.format(window.to) }
})

const tableRows = computed(() =>
  points.value
    .slice(-TABLE_ROWS)
    .reverse()
    .map((point) => ({
      key: point.at,
      at: stamp.format(point.at),
      charge: chargeLabel(point.chargeRatio),
      voltage: volts(point.packVoltageV, 2),
      current: point.currentA.toFixed(1),
      spread: `${point.cellSpreadMv}`,
    })),
)
</script>

<template>
  <section class="card" data-testid="stats-pack-timeline">
    <header class="head">
      <h3 class="plate">Pack over time</h3>
      <p class="muted subtitle">
        Charge, pack voltage and cell spread, one step per stored record.
        <span v-if="gapRuns.length" class="gap-note">···· nothing on record</span>
      </p>
    </header>

    <p v-if="reading" class="state copy">Reading the stored log…</p>
    <p v-else-if="!ready" class="state copy">No records in this range.</p>

    <template v-else>
      <div
        class="strips"
        :class="{ refreshing: loading }"
        role="group"
        aria-label="Pack over time — arrow keys to inspect stored records"
        tabindex="0"
        @pointerleave="cursorIndex = null"
        @keydown="onKeydown"
        @focus="onFocus"
      >
        <div class="strip">
          <span class="key"><i class="swatch charge" />Charge %</span>
          <svg
            ref="plot"
            :viewBox="`0 0 ${plotWidth} ${STRIP_HEIGHT}`"
            role="img"
            :aria-label="`Charge as a percentage of nominal capacity, band ${chargeBand.low} to ${chargeBand.high} percent`"
            @pointermove="moveCursor"
          >
            <text :x="GUTTER - 6" :y="INSET + 8" text-anchor="end" class="band">{{ chargeBand.high }}%</text>
            <text :x="GUTTER - 6" :y="STRIP_HEIGHT - INSET" text-anchor="end" class="band">{{ chargeBand.low }}%</text>

            <line
              v-for="gap in gapRuns"
              :key="gap.key"
              :x1="gap.x"
              :y1="STRIP_HEIGHT - INSET"
              :x2="gap.x + gap.width"
              :y2="STRIP_HEIGHT - INSET"
              class="gap"
            />
            <path :d="chargePath" class="trace charge" />
            <g v-if="cursor">
              <line :x1="cursor.x" y1="0" :x2="cursor.x" :y2="STRIP_HEIGHT" class="crosshair" />
              <circle :cx="cursor.x" :cy="cursor.chargeY" r="2.5" class="dot charge" />
            </g>
          </svg>
        </div>

        <div class="strip">
          <span class="key"><i class="swatch volts" />Pack V</span>
          <svg
            :viewBox="`0 0 ${plotWidth} ${STRIP_HEIGHT}`"
            role="img"
            :aria-label="`Pack voltage, band ${voltageBand.low} to ${voltageBand.high} volts`"
            @pointermove="moveCursor"
          >
            <text :x="GUTTER - 6" :y="INSET + 8" text-anchor="end" class="band">{{ voltageBand.high }} V</text>
            <text :x="GUTTER - 6" :y="STRIP_HEIGHT - INSET" text-anchor="end" class="band">{{ voltageBand.low }} V</text>

            <line
              v-for="gap in gapRuns"
              :key="gap.key"
              :x1="gap.x"
              :y1="STRIP_HEIGHT - INSET"
              :x2="gap.x + gap.width"
              :y2="STRIP_HEIGHT - INSET"
              class="gap"
            />
            <path :d="voltagePath" class="trace volts" />
            <g v-if="cursor">
              <line :x1="cursor.x" y1="0" :x2="cursor.x" :y2="STRIP_HEIGHT" class="crosshair" />
              <circle :cx="cursor.x" :cy="cursor.voltageY" r="2.5" class="dot volts" />
            </g>
          </svg>
        </div>

        <div class="strip">
          <span class="key"><i class="swatch spread" />Spread mV</span>
          <svg
            :viewBox="`0 0 ${plotWidth} ${STRIP_HEIGHT}`"
            role="img"
            :aria-label="`Spread between the highest and lowest cell, band zero to ${spreadBand.high} millivolts`"
            @pointermove="moveCursor"
          >
            <text :x="GUTTER - 6" :y="INSET + 8" text-anchor="end" class="band">{{ spreadBand.high }} mV</text>
            <text :x="GUTTER - 6" :y="STRIP_HEIGHT - INSET" text-anchor="end" class="band">{{ spreadBand.low }}</text>

            <line
              v-for="gap in gapRuns"
              :key="gap.key"
              :x1="gap.x"
              :y1="STRIP_HEIGHT - INSET"
              :x2="gap.x + gap.width"
              :y2="STRIP_HEIGHT - INSET"
              class="gap"
            />
            <path :d="spreadPath" class="trace spread" />
            <g v-if="cursor">
              <line :x1="cursor.x" y1="0" :x2="cursor.x" :y2="STRIP_HEIGHT" class="crosshair" />
              <circle :cx="cursor.x" :cy="cursor.spreadY" r="2.5" class="dot spread" />
            </g>
          </svg>
        </div>

        <!-- One bracket for the whole trace: the clock correction every record on this ledger
             shares, said once at the end of the axis rather than drawn on each of eight hundred
             points. -->
        <svg
          v-if="bracket"
          class="bracket"
          :viewBox="`0 0 ${plotWidth} 18`"
          role="img"
          :aria-label="`Every time on this axis carries the same uncertainty, ${bracket.label}`"
        >
          <line :x1="bracket.centre - bracket.halfPx" y1="9" :x2="bracket.centre + bracket.halfPx" y2="9" />
          <line :x1="bracket.centre - bracket.halfPx" y1="4" :x2="bracket.centre - bracket.halfPx" y2="14" />
          <line :x1="bracket.centre + bracket.halfPx" y1="4" :x2="bracket.centre + bracket.halfPx" y2="14" />
          <text :x="bracket.centre - bracket.halfPx - 6" y="12" text-anchor="end" class="band">
            {{ bracket.label }}
          </text>
        </svg>
      </div>

      <!-- One row in both states, so picking up the crosshair cannot reflow the card underneath it.
           A live region so arrowing the crosshair is announced rather than read silently. -->
      <p
        class="axis muted"
        role="status"
        aria-live="polite"
        :class="{ tracking: cursor !== null }"
        :style="{ paddingLeft: `${GUTTER}px` }"
      >
        <template v-if="cursor">
          <span>{{ cursor.at }}</span>
          <span>charge {{ cursor.charge }}</span>
          <span>{{ cursor.voltage }}</span>
          <span>spread {{ cursor.spread }}</span>
        </template>
        <template v-else-if="axisEnds">
          <span>{{ axisEnds.from }}</span>
          <span>{{ axisEnds.to }}</span>
        </template>
      </p>
    </template>

    <details class="numbers">
      <summary>Show the numbers</summary>
      <div class="table-scroll">
        <table class="grid">
          <caption class="muted">
            The newest {{ tableRows.length }} stored records. Each is one snapshot the pack took;
            nothing here is averaged or bridged across a hole.
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Charge</th>
              <th scope="col">Pack V</th>
              <th scope="col">A</th>
              <th scope="col">Spread mV</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="tableRows.length === 0">
              <td colspan="5">— no records —</td>
            </tr>
            <tr v-for="row in tableRows" :key="row.key">
              <td>{{ row.at }}</td>
              <td>{{ row.charge }}</td>
              <td>{{ row.voltage }}</td>
              <td>{{ row.current }}</td>
              <td>{{ row.spread }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </section>
</template>

<style scoped>
.card {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
  padding: var(--pad);
}

.head {
  margin-bottom: 1rem;
}

.head h3 {
  margin: 0;
}

.subtitle {
  margin: 0.35rem 0 0;
}

.gap-note {
  margin-left: 0.5rem;
}

.strips {
  outline-offset: 4px;
  transition: opacity var(--dur) var(--ease);
}

/* A refetch holds the prior render dimmed rather than flashing an empty skeleton. */
.strips.refreshing {
  opacity: 0.55;
}

.strip {
  display: grid;
  grid-template-columns: 6.5rem 1fr;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.6rem;
}

/* The viewBox is measured to match this box, so the two must not disagree about the height. */
.strip svg {
  width: 100%;
  height: 46px;
  display: block;
  overflow: visible;
  touch-action: pan-y;
}

.key {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--ink-secondary);
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex: none;
}

.swatch.charge {
  background: var(--pack);
}
.swatch.volts {
  background: var(--ink-secondary);
}
.swatch.spread {
  background: var(--solar);
}

.band {
  font-family: var(--font-mono);
  font-size: 10px;
  fill: var(--ink-muted);
}

/* A hole in the record, drawn on the floor the trace would otherwise have crossed. */
.gap {
  stroke: var(--gridline);
  stroke-width: 2;
  stroke-dasharray: 2 3;
  vector-effect: non-scaling-stroke;
}

.crosshair {
  stroke: var(--baseline);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.trace {
  fill: none;
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
  stroke-linejoin: miter;
  stroke-linecap: butt;
}

.trace.charge,
.dot.charge {
  stroke: var(--pack);
}
.trace.volts,
.dot.volts {
  stroke: var(--ink-secondary);
}
.trace.spread,
.dot.spread {
  stroke: var(--solar);
}

.dot {
  fill: var(--surface);
  stroke-width: 2;
}

.bracket {
  width: 100%;
  height: 18px;
  display: block;
  overflow: visible;
}

.bracket line {
  stroke: var(--baseline);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.axis {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.25rem 1.25rem;
  margin: 0.2rem 0 0;
}

.axis.tracking {
  justify-content: flex-start;
}

.state {
  margin: 0.5rem 0 0;
}

.numbers {
  margin-top: 1rem;
  border-top: 1px solid var(--gridline);
}

/* Every control on the page clears the same touch target. */
.numbers summary {
  display: flex;
  align-items: center;
  min-height: var(--tap, 44px);
  font-family: var(--font-label);
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  color: var(--ink-secondary);
}

.numbers summary:hover {
  color: var(--ink);
}

/* The one wide child scrolls inside its own box; the card body never scrolls sideways. */
.table-scroll {
  overflow-x: auto;
}

.grid {
  width: 100%;
  min-width: 24rem;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 0.8125rem;
}

.grid caption {
  text-align: left;
  margin-bottom: 0.5rem;
}

.grid th,
.grid td {
  text-align: right;
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid var(--gridline);
}

.grid th:first-child,
.grid td:first-child {
  text-align: left;
}

.grid th {
  color: var(--ink-muted);
  font-weight: 500;
}

@media (max-width: 720px) {
  .strip {
    grid-template-columns: 5.5rem 1fr;
  }
}
</style>
