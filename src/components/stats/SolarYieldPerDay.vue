<script setup lang="ts">
/**
 * What the panels made, per day, as the controller itself counted it.
 *
 * Nothing here is derived. The SmartSolar integrates its own yield over each calendar day and keeps
 * the figure in a daily register, so a bar is a number the charger wrote rather than a sum this
 * browser took over samples — which is why there is no "floor rather than a total" caveat on this
 * card and there is one on the pack's energy bars. The controller was watching every second; we were
 * watching once an hour at best, and only while a tab was open.
 *
 * A day the ledger holds no row for carries no bar. That gap is deliberate and it is not a zero: a
 * boat under cover produces recorded days of 0.14 kWh, so a fabricated zero would be indistinguishable
 * from a real day of almost no sun. The subtitle says how many of the window's days are on record.
 *
 * Consumed energy is the load output's own tally and is null on a controller without one, which this
 * boat's 100/50 is. It appears in the table only when a day actually carries it, rather than as a
 * column of em dashes.
 */
import { computed, ref } from 'vue'

import type { SolarYieldDay } from '../../application/history/solarRange'
import { useMeasuredWidth } from '../../application/useMeasuredWidth'
import { calendarDateEpoch } from '../../domain/history/calendarDays'
import { extentOf, linearScale, maxMagnitudeOf, positionOn, signedAxis } from '../../domain/history/geometry'

const props = defineProps<{ days: readonly SolarYieldDay[] }>()

/** viewBox units held clear at the left rail for the energy labels. */
const GUTTER = 52
const PLOT_H = 132
/** Room below the baseline for the day labels, inside the same viewBox as the bars. */
const LABEL_BAND = 20
const INSET = 1
/** Breathing room above the tallest bar, so a peak that reaches the axis top still reads as a bar. */
const TOP_PAD = 6
const BAR_MAX = 26
/** The 2px surface gap the design language keeps between a bar and its slot edge. */
const SURFACE_GAP = 2
const CORNER = 4
/** Keeps a month's columns legible inside their own scroll box. */
const COLUMN_MIN_PX = 18
/** Under a kilowatt-hour the whole axis reads better in watt-hours. */
const KWH_THRESHOLD_KWH = 1

const plot = ref<Element | null>(null)
const plotWidth = useMeasuredWidth(plot)

const dayCount = computed(() => props.days.length)
const recordedCount = computed(() => props.days.filter((day) => day.recorded).length)

const plotMinWidth = computed(() => `max(100%, ${dayCount.value * COLUMN_MIN_PX}px)`)

const totalKwh = computed(() =>
  props.days.reduce((sum, day) => sum + (day.yieldKwh ?? 0), 0),
)

const peakKwh = computed(() => maxMagnitudeOf(props.days.map((day) => day.yieldKwh)))

const unitLabel = computed<'kWh' | 'Wh'>(() =>
  peakKwh.value >= KWH_THRESHOLD_KWH ? 'kWh' : 'Wh',
)

const subtitle = computed(() => {
  const recorded = recordedCount.value
  const span = dayCount.value
  const held = `${recorded} of ${span} day${span === 1 ? '' : 's'} on record`
  return `From the controller's own daily registers · ${held} · ${energyLabel(totalKwh.value)} in all`
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

interface AxisTick {
  readonly y: number
  readonly value: number
  readonly text: string
}

const view = computed(() => {
  const { barWidth, slots } = geom.value
  const axis = signedAxis(extentOf([0, peakKwh.value]))
  const scale = linearScale(axis.low, axis.high, PLOT_H - INSET, TOP_PAD)
  const baselineY = positionOn(scale, 0)

  const bars = slots.map((slot) => {
    const yieldKwh = props.days[slot.index].yieldKwh
    return {
      index: slot.index,
      d: yieldKwh === null ? '' : columnPath(slot.cx, baselineY, positionOn(scale, yieldKwh), barWidth),
    }
  })

  // The unit is stated once, on the topmost tick; repeating it down the column is four readings of
  // the same fact and crowds the rail the figures have to stay legible in.
  const rungs = axis.ticks.filter((value) => value >= 0)
  const ticks: AxisTick[] = rungs.map((value, index) => ({
    y: positionOn(scale, value),
    value,
    text: index === rungs.length - 1 ? `${energyFigure(value)} ${unitLabel.value}` : energyFigure(value),
  }))

  return { baselineY, bars, ticks }
})

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
    energy: day.yieldKwh === null ? '' : energyLabel(day.yieldKwh),
    consumed: day.consumedKwh === null ? null : energyLabel(day.consumedKwh),
  }
})

const cursorAria = computed(
  () => `${dayCount.value} days. Use the arrow keys to read a day's solar yield.`,
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

const showsConsumed = computed(() => props.days.some((day) => day.consumedKwh !== null))

const tableRows = computed(() =>
  [...props.days]
    .reverse()
    .filter((day) => day.recorded)
    .map((day) => ({
      key: day.date,
      when: fullLabelFor(day.date),
      energy: day.yieldKwh === null ? '—' : energyLabel(day.yieldKwh),
      consumed: day.consumedKwh === null ? '—' : energyLabel(day.consumedKwh),
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

function energyLabel(kwh: number): string {
  return `${energyFigure(kwh)} ${unitLabel.value}`
}

/** The figure alone, for the axis rail where the unit is stated once at the top. */
function energyFigure(kwh: number): string {
  if (unitLabel.value === 'Wh') return String(Math.round(kwh * 1000))
  const rounded = Number(kwh.toFixed(2))
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

/** A column with a 4px rounded top and a square baseline; nothing drawn for a value that rounds off. */
function columnPath(cx: number, baselineY: number, tipY: number, width: number): string {
  const half = width / 2
  const left = cx - half
  const right = cx + half
  const height = Math.abs(tipY - baselineY)
  if (height < 0.5) return ''

  const radius = Math.min(CORNER, half, height)
  const corner = tipY + radius

  return (
    `M${f(left)},${f(baselineY)}` +
    `L${f(left)},${f(corner)}` +
    `Q${f(left)},${f(tipY)} ${f(left + radius)},${f(tipY)}` +
    `L${f(right - radius)},${f(tipY)}` +
    `Q${f(right)},${f(tipY)} ${f(right)},${f(corner)}` +
    `L${f(right)},${f(baselineY)}Z`
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
  <section class="card" data-testid="stats-solar-yield">
    <header class="head">
      <h3 class="plate">Solar yield per day</h3>
      <p class="muted sub">{{ subtitle }}</p>
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
            :aria-label="`Solar yield per day in ${unitLabel}, as the controller recorded it.`"
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

            <path v-for="bar in view.bars" :key="bar.index" v-show="bar.d" :d="bar.d" class="col" />

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
            <span class="cue"><i class="sw" /><b>{{ active.energy }}</b> <em>made</em></span>
            <span v-if="active.consumed !== null" class="cue"
              ><b>{{ active.consumed }}</b> <em>used</em></span
            >
          </template>
          <span v-else class="hint">no record for this day</span>
        </template>
        <span v-else class="hint">Hover or focus a day for what the panels made.</span>
      </p>
    </template>

    <details class="numbers">
      <summary>Show the numbers</summary>
      <div class="table-scroll">
        <table class="grid-table">
          <thead>
            <tr>
              <th class="col-when">Day</th>
              <th class="num">Yield</th>
              <th v-if="showsConsumed" class="num">Used</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="tableRows.length === 0">
              <td :colspan="showsConsumed ? 3 : 2">— nothing on record —</td>
            </tr>
            <tr v-for="row in tableRows" :key="row.key">
              <td class="col-when">{{ row.when }}</td>
              <td class="num readout-cell">{{ row.energy }}</td>
              <td v-if="showsConsumed" class="num readout-cell">{{ row.consumed }}</td>
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

.head h3 {
  margin: 0;
}

.sub {
  margin: 0.35rem 0 0;
  max-width: 52ch;
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

/* The solar hue is the whole mark: this card has one series and it belongs to the controller. */
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

.sw {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex: none;
  background: var(--solar);
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
  min-width: 20rem;
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

.col-when {
  font-family: var(--font-label);
  letter-spacing: 0.02em;
  white-space: nowrap;
}
</style>
