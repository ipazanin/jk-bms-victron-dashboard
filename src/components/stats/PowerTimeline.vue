<script setup lang="ts">
/**
 * The stored, scrubbable sibling of the live TrendStrips: pack, solar and house power across an
 * hour or a day, drawn as three small multiples over one shared, measured time axis.
 *
 * The three terms are three scales — pack power is signed (centre-zero), solar and house are
 * magnitudes on unrelated bands — so they never share a y-axis. Each strip prints its own band off
 * `niceStep`. Unlike the live instrument there is no hysteresis ladder: a stored axis is a pure
 * function of the window's own reach, because a scrubbed instant must read against one scale however
 * it was scrolled into view.
 *
 * The tracks arrive already downsampled and already honest about holes: `statsRange.powerTracks`
 * nulls any column whose centre falls in a gap or that caught no reading, and lists the gaps
 * outright. A null breaks the trace and the fill rather than bridging it, and the gap is drawn on the
 * zero line as a dashed hole — a straight line across a stall would assert a reading nobody took.
 */
import { computed, onScopeDispose, ref, watch } from 'vue'

import { clockTime, watts } from '../../application/format'
import type { PowerTracks } from '../../application/history/statsRange'
import {
  bandPath,
  centredAxis,
  extentOf,
  linearScale,
  maxMagnitudeOf,
  positionOn,
  signedAxis,
  tracePath,
} from '../../domain/history/geometry'
import type { BandPoint, LinearScale, TracePoint } from '../../domain/history/geometry'

const props = defineProps<{
  /** The columnar power tracks for the window, or null before the first read completes. */
  tracks: PowerTracks | null
  range: 'hour' | 'day'
  /** True while a fresh window is being read; holds the prior render dimmed rather than flashing. */
  loading?: boolean
}>()

const STRIP_HEIGHT = 46
/** viewBox units held clear at the left rail for the band labels — the TrendStrips gutter. */
const GUTTER = 46
/** A hairline of padding at both edges, so a trace at full band is drawn rather than half-clipped. */
const INSET = 1
/** Only ever the first frame's width: the observer answers before anything is painted twice. */
const FALLBACK_WIDTH = 640
/** The newest columns the table prints in full, untouched. */
const TABLE_ROWS = 40

/**
 * One viewBox unit is one CSS pixel, so the viewBox is measured rather than fixed: a slope and a
 * stroke width then mean the same thing at 390px and 1440px. Every stroke carries
 * `vector-effect: non-scaling-stroke` so 2px stays 2px whatever the box.
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

/** Nothing plausible landed, or nothing has been read yet — the strips are hidden either way. */
const ready = computed(() => props.tracks !== null && !props.tracks.empty)
/** A read is in flight and there is not yet anything to hold under it. */
const reading = computed(() => props.loading === true && props.tracks === null)

const hasSolar = computed(() => (props.tracks?.pv ?? []).some((value) => value !== null))
const hasHouse = computed(() => (props.tracks?.house ?? []).some((value) => value !== null))

const subtitle = computed(() =>
  props.range === 'hour'
    ? 'Pack, solar and boat power across the last hour, per stored sample.'
    : 'Pack, solar and boat power across the last 24 hours, per stored sample.',
)

/** The centre instant of a column, matching how `powerTracks` nulls a column by its own centre. */
function centreAt(index: number): number {
  const tracks = props.tracks
  if (tracks === null) return 0
  return tracks.window.from + (index + 0.5) * tracks.columnMs
}

const timeScale = computed<LinearScale>(() =>
  linearScale(props.tracks?.window.from ?? 0, props.tracks?.window.to ?? 1, GUTTER, plotWidth.value),
)

/*
 * Each strip's band, off the window's own reach. Pack is centre-zero because its power is signed;
 * solar and house run from zero because they are magnitudes. An absent series reaches the axis as a
 * reach of zero, but such a strip is hidden anyway, so the degenerate band is never drawn.
 */
const packAxis = computed(() => centredAxis(maxMagnitudeOf(props.tracks?.pack ?? [])))
const pvAxis = computed(() => signedAxis(extentOf(props.tracks?.pv ?? [])))
const houseAxis = computed(() => signedAxis(extentOf(props.tracks?.house ?? [])))

const packValue = computed(() =>
  linearScale(packAxis.value.low, packAxis.value.high, STRIP_HEIGHT - INSET, INSET),
)
const pvValue = computed(() =>
  linearScale(pvAxis.value.low, pvAxis.value.high, STRIP_HEIGHT - INSET, INSET),
)
const houseValue = computed(() =>
  linearScale(houseAxis.value.low, houseAxis.value.high, STRIP_HEIGHT - INSET, INSET),
)

const packZeroY = computed(() => positionOn(packValue.value, 0))
const pvZeroY = computed(() => positionOn(pvValue.value, 0))
const houseZeroY = computed(() => positionOn(houseValue.value, 0))

function tracePoints(values: readonly (number | null)[]): TracePoint[] {
  return values.map((value, index) => ({ at: centreAt(index), value }))
}

/** The closed ribbon between the zero baseline and the trace — area-under-curve, broken at holes. */
function bandPoints(values: readonly (number | null)[]): BandPoint[] {
  return values.map((value, index) => ({ at: centreAt(index), lower: 0, upper: value }))
}

const packPath = computed(() =>
  ready.value ? tracePath(tracePoints(props.tracks!.pack), timeScale.value, packValue.value) : '',
)
const pvPath = computed(() =>
  ready.value ? tracePath(tracePoints(props.tracks!.pv), timeScale.value, pvValue.value) : '',
)
const housePath = computed(() =>
  ready.value ? tracePath(tracePoints(props.tracks!.house), timeScale.value, houseValue.value) : '',
)

const packArea = computed(() =>
  ready.value ? bandPath(bandPoints(props.tracks!.pack), timeScale.value, packValue.value) : '',
)
const pvArea = computed(() =>
  ready.value ? bandPath(bandPoints(props.tracks!.pv), timeScale.value, pvValue.value) : '',
)
const houseArea = computed(() =>
  ready.value ? bandPath(bandPoints(props.tracks!.house), timeScale.value, houseValue.value) : '',
)

/** The holes, as bars on the zero line, so a break is marked rather than merely left blank. */
const gapRuns = computed(() =>
  (props.tracks?.gaps ?? []).map((gap) => {
    const from = positionOn(timeScale.value, gap.from)
    return { key: gap.from, x: from, width: positionOn(timeScale.value, gap.to) - from }
  }),
)

/** The columns that actually carry a reading — the crosshair snaps only to these, never a hole. */
const populated = computed(() => {
  const tracks = props.tracks
  if (tracks === null) return []
  const indices: number[] = []
  for (let index = 0; index < tracks.pack.length; index += 1) {
    if (tracks.pack[index] !== null || tracks.pv[index] !== null || tracks.house[index] !== null) {
      indices.push(index)
    }
  }
  return indices
})

const cursorIndex = ref<number | null>(null)

watch(
  () => props.tracks,
  () => {
    cursorIndex.value = null
  },
)

/**
 * The crosshair snaps to a column rather than interpolating between two, so every figure it prints
 * is one the archive actually stored for that span. A field null in the snapped column shows '—'
 * and draws no dot, exactly as a strip that never reported shows nothing.
 */
const cursor = computed(() => {
  const index = cursorIndex.value
  const tracks = props.tracks
  if (index === null || tracks === null || index >= tracks.pack.length) return null

  const packW = tracks.pack[index]
  const pvW = tracks.pv[index]
  const houseW = tracks.house[index]

  return {
    x: positionOn(timeScale.value, centreAt(index)),
    at: clockLabel(centreAt(index)),
    packW,
    pvW,
    houseW,
    pack: packW === null ? '—' : signedWatts(packW),
    pv: pvW === null ? '—' : watts(pvW),
    house: houseW === null ? '—' : watts(houseW),
  }
})

function moveCursor(event: PointerEvent): void {
  const target = event.currentTarget as Element | null
  if (target === null || populated.value.length === 0) return

  const box = target.getBoundingClientRect()
  if (box.width === 0) return
  const units = ((event.clientX - box.left) / box.width) * plotWidth.value
  cursorIndex.value = nearestPopulatedTo(timeAt(units))
}

function timeAt(units: number): number {
  const scale = timeScale.value
  const width = scale.end - scale.start
  if (width === 0) return scale.from
  return scale.from + ((units - scale.start) / width) * (scale.to - scale.from)
}

function nearestPopulatedTo(at: number): number | null {
  const columns = populated.value
  if (columns.length === 0) return null

  let best = columns[0]
  let bestDistance = Math.abs(centreAt(best) - at)
  for (let cursor = 1; cursor < columns.length; cursor += 1) {
    const distance = Math.abs(centreAt(columns[cursor]) - at)
    if (distance >= bestDistance) continue
    best = columns[cursor]
    bestDistance = distance
  }
  return best
}

/** Arrow keys walk the populated columns; Home/End jump to the ends. Focus follows the same holes
 *  the pointer snaps to, so the two cursors can never land somewhere the archive has no reading. */
function onKeydown(event: KeyboardEvent): void {
  const columns = populated.value
  if (columns.length === 0) return

  let position = cursorIndex.value === null ? columns.length - 1 : columns.indexOf(cursorIndex.value)
  if (position < 0) position = columns.length - 1

  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      position = Math.max(0, position - 1)
      break
    case 'ArrowRight':
    case 'ArrowUp':
      position = Math.min(columns.length - 1, position + 1)
      break
    case 'Home':
      position = 0
      break
    case 'End':
      position = columns.length - 1
      break
    default:
      return
  }

  event.preventDefault()
  cursorIndex.value = columns[position]
}

function onFocus(): void {
  if (cursorIndex.value === null && populated.value.length > 0) {
    cursorIndex.value = populated.value[populated.value.length - 1]
  }
}

/**
 * Signed watts with the sign decided AFTER rounding, so a reading that rounds to zero carries no
 * direction — the negative-zero guard the whole dashboard applies to signed figures.
 */
function signedWatts(value: number): string {
  const rounded = Math.round(value)
  const normalised = rounded === 0 ? 0 : rounded
  const sign = normalised > 0 ? '+' : normalised < 0 ? '−' : ''
  return `${sign}${Math.abs(normalised)} W`
}

/** The same guard for a bare signed integer in the table, where the header already carries the unit. */
function signedCell(value: number | null): string {
  if (value === null) return '—'
  const rounded = Math.round(value)
  return `${rounded === 0 ? 0 : rounded}`
}

function magnitudeCell(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}`
}

/** Seconds only where the columns are seconds wide (hour), minutes where they are minutes (day). */
function clockLabel(at: number): string {
  const time = new Date(at)
  const hhmm = `${pad(time.getHours())}:${pad(time.getMinutes())}`
  return props.range === 'hour' ? `${hhmm}:${pad(time.getSeconds())}` : hhmm
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

const tableRows = computed(() => {
  const tracks = props.tracks
  if (tracks === null) return []
  return populated.value
    .slice(-TABLE_ROWS)
    .reverse()
    .map((index) => ({
      key: index,
      at: clockLabel(centreAt(index)),
      pack: signedCell(tracks.pack[index]),
      pv: magnitudeCell(tracks.pv[index]),
      house: magnitudeCell(tracks.house[index]),
    }))
})
</script>

<template>
  <section class="card" data-testid="stats-power-timeline">
    <header class="head">
      <h3 class="plate">Power over time</h3>
      <p class="muted subtitle">
        {{ subtitle }}
        <span v-if="gapRuns.length" class="gap-note">···· no samples</span>
      </p>
    </header>

    <!-- SVG gradients are document-global by id, so one hidden defs block feeds every strip. Setting
         the stops in CSS keeps them theme-aware: the token hue re-resolves with the light block. -->
    <svg class="gradient-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="fill-pack" class="grad grad-pack" x1="0" y1="0" x2="0" y2="1">
          <stop class="top" offset="0" />
          <stop class="bottom" offset="1" />
        </linearGradient>
        <linearGradient id="fill-solar" class="grad grad-solar" x1="0" y1="0" x2="0" y2="1">
          <stop class="top" offset="0" />
          <stop class="bottom" offset="1" />
        </linearGradient>
        <linearGradient id="fill-house" class="grad grad-house" x1="0" y1="0" x2="0" y2="1">
          <stop class="top" offset="0" />
          <stop class="bottom" offset="1" />
        </linearGradient>
      </defs>
    </svg>

    <p v-if="reading" class="state copy">Reading samples…</p>
    <p v-else-if="!ready" class="state copy">No samples in this range.</p>

    <template v-else>
      <div
        class="strips"
        :class="{ refreshing: loading }"
        role="group"
        aria-label="Power over time — arrow keys to inspect stored samples"
        tabindex="0"
        @pointerleave="cursorIndex = null"
        @keydown="onKeydown"
        @focus="onFocus"
      >
        <div class="strip">
          <span class="key"><i class="swatch pack" />Pack W</span>
          <svg
            ref="plot"
            :viewBox="`0 0 ${plotWidth} ${STRIP_HEIGHT}`"
            role="img"
            :aria-label="`Pack power, ${range} range, band plus or minus ${packAxis.high} watts`"
            @pointermove="moveCursor"
          >
            <text :x="GUTTER - 6" :y="INSET + 8" text-anchor="end" class="band">±{{ packAxis.high }} W</text>
            <text :x="GUTTER - 6" :y="packZeroY" text-anchor="end" class="band">0</text>

            <path :d="packArea" class="area" fill="url(#fill-pack)" />
            <line :x1="GUTTER" :y1="packZeroY" :x2="plotWidth" :y2="packZeroY" class="zero" />
            <line
              v-for="gap in gapRuns"
              :key="gap.key"
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
                v-if="cursor.packW !== null"
                :cx="cursor.x"
                :cy="positionOn(packValue, cursor.packW)"
                r="2.5"
                class="dot pack"
              />
            </g>
          </svg>
        </div>

        <div v-if="hasSolar" class="strip">
          <span class="key"><i class="swatch solar" />PV W</span>
          <svg
            :viewBox="`0 0 ${plotWidth} ${STRIP_HEIGHT}`"
            role="img"
            :aria-label="`Solar input power, ${range} range, band zero to ${pvAxis.high} watts`"
            @pointermove="moveCursor"
          >
            <text :x="GUTTER - 6" :y="INSET + 8" text-anchor="end" class="band">{{ pvAxis.high }} W</text>
            <text :x="GUTTER - 6" :y="pvZeroY" text-anchor="end" class="band">0</text>

            <path :d="pvArea" class="area" fill="url(#fill-solar)" />
            <line :x1="GUTTER" :y1="pvZeroY" :x2="plotWidth" :y2="pvZeroY" class="zero" />
            <line
              v-for="gap in gapRuns"
              :key="gap.key"
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
                v-if="cursor.pvW !== null"
                :cx="cursor.x"
                :cy="positionOn(pvValue, cursor.pvW)"
                r="2.5"
                class="dot solar"
              />
            </g>
          </svg>
        </div>

        <div v-if="hasHouse" class="strip">
          <span class="key"><i class="swatch house" />Boat W</span>
          <svg
            :viewBox="`0 0 ${plotWidth} ${STRIP_HEIGHT}`"
            role="img"
            :aria-label="`Boat load power, ${range} range, band zero to ${houseAxis.high} watts`"
            @pointermove="moveCursor"
          >
            <text :x="GUTTER - 6" :y="INSET + 8" text-anchor="end" class="band">{{ houseAxis.high }} W</text>
            <text :x="GUTTER - 6" :y="houseZeroY" text-anchor="end" class="band">0</text>

            <path :d="houseArea" class="area" fill="url(#fill-house)" />
            <line :x1="GUTTER" :y1="houseZeroY" :x2="plotWidth" :y2="houseZeroY" class="zero" />
            <line
              v-for="gap in gapRuns"
              :key="gap.key"
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
                v-if="cursor.houseW !== null"
                :cx="cursor.x"
                :cy="positionOn(houseValue, cursor.houseW)"
                r="2.5"
                class="dot house"
              />
            </g>
          </svg>
        </div>
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
          <span>pack {{ cursor.pack }}</span>
          <span v-if="hasSolar">PV {{ cursor.pv }}</span>
          <span v-if="hasHouse">boat {{ cursor.house }}</span>
        </template>
        <template v-else-if="tracks">
          <span>{{ clockTime(tracks.window.from) }}</span>
          <span>{{ clockTime(tracks.window.to) }}</span>
        </template>
      </p>
    </template>

    <details class="numbers">
      <summary>Show the numbers</summary>
      <div class="table-scroll">
        <table class="grid">
          <caption class="muted">
            The newest {{ tableRows.length }} stored columns. Each is an average over its span;
            nothing here is bridged across a hole.
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Pack W</th>
              <th scope="col">PV W</th>
              <th scope="col">Boat W</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="tableRows.length === 0">
              <td colspan="4">— no samples —</td>
            </tr>
            <tr v-for="row in tableRows" :key="row.key">
              <td>{{ row.at }}</td>
              <td>{{ row.pack }}</td>
              <td>{{ row.pv }}</td>
              <td>{{ row.house }}</td>
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

.gradient-defs {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
}

/* The token hue with a stop-opacity reproduces the --*-fill 0.18→0 ramp and follows the theme,
   without hardcoding either theme's hex. */
.grad-pack .top {
  stop-color: var(--pack);
  stop-opacity: 0.18;
}
.grad-pack .bottom {
  stop-color: var(--pack);
  stop-opacity: 0;
}
.grad-solar .top {
  stop-color: var(--solar);
  stop-opacity: 0.18;
}
.grad-solar .bottom {
  stop-color: var(--solar);
  stop-opacity: 0;
}
.grad-house .top {
  stop-color: var(--house);
  stop-opacity: 0.18;
}
.grad-house .bottom {
  stop-color: var(--house);
  stop-opacity: 0;
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

.area {
  stroke: none;
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
  fill: var(--surface);
  stroke-width: 2;
}

.axis {
  display: flex;
  justify-content: space-between;
  margin: 0.2rem 0 0;
}

.axis.tracking {
  justify-content: flex-start;
  gap: 1.25rem;
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
  min-width: 22rem;
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
