<script setup lang="ts">
/**
 * How long the charger spent in each of its three stages, per day, stacked into one column.
 *
 * Stacked rather than grouped because the three are parts of one quantity — the time the controller
 * was charging at all — and the reading worth making is how that time was divided. A day of eight
 * hours mostly in float is a full battery in good sun; the same eight hours mostly in bulk is a
 * battery that never caught up. Grouped bars would put those two side by side and make the reader
 * add them up.
 *
 * The stack does not fill the day and is not meant to. The charger is in none of the three stages at
 * night, so the column's height is time spent charging and the gap above it is everything else —
 * which is why the axis is hours of charging rather than hours of the day, and why nothing here
 * draws a 24-hour reference line that would invite the wrong subtraction.
 *
 * One hue in three steps, not three hues. Bulk, absorption and float are an ordered sequence within
 * one device, and the entity palette gives that device one colour; three unrelated hues would read as
 * three different things being measured.
 */
import { computed, ref } from 'vue'

import { hoursAndMinutesOf } from '../../application/history/solarRange'
import type { SolarChargeStagesDay } from '../../application/history/solarRange'
import { useMeasuredWidth } from '../../application/useMeasuredWidth'
import { calendarDateEpoch } from '../../domain/history/calendarDays'
import { extentOf, linearScale, positionOn, signedAxis } from '../../domain/history/geometry'

const props = defineProps<{ days: readonly SolarChargeStagesDay[] }>()

/** viewBox units held clear at the left rail for the hour labels. */
const GUTTER = 52
const PLOT_H = 132
/** Room below the baseline for the day labels, inside the same viewBox as the bars. */
const LABEL_BAND = 20
const INSET = 1
/** Breathing room above the tallest stack, so a peak that reaches the axis top still reads as a bar. */
const TOP_PAD = 6
const BAR_MAX = 26
/** The 2px surface gap the design language keeps between a bar and its slot edge. */
const SURFACE_GAP = 2
const CORNER = 4
const COLUMN_MIN_PX = 18
const MINUTES_PER_HOUR = 60

/** The stack, bottom to top: the order the charger moves through them. */
const STAGES = [
  { key: 'bulk', label: 'Bulk' },
  { key: 'absorption', label: 'Absorption' },
  { key: 'float', label: 'Float' },
] as const

type StageKey = (typeof STAGES)[number]['key']

const plot = ref<Element | null>(null)
const plotWidth = useMeasuredWidth(plot)

const dayCount = computed(() => props.days.length)
const recordedCount = computed(() => props.days.filter((day) => day.recorded).length)

const plotMinWidth = computed(() => `max(100%, ${dayCount.value * COLUMN_MIN_PX}px)`)

const peakHours = computed(() =>
  props.days.reduce((most, day) => Math.max(most, (day.minutesCharging ?? 0) / MINUTES_PER_HOUR), 0),
)

const subtitle = computed(() => {
  const span = dayCount.value
  return (
    `From the controller's own daily registers · ${recordedCount.value} of ${span} ` +
    `day${span === 1 ? '' : 's'} on record · height is time spent charging, not time of day`
  )
})

// ── geometry ─────────────────────────────────────────────────────────────────

interface Slot {
  readonly index: number
  readonly cx: number
  readonly slotX: number
  readonly xLabel: string
  readonly showX: boolean
}

const geom = computed(() => {
  const columns = Math.max(1, dayCount.value)
  const slot = (plotWidth.value - GUTTER) / columns
  const barWidth = Math.max(1, Math.min(BAR_MAX, slot - SURFACE_GAP))
  const stride = labelStride(slot)

  const slots: Slot[] = props.days.map((day, index) => ({
    index,
    cx: GUTTER + (index + 0.5) * slot,
    slotX: GUTTER + index * slot,
    xLabel: xLabelFor(day.date),
    showX: index % stride === 0,
  }))

  return { slot, barWidth, slots }
})

interface StackSegment {
  readonly stage: StageKey
  readonly d: string
}

interface AxisTick {
  readonly y: number
  readonly value: number
  readonly text: string
}

const view = computed(() => {
  const { barWidth, slots } = geom.value
  const axis = signedAxis(extentOf([0, peakHours.value]))
  const scale = linearScale(axis.low, axis.high, PLOT_H - INSET, TOP_PAD)

  const stacks = slots.map((slot) => ({
    index: slot.index,
    segments: segmentsFor(props.days[slot.index], slot.cx, barWidth, scale),
  }))

  // The unit is stated once, on the topmost tick; repeating it down the column is four readings of
  // the same fact and crowds the rail the figures have to stay legible in.
  const rungs = axis.ticks.filter((value) => value >= 0)
  const ticks: AxisTick[] = rungs.map((value, index) => ({
    y: positionOn(scale, value),
    value,
    text: index === rungs.length - 1 ? `${hourFigure(value)} h` : hourFigure(value),
  }))

  return { stacks, ticks }
})

/**
 * One day's three segments, bottom up. Only the topmost carries the rounded cap: the rounding marks
 * the end of the data, and a rounded joint between two segments would read as a gap between them.
 */
function segmentsFor(
  day: SolarChargeStagesDay,
  cx: number,
  width: number,
  scale: ReturnType<typeof linearScale>,
): readonly StackSegment[] {
  if (!day.recorded) return []

  const parts: StackSegment[] = []
  let runningMinutes = 0
  const topmost = topStageOf(day)

  for (const stage of STAGES) {
    const minutes = minutesOf(day, stage.key)
    if (minutes <= 0) continue
    const bottomY = positionOn(scale, runningMinutes / MINUTES_PER_HOUR)
    runningMinutes += minutes
    const topY = positionOn(scale, runningMinutes / MINUTES_PER_HOUR)
    parts.push({
      stage: stage.key,
      d: segmentPath(cx, bottomY, topY, width, stage.key === topmost),
    })
  }
  return parts
}

/** The highest stage of the three that this day actually spent time in, or null on an idle day. */
function topStageOf(day: SolarChargeStagesDay): StageKey | null {
  let found: StageKey | null = null
  for (const stage of STAGES) {
    if (minutesOf(day, stage.key) > 0) found = stage.key
  }
  return found
}

function minutesOf(day: SolarChargeStagesDay, stage: StageKey): number {
  if (stage === 'bulk') return day.minutesInBulk ?? 0
  if (stage === 'absorption') return day.minutesInAbsorption ?? 0
  return day.minutesInFloat ?? 0
}

// ── cursor ───────────────────────────────────────────────────────────────────

const activeIndex = ref<number | null>(null)

const bandX = computed(() => {
  const index = activeIndex.value
  return index === null ? 0 : GUTTER + index * geom.value.slot
})

const active = computed(() => {
  const index = activeIndex.value
  if (index === null || index >= props.days.length) return null
  const day = props.days[index]
  return {
    when: fullLabelFor(day.date),
    recorded: day.recorded,
    charging: day.minutesCharging === null ? '' : durationLabel(day.minutesCharging),
    stages: STAGES.map((stage) => ({
      key: stage.key,
      label: stage.label,
      text: durationLabel(minutesOf(day, stage.key)),
    })),
  }
})

const cursorAria = computed(
  () => `${dayCount.value} days. Use the arrow keys to read a day's time in each charge stage.`,
)

function columnAt(clientX: number): number | null {
  const layer = plot.value
  if (layer === null) return null
  const box = layer.getBoundingClientRect()
  if (box.width === 0) return null
  const x = ((clientX - box.left) / box.width) * plotWidth.value
  if (x < GUTTER) return null
  const index = Math.floor((x - GUTTER) / geom.value.slot)
  return Math.min(props.days.length - 1, Math.max(0, index))
}

function onPointerMove(event: PointerEvent): void {
  activeIndex.value = columnAt(event.clientX)
}

function onKeydown(event: KeyboardEvent): void {
  const last = props.days.length - 1
  if (last < 0) return
  const current = activeIndex.value ?? last
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowUp':
      activeIndex.value = Math.min(last, current + 1)
      break
    case 'ArrowLeft':
    case 'ArrowDown':
      activeIndex.value = Math.max(0, current - 1)
      break
    case 'Home':
      activeIndex.value = 0
      break
    case 'End':
      activeIndex.value = last
      break
    case 'Escape':
      activeIndex.value = null
      return
    default:
      return
  }
  event.preventDefault()
}

function onFocus(): void {
  if (activeIndex.value === null && props.days.length > 0) activeIndex.value = lastRecordedIndex()
}

// ── show-the-numbers ─────────────────────────────────────────────────────────

const tableRows = computed(() =>
  [...props.days]
    .reverse()
    .filter((day) => day.recorded)
    .map((day) => ({
      key: day.date,
      when: fullLabelFor(day.date),
      bulk: durationLabel(day.minutesInBulk ?? 0),
      absorption: durationLabel(day.minutesInAbsorption ?? 0),
      float: durationLabel(day.minutesInFloat ?? 0),
      charging: durationLabel(day.minutesCharging ?? 0),
    })),
)

// ── formatting ───────────────────────────────────────────────────────────────

/**
 * Every formatter reads UTC, because a calendar date names a day and the epoch behind it is that
 * day's UTC midnight. Formatting it in the host zone would print the day before, everywhere west of
 * Greenwich.
 */
const dayNumberFmt = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', day: 'numeric' })
const weekdayDayFmt = new Intl.DateTimeFormat(undefined, {
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
})
const fullDayFmt = new Intl.DateTimeFormat(undefined, {
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

function xLabelFor(date: string): string {
  const at = calendarDateEpoch(date)
  return dayCount.value <= 10 ? weekdayDayFmt.format(at) : dayNumberFmt.format(at)
}

function fullLabelFor(date: string): string {
  return fullDayFmt.format(calendarDateEpoch(date))
}

/** The register counts whole minutes, so a duration is said in the unit it was measured in. */
function durationLabel(minutes: number): string {
  const split = hoursAndMinutesOf(minutes)
  if (split.hours === 0) return `${split.minutes} min`
  return `${split.hours} h ${String(split.minutes).padStart(2, '0')} m`
}

function hourFigure(hours: number): string {
  const rounded = Number(hours.toFixed(1))
  return String(rounded === 0 ? 0 : rounded)
}

/** Mono at 10px, so a glyph is 6px wide; the gap keeps two labels from touching. */
const XLABEL_CHAR_PX = 6
const XLABEL_GAP_PX = 12

/**
 * How many days to step between labels. The bound is the width of the label itself, not the width
 * of a slot: a week's slots are wide enough for every day to be named, and thinning them on slot
 * width alone drops labels that had room to spare.
 */
function labelStride(slot: number): number {
  const widest = props.days.reduce((most, day) => Math.max(most, xLabelFor(day.date).length), 0)
  return Math.max(1, Math.ceil((widest * XLABEL_CHAR_PX + XLABEL_GAP_PX) / Math.max(1, slot)))
}

/**
 * One segment of the stack. Square at the bottom always; rounded at the top only where the data
 * ends, so the cap marks the end of the column rather than a seam inside it.
 */
function segmentPath(
  cx: number,
  bottomY: number,
  topY: number,
  width: number,
  capped: boolean,
): string {
  const half = width / 2
  const left = cx - half
  const right = cx + half
  const height = Math.abs(bottomY - topY)
  if (height < 0.5) return ''
  if (!capped) {
    return `M${f(left)},${f(bottomY)}L${f(left)},${f(topY)}L${f(right)},${f(topY)}L${f(right)},${f(bottomY)}Z`
  }

  const radius = Math.min(CORNER, half, height)
  const corner = topY + radius

  return (
    `M${f(left)},${f(bottomY)}` +
    `L${f(left)},${f(corner)}` +
    `Q${f(left)},${f(topY)} ${f(left + radius)},${f(topY)}` +
    `L${f(right - radius)},${f(topY)}` +
    `Q${f(right)},${f(topY)} ${f(right)},${f(corner)}` +
    `L${f(right)},${f(bottomY)}Z`
  )
}

function lastRecordedIndex(): number {
  for (let index = props.days.length - 1; index >= 0; index -= 1) {
    if (props.days[index].recorded) return index
  }
  return props.days.length - 1
}

function f(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '0'
}

/** One viewBox unit is one CSS pixel: bars, axis and labels share the frame the plot is measured in. */
const PLOT_HEIGHT = PLOT_H
const FRAME_HEIGHT = PLOT_H + LABEL_BAND
const XLABEL_Y = PLOT_H + 13
</script>

<template>
  <section class="card" data-testid="stats-solar-stages">
    <header class="head">
      <div class="titles">
        <h3 class="plate">Time in each charge stage</h3>
        <p class="muted sub">{{ subtitle }}</p>
      </div>
      <div class="legend" aria-hidden="true">
        <span v-for="stage in STAGES" :key="stage.key" class="key">
          <i class="sw" :class="stage.key" />{{ stage.label }}
        </span>
      </div>
    </header>

    <p v-if="recordedCount === 0" class="state copy">
      No day in this range is on record here. The controller keeps about a month of them; read its
      stored history and the days fill in.
    </p>

    <template v-else>
      <div class="plot-scroll">
        <div ref="plot" class="plot" :style="{ minWidth: plotMinWidth }">
          <svg
            :viewBox="`0 0 ${plotWidth} ${FRAME_HEIGHT}`"
            role="img"
            aria-label="Hours the charger spent in bulk, absorption and float per day, stacked."
          >
            <rect
              v-if="activeIndex !== null"
              class="lift"
              :x="bandX"
              y="0"
              :width="geom.slot"
              :height="PLOT_HEIGHT"
              rx="2"
            />

            <template v-for="tick in view.ticks" :key="tick.text">
              <line
                :x1="GUTTER"
                :y1="tick.y"
                :x2="plotWidth"
                :y2="tick.y"
                class="grid"
                :class="{ base: tick.value === 0 }"
              />
              <text :x="GUTTER - 6" :y="tick.y + 3" text-anchor="end" class="tick">{{ tick.text }}</text>
            </template>

            <g v-for="stack in view.stacks" :key="stack.index">
              <path
                v-for="segment in stack.segments"
                :key="segment.stage"
                v-show="segment.d"
                :d="segment.d"
                class="col"
                :class="segment.stage"
              />
            </g>

            <g aria-hidden="true">
              <text
                v-for="slot in geom.slots"
                v-show="slot.showX"
                :key="slot.index"
                :x="slot.cx"
                :y="XLABEL_Y"
                text-anchor="middle"
                class="xlabel"
              >
                {{ slot.xLabel }}
              </text>
            </g>
          </svg>

          <div
            class="cursor"
            tabindex="0"
            role="group"
            :aria-label="cursorAria"
            @pointermove="onPointerMove"
            @pointerleave="activeIndex = null"
            @keydown="onKeydown"
            @focus="onFocus"
            @blur="activeIndex = null"
          />
        </div>
      </div>

      <!-- One reserved line in both states, so picking up the cursor cannot reflow the card. -->
      <p class="readout" role="status" aria-live="polite">
        <template v-if="active">
          <span class="when">{{ active.when }}</span>
          <template v-if="active.recorded">
            <span v-for="stage in active.stages" :key="stage.key" class="cue">
              <i class="sw" :class="stage.key" /><b>{{ stage.text }}</b> <em>{{ stage.label.toLowerCase() }}</em>
            </span>
            <span class="cue total"><b>{{ active.charging }}</b> <em>charging</em></span>
          </template>
          <span v-else class="hint">no record for this day</span>
        </template>
        <span v-else class="hint">Hover or focus a day for its time in each stage.</span>
      </p>
    </template>

    <details class="numbers">
      <summary>Show the numbers</summary>
      <div class="table-scroll">
        <table class="grid-table">
          <thead>
            <tr>
              <th class="col-when">Day</th>
              <th class="num">Bulk</th>
              <th class="num">Absorption</th>
              <th class="num">Float</th>
              <th class="num">Charging</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="tableRows.length === 0">
              <td colspan="5">— nothing on record —</td>
            </tr>
            <tr v-for="row in tableRows" :key="row.key">
              <td class="col-when">{{ row.when }}</td>
              <td class="num readout-cell">{{ row.bulk }}</td>
              <td class="num readout-cell">{{ row.absorption }}</td>
              <td class="num readout-cell">{{ row.float }}</td>
              <td class="num readout-cell strong">{{ row.charging }}</td>
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
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.titles h3 {
  margin: 0;
}

.sub {
  margin: 0.35rem 0 0;
  max-width: 52ch;
}

.legend {
  display: flex;
  gap: 0.85rem;
  flex: none;
}

.key {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--ink-secondary);
}

/* One hue in three steps: bulk, absorption and float are an ordered sequence within one device. */
.sw {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex: none;
  background: var(--solar);
}

.sw.absorption,
.col.absorption {
  opacity: 0.66;
}

.sw.float,
.col.float {
  opacity: 0.38;
}

.state {
  margin: 1rem 0 0;
}

/* The wide case scrolls inside this box; the page body never does. */
.plot-scroll {
  overflow-x: auto;
}

.plot {
  position: relative;
  margin-top: 0.9rem;
}

.plot > svg {
  width: 100%;
  height: v-bind('FRAME_HEIGHT + "px"');
  display: block;
  overflow: visible;
}

.grid {
  stroke: var(--gridline);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

/* Zero is the floor every bar stands on, not one more rung. */
.grid.base {
  stroke: var(--baseline);
}

.tick {
  font-family: var(--font-mono);
  font-size: 10px;
  fill: var(--ink-muted);
}

.col {
  fill: var(--solar);
}

.xlabel {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  fill: var(--ink-muted);
}

.lift {
  fill: var(--raised);
}

/* Covers the plot so one cursor reads a day; horizontal drags still scroll a wide month. */
.cursor {
  position: absolute;
  inset: 0;
  touch-action: pan-x pan-y;
}

.cursor:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
  border-radius: 2px;
}

.readout {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 1rem;
  min-height: 1.4rem;
  margin: 0.75rem 0 0;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
}

.readout .when {
  color: var(--ink-secondary);
  font-family: var(--font-label);
  letter-spacing: 0.04em;
}

.cue {
  display: inline-flex;
  align-items: baseline;
  gap: 0.35rem;
}

.cue b {
  color: var(--ink);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.cue em {
  color: var(--ink-muted);
  font-style: normal;
}

.cue.total b {
  font-weight: 600;
}

.hint {
  color: var(--ink-muted);
}

.numbers {
  margin-top: 1rem;
  border-top: 1px solid var(--gridline);
}

.numbers summary {
  display: flex;
  align-items: center;
  min-height: var(--tap, 44px);
  font-family: var(--font-label);
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  color: var(--ink-secondary);
  cursor: pointer;
}

.numbers summary:hover {
  color: var(--ink);
}

.table-scroll {
  overflow-x: auto;
}

.grid-table {
  width: 100%;
  min-width: 26rem;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.grid-table th {
  font-family: var(--font-label);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
  font-weight: 600;
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--gridline);
}

.grid-table td {
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--gridline);
  color: var(--ink);
}

.grid-table .num {
  text-align: right;
}

.readout-cell {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.grid-table .strong {
  font-weight: 600;
}

.col-when {
  font-family: var(--font-label);
  letter-spacing: 0.02em;
  white-space: nowrap;
}

@container (max-width: 560px) {
  .head {
    flex-direction: column;
    gap: 0.5rem;
  }
}
</style>
