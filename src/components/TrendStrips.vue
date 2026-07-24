<script setup lang="ts">
/**
 * Three small multiples over one shared time axis.
 *
 * Pack current, PV power and house power have different units and different scales, so they never
 * share a y-axis. Each strip gets its own baseline: pack current is centre-zero because it is
 * signed; the two power strips run from zero because they are magnitudes.
 *
 * Every strip states its band. A chart normalised to whatever the window happens to hold draws a
 * ±0.2 A ripple and a ±40 A swing identically, and re-maps the whole trace vertically the moment
 * an extreme scrolls out — so the band comes off a ladder of round stops, printed at the left rail,
 * and it holds until the data genuinely leaves it. The time axis is deliberately not quantised: it
 * slides by well under a pixel per sample, and a trend that advanced in jumps would read worse.
 *
 * A tick that passed with no sample is drawn as a hole. A straight line across a three-minute BLE
 * stall asserts a reading nobody took, which is the one thing a trend must not do.
 */
import { computed, onScopeDispose, ref, watch } from 'vue'

import { amps, clockTime, watts } from '../application/format'
import type { TrendPoint } from '../application/telemetry'
import { bandPath, linearScale, maxMagnitudeOf, positionOn, tracePath } from '../domain/history/geometry'
import type { BandPoint, LinearScale, TracePoint } from '../domain/history/geometry'
import { MAX_SAMPLE_GAP_MS } from '../domain/history/join'
import { CURRENT_LADDER, POWER_LADDER, nextStop } from '../domain/scaleLadder'

const props = defineProps<{ history: TrendPoint[] }>()

const STRIP_HEIGHT = 46
/** viewBox units held clear at the left rail for the band labels. */
const GUTTER = 46
/** A hairline of padding at both edges, so a trace at full band is drawn rather than half-clipped. */
const INSET = 1
/** Only ever the first frame's width: the observer answers before anything is painted twice. */
const FALLBACK_WIDTH = 640

/**
 * One viewBox unit is one CSS pixel, which is why the viewBox is measured rather than fixed. Under
 * `preserveAspectRatio="none"` the same strip rendered near 20:1 on a desktop and 2:1 on a phone,
 * so a slope carried no meaning across breakpoints and the stroke width stretched with the box.
 */
const plot = ref<Element | null>(null)
const plotWidth = ref(FALLBACK_WIDTH)
let observer: ResizeObserver | null = null

watch(plot, (element) => {
  observer?.disconnect()
  observer = null
  if (element === null || typeof ResizeObserver === 'undefined') return

  observer = new ResizeObserver((entries) => {
    const measured = entries[0]?.contentRect.width ?? 0
    if (measured > 0) plotWidth.value = Math.round(measured)
  })
  observer.observe(element)
})

onScopeDispose(() => observer?.disconnect())

const hasSolar = computed(() => props.history.some((point) => point.pvPower !== null))
const hasHouse = computed(() => props.history.some((point) => point.housePower !== null))

const span = computed(() => {
  const points = props.history
  if (points.length < 2) return null
  return { start: points[0].at, end: points[points.length - 1].at }
})

const spanLabel = computed(() => {
  const window = span.value
  if (window === null) return 'Trend'
  const seconds = Math.round((window.end - window.start) / 1000)
  return seconds < 90 ? `Last ${seconds} s` : `Last ${Math.round(seconds / 60)} min`
})

const timeScale = computed<LinearScale>(() =>
  linearScale(span.value?.start ?? 0, span.value?.end ?? 1, GUTTER, plotWidth.value),
)

/** Yields one column of the history without materialising it, so no reduction ever spreads a
 *  series into a call: measured on V8, 100,000 arguments pass and 125,000 throw RangeError. */
function* column(pick: (point: TrendPoint) => number | null): Generator<number | null> {
  for (const point of props.history) yield pick(point)
}

/*
 * The bands. Each holds its own stop between samples: growth is immediate, because clipping a real
 * excursion is worse than a re-map, and release waits until the data sits comfortably inside a
 * smaller stop. An emptied history reaches the ladder as a reach of zero and releases to the
 * bottom stop by the same rule, so there is no separate reset to keep in step with this one.
 */
const packBand = ref(CURRENT_LADDER.stops[0])
const pvBand = ref(POWER_LADDER.stops[0])
const houseBand = ref(POWER_LADDER.stops[0])

watch(
  () => maxMagnitudeOf(column((point) => point.packCurrent)),
  (reach) => (packBand.value = nextStop(CURRENT_LADDER, packBand.value, reach)),
  { immediate: true },
)
watch(
  () => maxMagnitudeOf(column((point) => point.pvPower)),
  (reach) => (pvBand.value = nextStop(POWER_LADDER, pvBand.value, reach)),
  { immediate: true },
)
watch(
  () => maxMagnitudeOf(column((point) => point.housePower)),
  (reach) => (houseBand.value = nextStop(POWER_LADDER, houseBand.value, reach)),
  { immediate: true },
)

const packValue = computed(() =>
  linearScale(-packBand.value, packBand.value, STRIP_HEIGHT - INSET, INSET),
)
const pvValue = computed(() => linearScale(0, pvBand.value, STRIP_HEIGHT - INSET, INSET))
const houseValue = computed(() => linearScale(0, houseBand.value, STRIP_HEIGHT - INSET, INSET))

/**
 * The history with a break inserted wherever a sample interval passed unreported. The bound is the
 * archive's own: the live strip and a stored session's ribbon call the same span unknown.
 */
function* traced(pick: (point: TrendPoint) => number | null): Generator<TracePoint> {
  let previousAt: number | null = null
  for (const point of props.history) {
    if (previousAt !== null && point.at - previousAt > MAX_SAMPLE_GAP_MS) {
      yield { at: previousAt, value: null }
    }
    yield { at: point.at, value: pick(point) }
    previousAt = point.at
  }
}

const packPath = computed(() =>
  tracePath(traced((point) => point.packCurrent), timeScale.value, packValue.value),
)
const pvPath = computed(() =>
  tracePath(traced((point) => point.pvPower), timeScale.value, pvValue.value),
)
const housePath = computed(() =>
  tracePath(traced((point) => point.housePower), timeScale.value, houseValue.value),
)

/**
 * The same trace closed to its strip's zero line, so a low-alpha gradient can wash the area beneath
 * it. It breaks at the identical gaps — a null upper closes the run in `bandPath` exactly where the
 * trace opens — and never fabricates fill across a stall the line itself refuses to cross.
 */
function* area(pick: (point: TrendPoint) => number | null): Generator<BandPoint> {
  let previousAt: number | null = null
  for (const point of props.history) {
    if (previousAt !== null && point.at - previousAt > MAX_SAMPLE_GAP_MS) {
      yield { at: previousAt, lower: null, upper: null }
    }
    const value = pick(point)
    yield { at: point.at, upper: value, lower: value === null ? null : 0 }
    previousAt = point.at
  }
}

const packArea = computed(() =>
  bandPath(area((point) => point.packCurrent), timeScale.value, packValue.value),
)
const pvArea = computed(() =>
  bandPath(area((point) => point.pvPower), timeScale.value, pvValue.value),
)
const houseArea = computed(() =>
  bandPath(area((point) => point.housePower), timeScale.value, houseValue.value),
)

/** Where the traces are broken, so the hole is marked rather than merely left blank. */
const gaps = computed(() => {
  const runs: { readonly x: number; readonly width: number }[] = []
  let previousAt: number | null = null

  for (const point of props.history) {
    if (previousAt !== null && point.at - previousAt > MAX_SAMPLE_GAP_MS) {
      const from = positionOn(timeScale.value, previousAt)
      runs.push({ x: from, width: positionOn(timeScale.value, point.at) - from })
    }
    previousAt = point.at
  }
  return runs
})

const packZeroY = computed(() => positionOn(packValue.value, 0))
const pvZeroY = computed(() => positionOn(pvValue.value, 0))
const houseZeroY = computed(() => positionOn(houseValue.value, 0))

const cursorIndex = ref<number | null>(null)

/**
 * The crosshair snaps to a sample rather than interpolating between two, so every figure it prints
 * is one a radio reported at the instant named beside it.
 */
const cursor = computed(() => {
  const index = cursorIndex.value
  if (index === null || index >= props.history.length) return null
  const point = props.history[index]

  return {
    x: positionOn(timeScale.value, point.at),
    at: stamp(point.at),
    packCurrent: point.packCurrent,
    pack: amps(point.packCurrent),
    pvPower: point.pvPower,
    pv: point.pvPower === null ? '—' : watts(point.pvPower),
    housePower: point.housePower,
    house: point.housePower === null ? '—' : watts(point.housePower),
  }
})

function moveCursor(event: PointerEvent): void {
  const target = event.currentTarget as Element | null
  if (target === null || props.history.length === 0) return

  const box = target.getBoundingClientRect()
  if (box.width === 0) return
  cursorIndex.value = nearestIndexTo(timeAt(((event.clientX - box.left) / box.width) * plotWidth.value))
}

function timeAt(units: number): number {
  const scale = timeScale.value
  const width = scale.end - scale.start
  if (width === 0) return scale.from
  return scale.from + ((units - scale.start) / width) * (scale.to - scale.from)
}

function nearestIndexTo(at: number): number {
  const points = props.history
  let best = 0
  let bestDistance = Math.abs(points[0].at - at)

  for (let index = 1; index < points.length; index += 1) {
    const distance = Math.abs(points[index].at - at)
    if (distance >= bestDistance) continue
    best = index
    bestDistance = distance
  }
  return best
}

/** Seconds are printed, not implied: this window is minutes long and a minute holds sixty rows. */
function stamp(at: number): string {
  const time = new Date(at)
  const minutes = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  return `${minutes}:${String(time.getSeconds()).padStart(2, '0')}`
}

const latest = computed(() => props.history[props.history.length - 1] ?? null)

const nowPack = computed(() => {
  const point = latest.value
  return point === null ? '—' : amps(point.packCurrent)
})
const nowPv = computed(() => {
  const point = latest.value
  return point === null || point.pvPower === null ? '—' : watts(point.pvPower)
})
const nowHouse = computed(() => {
  const point = latest.value
  return point === null || point.housePower === null ? '—' : watts(point.housePower)
})

const tableRows = computed(() => props.history.slice(-40).reverse())
</script>

<template>
  <section class="panel">
    <header>
      <h2 class="plate">{{ spanLabel }}</h2>
      <p v-if="gaps.length" class="muted">···· no samples</p>
    </header>

    <p v-if="history.length < 2" class="empty">Collecting samples…</p>

    <template v-else>
      <div class="strips" @pointerleave="cursorIndex = null">
        <div class="strip">
          <span class="key"><i class="swatch pack" />Pack A</span>
          <svg
            ref="plot"
            :viewBox="`0 0 ${plotWidth} ${STRIP_HEIGHT}`"
            role="img"
            :aria-label="`Pack current, ${spanLabel.toLowerCase()}, band plus or minus ${packBand} amps`"
            @pointermove="moveCursor"
          >
            <defs>
              <linearGradient id="trend-fill-pack" x1="0" y1="0" x2="0" y2="1">
                <stop class="fill-top pack" offset="0" />
                <stop class="fill-bottom pack" offset="1" />
              </linearGradient>
            </defs>
            <path :d="packArea" class="area pack" fill="url(#trend-fill-pack)" />

            <text :x="GUTTER - 6" :y="INSET + 8" text-anchor="end" class="band">±{{ packBand }} A</text>
            <text :x="GUTTER - 6" :y="packZeroY" text-anchor="end" class="band">0</text>

            <line :x1="GUTTER" :y1="packZeroY" :x2="plotWidth" :y2="packZeroY" class="zero" />
            <line
              v-for="gap in gaps"
              :key="gap.x"
              :x1="gap.x"
              :y1="packZeroY"
              :x2="gap.x + gap.width"
              :y2="packZeroY"
              class="gap"
            />
            <path :d="packPath" class="trace pack" />
            <g v-if="cursor">
              <line :x1="cursor.x" y1="0" :x2="cursor.x" :y2="STRIP_HEIGHT" class="crosshair" />
              <circle
                :cx="cursor.x"
                :cy="positionOn(packValue, cursor.packCurrent)"
                r="2.5"
                class="dot pack"
              />
            </g>
          </svg>
          <span class="now readout">{{ nowPack }}</span>
        </div>

        <div v-if="hasSolar" class="strip">
          <span class="key"><i class="swatch solar" />PV W</span>
          <svg
            :viewBox="`0 0 ${plotWidth} ${STRIP_HEIGHT}`"
            role="img"
            :aria-label="`Solar input power, ${spanLabel.toLowerCase()}, band zero to ${pvBand} watts`"
            @pointermove="moveCursor"
          >
            <defs>
              <linearGradient id="trend-fill-solar" x1="0" y1="0" x2="0" y2="1">
                <stop class="fill-top solar" offset="0" />
                <stop class="fill-bottom solar" offset="1" />
              </linearGradient>
            </defs>
            <path :d="pvArea" class="area solar" fill="url(#trend-fill-solar)" />

            <text :x="GUTTER - 6" :y="INSET + 8" text-anchor="end" class="band">{{ pvBand }} W</text>
            <text :x="GUTTER - 6" :y="pvZeroY" text-anchor="end" class="band">0</text>

            <line :x1="GUTTER" :y1="pvZeroY" :x2="plotWidth" :y2="pvZeroY" class="zero" />
            <line
              v-for="gap in gaps"
              :key="gap.x"
              :x1="gap.x"
              :y1="pvZeroY"
              :x2="gap.x + gap.width"
              :y2="pvZeroY"
              class="gap"
            />
            <path :d="pvPath" class="trace solar" />
            <g v-if="cursor">
              <line :x1="cursor.x" y1="0" :x2="cursor.x" :y2="STRIP_HEIGHT" class="crosshair" />
              <circle
                v-if="cursor.pvPower !== null"
                :cx="cursor.x"
                :cy="positionOn(pvValue, cursor.pvPower)"
                r="2.5"
                class="dot solar"
              />
            </g>
          </svg>
          <span class="now readout">{{ nowPv }}</span>
        </div>

        <div v-if="hasHouse" class="strip">
          <span class="key"><i class="swatch house" />Boat W</span>
          <svg
            :viewBox="`0 0 ${plotWidth} ${STRIP_HEIGHT}`"
            role="img"
            :aria-label="`Boat load power, ${spanLabel.toLowerCase()}, band zero to ${houseBand} watts`"
            @pointermove="moveCursor"
          >
            <defs>
              <linearGradient id="trend-fill-house" x1="0" y1="0" x2="0" y2="1">
                <stop class="fill-top house" offset="0" />
                <stop class="fill-bottom house" offset="1" />
              </linearGradient>
            </defs>
            <path :d="houseArea" class="area house" fill="url(#trend-fill-house)" />

            <text :x="GUTTER - 6" :y="INSET + 8" text-anchor="end" class="band">{{ houseBand }} W</text>
            <text :x="GUTTER - 6" :y="houseZeroY" text-anchor="end" class="band">0</text>

            <line :x1="GUTTER" :y1="houseZeroY" :x2="plotWidth" :y2="houseZeroY" class="zero" />
            <line
              v-for="gap in gaps"
              :key="gap.x"
              :x1="gap.x"
              :y1="houseZeroY"
              :x2="gap.x + gap.width"
              :y2="houseZeroY"
              class="gap"
            />
            <path :d="housePath" class="trace house" />
            <g v-if="cursor">
              <line :x1="cursor.x" y1="0" :x2="cursor.x" :y2="STRIP_HEIGHT" class="crosshair" />
              <circle
                v-if="cursor.housePower !== null"
                :cx="cursor.x"
                :cy="positionOn(houseValue, cursor.housePower)"
                r="2.5"
                class="dot house"
              />
            </g>
          </svg>
          <span class="now readout">{{ nowHouse }}</span>
        </div>
      </div>

      <!-- One row in both states, so picking up the crosshair cannot move the panel underneath it. -->
      <p class="axis muted" :class="{ tracking: cursor !== null }" :style="{ paddingLeft: `${GUTTER}px` }">
        <template v-if="cursor">
          <span>{{ cursor.at }}</span>
          <span>pack {{ cursor.pack }}</span>
          <span v-if="hasSolar">PV {{ cursor.pv }}</span>
          <span v-if="hasHouse">boat {{ cursor.house }}</span>
        </template>
        <template v-else-if="span">
          <span>{{ clockTime(span.start) }}</span>
          <span>{{ clockTime(span.end) }}</span>
        </template>
      </p>
    </template>

    <details class="numbers">
      <summary>Show the numbers</summary>
      <div class="table-scroll">
        <table class="twin">
          <caption class="muted">
            The newest {{ tableRows.length }} of {{ history.length }} samples. Nothing here is
            averaged or thinned.
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Pack A</th>
              <th scope="col">PV W</th>
              <th scope="col">Boat W</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="tableRows.length === 0">
              <td colspan="4">— no samples —</td>
            </tr>
            <tr v-for="row in tableRows" :key="row.at">
              <td>{{ stamp(row.at) }}</td>
              <td>{{ row.packCurrent.toFixed(2) }}</td>
              <td>{{ row.pvPower === null ? '—' : Math.round(row.pvPower) }}</td>
              <td>{{ row.housePower === null ? '—' : Math.round(row.housePower) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </section>
</template>

<style scoped>
.panel {
  padding: var(--pad);
}

header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}

h2 {
  margin: 0;
}

header .muted {
  margin: 0;
}

.strip {
  display: grid;
  grid-template-columns: 6.5rem 1fr 4.5rem;
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
}

.swatch.pack {
  background: var(--pack);
}
.swatch.solar {
  background: var(--solar);
}
.swatch.house {
  background: var(--house);
}

.band {
  font-family: var(--font-mono);
  font-size: 10px;
  fill: var(--ink-muted);
}

/*
 * Decorative wash under each trace: SUPPORT, not identity. The gradient stops carry the entity hue
 * and its 0.18 → 0 alpha through CSS, because var() does not resolve inside an SVG presentation
 * attribute. objectBoundingBox (the default) keeps the fill strongest at the crest and fading to
 * the baseline; the solid stroke above still carries the reading.
 */
.area {
  stroke: none;
}

.fill-top.pack {
  stop-color: var(--pack);
  stop-opacity: 0.18;
}
.fill-bottom.pack {
  stop-color: var(--pack);
  stop-opacity: 0;
}
.fill-top.solar {
  stop-color: var(--solar);
  stop-opacity: 0.18;
}
.fill-bottom.solar {
  stop-color: var(--solar);
  stop-opacity: 0;
}
.fill-top.house {
  stop-color: var(--house);
  stop-opacity: 0.18;
}
.fill-bottom.house {
  stop-color: var(--house);
  stop-opacity: 0;
}

.zero {
  stroke: var(--gridline);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

/* A hole in the record, drawn on the line the trace would otherwise have crossed. */
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
  stroke-linejoin: round;
  stroke-linecap: round;
}

.trace.pack,
.dot.pack {
  stroke: var(--pack);
}
.trace.solar,
.dot.solar {
  stroke: var(--solar);
}
.trace.house,
.dot.house {
  stroke: var(--house);
}

.dot {
  fill: var(--card);
  stroke-width: 2;
}

.now {
  text-align: right;
  color: var(--ink);
}

.axis {
  display: flex;
  justify-content: space-between;
  margin: 0 5.25rem 0 7.25rem;
}

.axis.tracking {
  justify-content: flex-start;
  gap: 1.25rem;
}

.empty {
  margin: 0;
  color: var(--ink-muted);
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

/* The table fits at every width today; this keeps it in its own scroll box so a future column can
   never push the page body sideways, matching the Stats tables. */
.table-scroll {
  overflow-x: auto;
}

.twin {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 0.8125rem;
}

.twin caption {
  text-align: left;
  margin-bottom: 0.5rem;
}

.twin th,
.twin td {
  text-align: right;
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid var(--gridline);
}

.twin th:first-child,
.twin td:first-child {
  text-align: left;
}

.twin th {
  color: var(--ink-muted);
  font-weight: 500;
}

@media (max-width: 720px) {
  .strip {
    grid-template-columns: 5.5rem 1fr 4rem;
  }
  .axis {
    margin: 0 4.75rem 0 6.25rem;
  }
}
</style>
