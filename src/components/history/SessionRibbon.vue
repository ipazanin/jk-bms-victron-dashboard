<script setup lang="ts">
/**
 * The ammeter with time added.
 *
 * One signed amp axis, zero dead centre, and the house load is the vertical gap between the pack
 * trace and the solar trace — the same claim the live instrument's span makes, drawn across a
 * session. Nothing here is a second instrument to learn.
 *
 * The house region is a wash bounded by a 1px edge rather than a filled colour, because the
 * interior of a band cannot carry contrast at any alpha this design language would accept: 0.16
 * measures about 1.20:1 against the surface and even 0.55 only reaches 2.17:1. So the edge does the
 * work and the wash is support.
 *
 * Where the pack took more than the panels gave, the fill is replaced by a hatch instead of being
 * drawn as a house load below zero. That is the same withholding the live instrument performs,
 * made legible across time — which means the archive records for free exactly when the engine ran.
 *
 * Gaps are drawn as gaps. A stream silent longer than the join's bound says nothing about what
 * happened in between, and a straight line across it would assert a reading nobody took.
 */
import { computed, ref, useId } from 'vue'

import { useMediaQuery } from '../../application/useMediaQuery'
import { deriveHouse } from '../../domain/dcBus'
import {
  bandPath,
  centredAxis,
  linearScale,
  maxMagnitudeOf,
  positionOn,
  tracePath,
} from '../../domain/history/geometry'
import type { LinearScale } from '../../domain/history/geometry'
import { deriveTracks } from '../../domain/history/join'
import type { PairedSample } from '../../domain/history/join'
import type { TimeWindow } from '../../domain/history/types'

const props = defineProps<{
  timeline: readonly PairedSample[]
  /** What the loaded rows actually span, which is not the session's own span after a clamp. */
  window: TimeWindow
  cursorAt: number | null
  /** Resolved by the view that owns the crosshair, so tape, ribbon and entries share one search. */
  cursorSample: PairedSample | null
  windowClamped: boolean
  sessionMs: number
}>()

const emit = defineEmits<{
  scrub: [number | null]
  shift: ['earlier' | 'later']
}>()

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

/** Roughly one column per two viewBox units: finer than the eye resolves, coarser than a redraw
 *  per stored sample, which for a day-long session is forty thousand path commands. */
const UNITS_PER_COLUMN = 2

/** Candidate spacings for the time ruler, in ascending order. */
const TIME_STEPS_MS = [
  5 * MS_PER_MINUTE,
  15 * MS_PER_MINUTE,
  30 * MS_PER_MINUTE,
  MS_PER_HOUR,
  2 * MS_PER_HOUR,
  3 * MS_PER_HOUR,
  6 * MS_PER_HOUR,
  12 * MS_PER_HOUR,
  MS_PER_DAY,
]
const TARGET_TIME_TICKS = 7

const DESKTOP = { width: 1000, height: 250, left: 56, right: 946, top: 26, bottom: 196 }
const PHONE = { width: 420, height: 230, left: 40, right: 396, top: 24, bottom: 178 }

const compact = useMediaQuery('(max-width: 720px)')
const box = computed(() => (compact.value ? PHONE : DESKTOP))

const plot = ref<SVGSVGElement | null>(null)

/** Each instance owns its hatch, so two ribbons on one page cannot share a definition. */
const hatchId = `ribbon-withheld-${useId()}`

const tracks = computed(() =>
  deriveTracks(
    props.timeline,
    props.window,
    Math.max(2, Math.round((box.value.right - box.value.left) / UNITS_PER_COLUMN)),
  ),
)

/** The instant at the centre of a column, which is where its reach is drawn. */
function columnAt(index: number): number {
  return props.window.from + (index + 0.5) * tracks.value.columnMs
}

const axis = computed(() => {
  const magnitudes: number[] = []
  for (const track of [tracks.value.pack, tracks.value.solar]) {
    for (const column of track.columns) {
      if (column === null) continue
      magnitudes.push(column.low, column.high)
    }
  }
  return centredAxis(maxMagnitudeOf(magnitudes))
})

const time = computed<LinearScale>(() =>
  linearScale(props.window.from, props.window.to, box.value.left, box.value.right),
)

const value = computed<LinearScale>(() =>
  linearScale(axis.value.low, axis.value.high, box.value.bottom, box.value.top),
)

const zeroY = computed(() => positionOn(value.value, 0))

/** One entry per column: the two traces' rates, and whether the difference is a house load at all. */
interface Column {
  readonly at: number
  readonly pack: number | null
  readonly solar: number | null
  readonly withheld: boolean
}

const columns = computed<readonly Column[]>(() => {
  const packColumns = tracks.value.pack.columns
  const solarColumns = tracks.value.solar.columns
  const built: Column[] = []

  for (let index = 0; index < packColumns.length; index += 1) {
    const pack = packColumns[index]?.net ?? null
    const solar = solarColumns[index]?.net ?? null
    built.push({
      at: columnAt(index),
      pack,
      solar,
      // The withholding rule is read from dcBus rather than restated, so the archive and the live
      // instrument can never withhold on different thresholds. Only the flag is wanted here, and
      // the voltage term scales the power alone.
      withheld: pack !== null && solar !== null && !deriveHouse(pack, solar, 0).plausible,
    })
  }
  return built
})

const packTrace = computed(() =>
  tracePath(
    columns.value.map((column) => ({ at: column.at, value: column.pack })),
    time.value,
    value.value,
  ),
)

const solarTrace = computed(() =>
  tracePath(
    columns.value.map((column) => ({ at: column.at, value: column.solar })),
    time.value,
    value.value,
  ),
)

const packBand = computed(() => reachBand(tracks.value.pack.columns))
const solarBand = computed(() => reachBand(tracks.value.solar.columns))

/** The house region where the difference is a load, and where it is not. The two are drawn from
 *  the same geometry through complementary nulls, so they can never overlap or leave a seam. */
const houseFill = computed(() => houseRegion(false))
const houseHatch = computed(() => houseRegion(true))

const withheldPresent = computed(() => columns.value.some((column) => column.withheld))

/** Where neither radio reported. A stretch one of them covered is not "no samples". */
const silences = computed<readonly TimeWindow[]>(() => {
  const found: TimeWindow[] = []
  for (const packGap of tracks.value.pack.gaps) {
    for (const solarGap of tracks.value.solar.gaps) {
      const from = Math.max(packGap.from, solarGap.from)
      const to = Math.min(packGap.to, solarGap.to)
      if (to > from) found.push({ from, to })
    }
  }
  return found
})

const cursorX = computed(() =>
  props.cursorAt === null ? null : positionOn(time.value, props.cursorAt),
)

const cursorSilence = computed<TimeWindow | null>(() => {
  const at = props.cursorAt
  if (at === null) return null
  return silences.value.find((run) => at >= run.from && at <= run.to) ?? null
})

const tooltip = computed(() => {
  const at = props.cursorAt
  if (at === null) return null

  const silence = cursorSilence.value
  if (silence !== null) {
    return {
      at,
      silentFor: spacedSpan(silence.to - silence.from),
      pack: null,
      solar: null,
      house: null,
      coverage: null,
    }
  }

  const sample = props.cursorSample
  const pack = sample?.pack ?? null
  const solar = sample?.solar ?? null
  const solarCurrent = solar?.batteryCurrentA ?? null
  const house =
    pack === null || solarCurrent === null
      ? null
      : deriveHouse(pack.currentA, solarCurrent, pack.packVoltageV)

  return {
    at,
    silentFor: null,
    pack: pack === null ? null : pack.currentA,
    solar: solarCurrent,
    house,
    coverage: coverageWords(pack !== null, solarCurrent !== null),
  }
})

const timeTicks = computed(() => {
  const span = props.window.to - props.window.from
  if (span <= 0) return []

  const step = TIME_STEPS_MS.find((candidate) => span / candidate <= TARGET_TIME_TICKS) ?? MS_PER_DAY
  const ticks: number[] = []
  // Aligned to the local wall clock rather than to the window's own start, so the labels are round
  // times a reader can find on their watch.
  const first = new Date(props.window.from)
  first.setMinutes(0, 0, 0)
  for (let at = first.getTime(); at <= props.window.to; at += step) {
    if (at >= props.window.from) ticks.push(at)
  }
  return ticks
})

const clampSentence = computed(
  () => `Showing the last ${spacedSpan(props.window.to - props.window.from)} of a ${spacedSpan(props.sessionMs)} session.`,
)

const summary = computed(() => {
  const parts = [
    `Pack and solar current across ${spacedSpan(props.window.to - props.window.from)}, from ${clock(props.window.from)} to ${clock(props.window.to)}.`,
    `The axis reaches ${axis.value.high} amps either side of zero.`,
  ]
  if (withheldPresent.value) parts.push('Some of the session was charged from another source.')
  if (silences.value.length > 0) parts.push(`${silences.value.length} stretches carry no samples.`)
  return parts.join(' ')
})

function reachBand(track: readonly ({ readonly low: number; readonly high: number } | null)[]): string {
  return bandPath(
    track.map((column, index) => ({
      at: columnAt(index),
      lower: column?.low ?? null,
      upper: column?.high ?? null,
    })),
    time.value,
    value.value,
  )
}

function houseRegion(hatched: boolean): string {
  return bandPath(
    columns.value.map((column) => ({
      at: column.at,
      lower: column.withheld === hatched ? column.pack : null,
      upper: column.withheld === hatched ? column.solar : null,
    })),
    time.value,
    value.value,
  )
}

function coverageWords(packSeen: boolean, solarSeen: boolean): string {
  if (packSeen && solarSeen) return 'both radios'
  if (packSeen) return 'pack only'
  if (solarSeen) return 'solar only'
  return 'no samples'
}

function atFromClientX(clientX: number): number | null {
  const svg = plot.value
  if (svg === null) return null

  const bounds = svg.getBoundingClientRect()
  if (bounds.width === 0) return null

  // The viewBox is letterboxed into the element, so the pointer is mapped through the same units
  // the marks are drawn in rather than through the element's own pixels.
  const units = ((clientX - bounds.left) / bounds.width) * box.value.width
  const fraction = (units - box.value.left) / (box.value.right - box.value.left)
  const span = props.window.to - props.window.from
  return props.window.from + Math.min(1, Math.max(0, fraction)) * span
}

function onPointerMove(event: PointerEvent): void {
  const at = atFromClientX(event.clientX)
  if (at !== null) emit('scrub', at)
}

function onStep(direction: -1 | 1): void {
  const step = tracks.value.columnMs || MS_PER_MINUTE
  const from = props.cursorAt ?? props.window.from
  const next = Math.min(props.window.to, Math.max(props.window.from, from + direction * step))
  emit('scrub', next)
}

function clock(at: number): string {
  const when = new Date(at)
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
}

function clockSeconds(at: number): string {
  return `${clock(at)}:${String(new Date(at).getSeconds()).padStart(2, '0')}`
}

/** `3 h 12 m`, `41 min`, `3 min 40 s` — the form that sits inside a sentence. */
function spacedSpan(elapsedMs: number): string {
  if (elapsedMs < MS_PER_MINUTE) return `${Math.round(elapsedMs / 1000)} s`
  if (elapsedMs < MS_PER_HOUR) {
    const minutes = Math.floor(elapsedMs / MS_PER_MINUTE)
    const seconds = Math.round((elapsedMs % MS_PER_MINUTE) / 1000)
    return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`
  }
  const days = Math.floor(elapsedMs / MS_PER_DAY)
  const hours = Math.floor((elapsedMs % MS_PER_DAY) / MS_PER_HOUR)
  const minutes = Math.round((elapsedMs % MS_PER_HOUR) / MS_PER_MINUTE)
  if (days > 0) return `${days} d ${hours} h`
  return `${hours} h ${minutes} m`
}

/** Non-breaking spaces, so a sample count never wraps across the gap between its own digits. */
function grouped(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** The sign is decided after rounding, so a reading that rounds to zero carries no direction. */
function signedAmps(current: number): string {
  const rounded = Number(current.toFixed(1))
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : ''
  return `${sign}${Math.abs(rounded).toFixed(1)} A`
}
</script>

<template>
  <section class="ribbon">
    <header class="head">
      <h2 class="plate">Ribbon</h2>
      <p class="muted">the boat load is the gap, filled</p>
    </header>

    <div class="plot-frame">
      <svg
        ref="plot"
        :viewBox="`0 0 ${box.width} ${box.height}`"
        class="chart"
        tabindex="0"
        role="img"
        :aria-label="summary"
        data-testid="session-ribbon"
        @pointermove="onPointerMove"
        @pointerleave="emit('scrub', null)"
        @keydown.left.prevent="onStep(-1)"
        @keydown.right.prevent="onStep(1)"
        @keydown.esc.prevent="emit('scrub', null)"
      >
        <defs>
          <pattern
            :id="hatchId"
            width="8"
            height="8"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="8" class="hatch-line" />
          </pattern>
        </defs>

        <!-- Recessive: the scale is checkable by eye without competing with the marks on it. -->
        <g class="grid">
          <line
            v-for="tick in axis.ticks"
            :key="tick"
            :x1="box.left"
            :y1="positionOn(value, tick)"
            :x2="box.right"
            :y2="positionOn(value, tick)"
            :class="{ zero: tick === 0 }"
          />
        </g>

        <path v-if="houseFill" :d="houseFill" class="house-fill" />
        <path v-if="houseHatch" :d="houseHatch" :fill="`url(#${hatchId})`" class="house-hatch" />

        <path v-if="packBand" :d="packBand" class="band pack" />
        <path v-if="solarBand" :d="solarBand" class="band solar" />

        <path v-if="packTrace" :d="packTrace" class="trace pack" />
        <path v-if="solarTrace" :d="solarTrace" class="trace solar" />

        <line
          v-for="(run, index) in silences"
          :key="`silence-${index}`"
          :x1="positionOn(time, run.from)"
          :y1="zeroY"
          :x2="positionOn(time, run.to)"
          :y2="zeroY"
          class="silence"
        />

        <g class="value-axis">
          <text
            v-for="tick in axis.ticks"
            :key="tick"
            :x="box.left - 6"
            :y="positionOn(value, tick) + 4"
            text-anchor="end"
            class="tick-label"
          >
            {{ tick === 0 ? '0' : tick > 0 ? `+${tick}` : `−${Math.abs(tick)}` }}
          </text>
        </g>

        <g class="time-axis">
          <line :x1="box.left" :y1="box.bottom" :x2="box.right" :y2="box.bottom" class="rail" />
          <g v-for="tick in timeTicks" :key="tick">
            <line
              :x1="positionOn(time, tick)"
              :y1="box.bottom"
              :x2="positionOn(time, tick)"
              :y2="box.bottom + 5"
              class="rail"
            />
            <text
              :x="positionOn(time, tick)"
              :y="box.bottom + 20"
              text-anchor="middle"
              class="tick-label"
            >
              {{ clock(tick) }}
            </text>
          </g>
        </g>

        <!-- Named at the rail rather than left to hue, so the two traces are told apart in
             monochrome, in print and by a reader who cannot separate blue from amber. -->
        <text :x="box.left + 4" :y="box.top + 12" class="rail-label solar-ink">SOLAR</text>
        <text :x="box.left + 4" :y="box.bottom - 6" class="rail-label pack-ink">PACK</text>

        <line
          v-if="cursorX !== null"
          :x1="cursorX"
          :y1="box.top"
          :x2="cursorX"
          :y2="box.bottom"
          class="crosshair"
        />
      </svg>

      <div
        v-if="tooltip"
        class="tooltip readout"
        :style="{ left: `${((cursorX ?? 0) / box.width) * 100}%` }"
      >
        <p class="tip-time">{{ clockSeconds(tooltip.at) }}</p>
        <p v-if="tooltip.silentFor">no samples — the BMS went quiet for {{ tooltip.silentFor }}</p>
        <template v-else>
          <p><span class="tip-key">pack</span>{{ tooltip.pack === null ? '—' : signedAmps(tooltip.pack) }}</p>
          <p><span class="tip-key">solar</span>{{ tooltip.solar === null ? '—' : signedAmps(tooltip.solar) }}</p>
          <p v-if="tooltip.house === null"><span class="tip-key">boat</span>—</p>
          <p v-else-if="!tooltip.house.plausible">
            <span class="tip-key">boat</span>— another source charging
          </p>
          <p v-else>
            <span class="tip-key">boat</span>{{ Math.abs(tooltip.house.currentA).toFixed(1) }} A ·
            {{ Math.round(Math.abs(tooltip.house.powerW)) }} W
          </p>
          <p class="tip-coverage">{{ tooltip.coverage }}</p>
        </template>
      </div>
    </div>

    <p class="legend readout">
      <span class="key"><i class="swatch pack" />Pack A</span>
      <span class="key"><i class="swatch solar" />Solar A</span>
      <span class="key"><i class="swatch house" />Boat A</span>
      <span class="key"><i class="swatch withheld" />another source</span>
      <span class="key"><i class="swatch silence" />no samples</span>
    </p>

    <p v-if="withheldPresent" class="copy">another source charging — boat load unavailable</p>

    <p class="copy caption">
      Drawn from {{ grouped(timeline.length) }} samples, thinned to fit — the highest and lowest of
      each bucket are kept, so spikes survive.
    </p>

    <p v-if="windowClamped" class="copy clamp">
      {{ clampSentence }}
      <button type="button" class="nudge" @click="emit('shift', 'earlier')">Earlier</button>
      <button type="button" class="nudge" @click="emit('shift', 'later')">Later</button>
    </p>
  </section>
</template>

<style scoped>
.ribbon {
  padding: var(--pad);
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.5rem;
}

.head h2 {
  margin: 0;
}

.plot-frame {
  position: relative;
}

.chart {
  width: 100%;
  height: auto;
  display: block;
  touch-action: pan-y;
}

.grid line {
  stroke: var(--gridline);
  stroke-width: 1;
}

/* The only emphasised gridline: every mark on this chart is a distance from it. */
.grid line.zero {
  stroke: var(--baseline);
}

.rail {
  stroke: var(--baseline);
  stroke-width: 1;
}

.tick-label {
  font-family: var(--font-label);
  font-size: var(--svg-label);
  letter-spacing: 0.06em;
  fill: var(--ink-muted);
}

.rail-label {
  font-family: var(--font-label);
  font-size: var(--svg-label);
  letter-spacing: 0.1em;
}

.pack-ink {
  fill: var(--pack-ink);
}
.solar-ink {
  fill: var(--solar-ink);
}

.house-fill {
  fill: var(--house-wash);
  stroke: var(--house);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.house-hatch {
  stroke: var(--ink-muted);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

/* Thin enough that the region reads as hatched rather than as a solid light block, which is what a
   heavier stroke on an 8-unit pitch collapses into. */
.hatch-line {
  stroke: var(--ink-muted);
  stroke-width: 1.5;
}

/* The envelope of each bucket, so a single-sample spike is still on the page. */
.band {
  fill-opacity: 0.22;
  stroke: none;
}

.band.pack {
  fill: var(--pack);
}
.band.solar {
  fill: var(--solar);
}

.trace {
  fill: none;
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.trace.pack {
  stroke: var(--pack);
}
.trace.solar {
  stroke: var(--solar);
}

.silence {
  stroke: var(--ink-muted);
  stroke-width: 2;
  stroke-dasharray: 2 4;
  vector-effect: non-scaling-stroke;
}

.crosshair {
  stroke: var(--ink-secondary);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  pointer-events: none;
}

.tooltip {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  pointer-events: none;
  background: var(--plane);
  border: 1px solid var(--baseline);
  border-radius: var(--radius);
  padding: 0.4rem 0.6rem;
  font-size: 0.8125rem;
  white-space: nowrap;
  max-width: 100%;
}

.tooltip p {
  margin: 0;
  color: var(--ink);
}

.tip-time,
.tip-coverage {
  color: var(--ink-secondary);
}

.tip-key {
  display: inline-block;
  width: 3.5rem;
  color: var(--ink-muted);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.25rem;
  margin: 0.75rem 0 0;
  font-size: 0.8125rem;
  color: var(--ink-secondary);
}

.key {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
}

.swatch {
  width: 14px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
}

.swatch.pack {
  background: var(--pack);
}
.swatch.solar {
  background: var(--solar);
}

.swatch.house {
  background: var(--house-wash);
  border: 1px solid var(--house);
}

.swatch.withheld {
  background: repeating-linear-gradient(
    45deg,
    transparent 0 2px,
    var(--ink-muted) 2px 4px
  );
  border: 1px solid var(--ink-muted);
}

.swatch.silence {
  height: 2px;
  border-radius: 0;
  background: repeating-linear-gradient(
    to right,
    var(--ink-muted) 0 2px,
    transparent 2px 6px
  );
}

.copy {
  margin: 0.5rem 0 0;
}

.caption {
  color: var(--ink-muted);
}

.clamp {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.6rem;
}

.nudge {
  background: transparent;
  border: 1px solid var(--card-border);
  color: var(--ink-secondary);
  border-radius: var(--r-sm);
  padding: 0.2rem 0.7rem;
  min-height: var(--tap);
  display: inline-flex;
  align-items: center;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.nudge:hover {
  color: var(--ink);
  border-color: var(--baseline);
}
</style>
