<script setup lang="ts">
/**
 * Events the pack itself logged, per day, on one day-category axis.
 *
 * Single-tone columns. The pack's event vocabulary carries no severity — `WarningLevel` belongs to
 * this app's own annunciator and does not exist in the device's — so nothing here stacks, colours or
 * orders by how bad an event sounds. What fired is named instead, under the focused column and in
 * the table, with the raw code beside every label so a wrong label stays falsifiable on screen.
 *
 * Clock rewrites never reach this card. The pack files them in the same ring under the same
 * vocabulary, but they are a fact about the clock and are reported in the clock panel; tallying them
 * here would show a spike of pack events on the day someone opened the vendor app.
 *
 * A range with no events is not an empty chart. Drawing an axis over zeros would ask the reader to
 * decode a blank grid for the good news; instead the card says it plainly, in the good-status green
 * that is legitimate here because it is a labelled state, not a data series.
 */
import { computed, ref } from 'vue'

import type { RingEventDay } from '../../application/history/ringRange'
import type { RangeKind } from '../../application/history/statsRange'
import { useMeasuredWidth } from '../../application/useMeasuredWidth'
import { extentOf, linearScale, positionOn, signedAxis } from '../../domain/history/geometry'

const props = defineProps<{ days: readonly RingEventDay[]; range: RangeKind }>()

/** viewBox units held clear at the left rail for the count-axis labels — TrendStrips' constant. */
const GUTTER = 46
/** Room above the tallest column for its total-count label. */
const CAP_BAND = 18
/** Room below the baseline for the day labels. */
const LABEL_BAND = 20
const PLOT_HEIGHT = 150
const TOP_Y = CAP_BAND
const BASELINE_Y = PLOT_HEIGHT - LABEL_BAND
/** Cap the column so it never fills its slot; the leftover is the 2px surface gap between days. */
const BAR_MAX = 24
const BAR_GAP = 2
/** The rounded data-end at the cap of the column. */
const CAP_RADIUS = 4
/** Keeps every month column at least this wide inside its own scroll box. */
const COLUMN_MIN_PX = 14

/**
 * One viewBox unit is one CSS pixel, so the viewBox is measured rather than fixed. The plot is
 * given a min-width wide enough to keep a month's columns legible; where that exceeds the card it
 * scrolls inside its own box and the page body never moves.
 */
const plot = ref<Element | null>(null)
const plotWidth = useMeasuredWidth(plot)

const dayCount = computed(() => props.days.length)
const rangeTotal = computed(() => props.days.reduce((sum, day) => sum + day.total, 0))
const maxDayTotal = computed(() => props.days.reduce((most, day) => Math.max(most, day.total), 0))

/** A clean range is a good state, not an absent one — the good-status line stands in for the axis. */
const allClear = computed(() => maxDayTotal.value === 0)

const subtitle = computed(() => {
  switch (props.range) {
    case 'day':
      return "From the pack's own log · last 24 hours"
    case 'week':
      return "From the pack's own log · last 7 days"
    case 'month':
      return "From the pack's own log · last 30 days"
    case 'all':
      return "From the pack's own log · everything held"
    case 'custom':
      return "From the pack's own log · selected range"
  }
})

/**
 * Zero-anchored integer ticks. Aiming for as many intervals as the peak count (capped) lands the
 * niceStep on a whole number, so a peak of three prints 0·1·2·3 rather than a grid of half-counts.
 */
const axis = computed(() =>
  signedAxis(extentOf([0, maxDayTotal.value]), Math.max(1, Math.min(5, maxDayTotal.value))),
)
const scale = computed(() => linearScale(0, axis.value.high, BASELINE_Y, TOP_Y))

const ticks = computed(() =>
  axis.value.ticks.map((value) => ({ value, y: round(positionOn(scale.value, value)) })),
)

const minWidth = computed(() => `max(100%, ${dayCount.value * COLUMN_MIN_PX}px)`)

const weekdayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const dayNumberLabel = new Intl.DateTimeFormat(undefined, { day: 'numeric' })
const fullDayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' })

/** One label and the code behind it, so the reader can check the table against a capture. */
interface FiredEvent {
  readonly code: number
  readonly label: string
  readonly hex: string
}

interface Column {
  readonly index: number
  readonly day: number
  readonly cx: number
  readonly slotX: number
  readonly slotWidth: number
  readonly d: string
  readonly total: number
  readonly fired: readonly FiredEvent[]
  readonly labelY: number
  readonly xLabel: string
  readonly showXLabel: boolean
  /** Whether the running total is stamped over the column, or left to the hover. */
  readonly showTotal: boolean
  readonly dayLabel: string
}

/** Month is the wide case, so its day numbers thin to roughly six labels; week and the shorter
 *  ranges label every column. */
const labelStride = computed(() =>
  props.range === 'month' ? Math.max(1, Math.ceil(dayCount.value / 6)) : 1,
)

/** The plot's pixel width less the label gutter, split evenly across the days. Shared by the drawn
 *  columns and the pointer overlay so the overlay snaps to exactly the columns it sits over. */
const slotWidth = computed(() => Math.max(1, plotWidth.value - GUTTER) / Math.max(1, dayCount.value))

const columns = computed<Column[]>(() => {
  const count = dayCount.value
  if (count === 0) return []

  const slot = slotWidth.value
  const barWidth = Math.max(2, Math.min(BAR_MAX, slot - BAR_GAP))
  const stride = labelStride.value
  // Month is the wide case: the running total is stamped over its busiest day alone, the rest left
  // to the hover, as the energy bars do; week and the shorter ranges label every column.
  const peak = props.range === 'month' ? peakTotalIndexOf(props.days) : -1

  return props.days.map((day, index) => {
    const slotX = GUTTER + slot * index
    const cx = slotX + slot / 2

    return {
      index,
      day: day.day,
      cx: round(cx),
      slotX: round(slotX),
      slotWidth: round(slot),
      d:
        day.total === 0
          ? ''
          : columnPath(
              cx,
              positionOn(scale.value, day.total),
              positionOn(scale.value, 0),
              barWidth,
              CAP_RADIUS,
            ),
      total: day.total,
      fired: firedOn(day),
      labelY: round(positionOn(scale.value, day.total) - 5),
      xLabel: xLabelFor(day.day),
      showXLabel: index % stride === 0,
      showTotal: day.total > 0 && (props.range !== 'month' || index === peak),
      dayLabel: fullDayLabel.format(day.day),
    }
  })
})

const active = ref<number | null>(null)
const activeColumn = computed(() =>
  active.value === null ? null : (columns.value[active.value] ?? null),
)

const cursorAria = computed(
  () =>
    `Pack events per day, ${dayCount.value} day${dayCount.value === 1 ? '' : 's'}. ` +
    `Use the arrow keys to read what fired on a day.`,
)

/**
 * One overlay reads the whole plot. A pointer or the arrow keys snap to the nearest column, so the
 * inspect target is the full plot width rather than a per-day rect that on a phone falls well under
 * the 44px tap floor. The pattern mirrors the energy bars' shared cursor.
 */
function columnAt(clientX: number): number | null {
  const layer = plot.value
  if (layer === null) return null
  const box = layer.getBoundingClientRect()
  if (box.width === 0) return null

  const x = ((clientX - box.left) / box.width) * plotWidth.value
  if (x < GUTTER) return null
  const index = Math.floor((x - GUTTER) / slotWidth.value)
  return Math.min(dayCount.value - 1, Math.max(0, index))
}

function onPointerMove(event: PointerEvent): void {
  active.value = columnAt(event.clientX)
}

function onKeydown(event: KeyboardEvent): void {
  const last = dayCount.value - 1
  if (last < 0) return
  const current = active.value ?? last

  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowUp':
      active.value = Math.min(last, current + 1)
      break
    case 'ArrowLeft':
    case 'ArrowDown':
      active.value = Math.max(0, current - 1)
      break
    case 'Home':
      active.value = 0
      break
    case 'End':
      active.value = last
      break
    case 'Escape':
      active.value = null
      return
    default:
      return
  }
  event.preventDefault()
}

function onFocus(): void {
  if (active.value === null && dayCount.value > 0) active.value = dayCount.value - 1
}

/** Labels and codes travel index for index out of the fold, so they are zipped rather than joined. */
function firedOn(day: RingEventDay): FiredEvent[] {
  return day.codes.map((code, at) => ({
    code,
    label: day.labels[at] ?? '',
    hex: `0x${code.toString(16).padStart(2, '0')}`,
  }))
}

/** The busiest day, whose total the month stamps and leaves the rest to the hover. First on a tie. */
function peakTotalIndexOf(days: readonly RingEventDay[]): number {
  let best = -1
  let most = 0
  days.forEach((day, index) => {
    if (day.total > most) {
      most = day.total
      best = index
    }
  })
  return best
}

function xLabelFor(day: number): string {
  if (props.range === 'week') return weekdayLabel.format(day)
  if (props.range === 'month') return dayNumberLabel.format(day)
  return fullDayLabel.format(day)
}

/**
 * A column with its cap rounded and its base square. A rect's `rx` rounds both ends, so the
 * one-rounded-end mark has to be a path.
 */
function columnPath(cx: number, top: number, bottom: number, width: number, radius: number): string {
  const x = cx - width / 2
  const right = x + width
  const height = Math.max(0, bottom - top)
  const r = Math.max(0, Math.min(radius, width / 2, height))
  return (
    `M${round(x)},${round(bottom)}` +
    `L${round(x)},${round(top + r)}` +
    `Q${round(x)},${round(top)} ${round(x + r)},${round(top)}` +
    `L${round(right - r)},${round(top)}` +
    `Q${round(right)},${round(top)} ${round(right)},${round(top + r)}` +
    `L${round(right)},${round(bottom)}Z`
  )
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
</script>

<template>
  <section class="card" data-testid="stats-events-per-day">
    <header class="head">
      <h3 class="plate">Events per day</h3>
      <p class="muted sub">{{ subtitle }}</p>
    </header>

    <p v-if="allClear" class="clear copy">
      <span class="clear-dot" aria-hidden="true" />
      No events in this range. The pack logged nothing but its scheduled snapshots.
    </p>

    <template v-else>
      <div class="plot-scroll">
        <div ref="plot" class="plot" :style="{ minWidth }">
          <svg
            :viewBox="`0 0 ${plotWidth} ${PLOT_HEIGHT}`"
            role="img"
            :aria-label="`Pack events per day, ${subtitle.toLowerCase()}`"
          >
            <g class="grid">
              <line
                v-for="tick in ticks"
                :key="`grid-${tick.value}`"
                :x1="GUTTER"
                :y1="tick.y"
                :x2="plotWidth"
                :y2="tick.y"
                :class="{ base: tick.value === 0 }"
              />
              <text
                v-for="tick in ticks"
                :key="`tick-${tick.value}`"
                :x="GUTTER - 6"
                :y="tick.y + 3"
                text-anchor="end"
                class="tick"
              >
                {{ tick.value }}
              </text>
            </g>

            <rect
              v-if="activeColumn"
              class="lift"
              :x="activeColumn.slotX"
              :y="TOP_Y - 4"
              :width="activeColumn.slotWidth"
              :height="BASELINE_Y - TOP_Y + 4"
              rx="4"
            />

            <g v-for="col in columns" :key="`col-${col.day}`">
              <path v-if="col.d" :d="col.d" class="col" />
              <text v-if="col.showTotal" :x="col.cx" :y="col.labelY" text-anchor="middle" class="total">
                {{ col.total }}
              </text>
              <text
                v-if="col.showXLabel"
                :x="col.cx"
                :y="BASELINE_Y + 14"
                text-anchor="middle"
                class="xlab"
              >
                {{ col.xLabel }}
              </text>
            </g>
          </svg>

          <!-- One cursor reads every column: a real day, snapped, never an interpolated one. A
               continuous overlay rather than per-day rects, whose ~9px month width is under the tap floor. -->
          <div
            class="cursor"
            tabindex="0"
            role="group"
            :aria-label="cursorAria"
            @pointermove="onPointerMove"
            @pointerleave="active = null"
            @keydown="onKeydown"
            @focus="onFocus"
            @blur="active = null"
          />
        </div>
      </div>

      <!-- One line in both states, so picking up the cursor cannot reflow the card beneath it. A
           live region so arrowing between days is announced rather than read silently. -->
      <p class="line" role="status" aria-live="polite" :class="{ tracking: activeColumn !== null }">
        <template v-if="activeColumn">
          <span class="day">{{ activeColumn.dayLabel }}</span>
          <span v-if="activeColumn.total === 0" class="none">no events</span>
          <template v-else>
            <span v-for="fired in activeColumn.fired" :key="fired.code" class="fired">
              {{ fired.label }} <span class="code">{{ fired.hex }}</span>
            </span>
          </template>
        </template>
        <span v-else class="rest">
          {{ rangeTotal }} event{{ rangeTotal === 1 ? '' : 's' }} across
          {{ dayCount }} day{{ dayCount === 1 ? '' : 's' }}
        </span>
      </p>

      <details class="numbers">
        <summary>Show the numbers</summary>
        <div class="num-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" class="num">Events</th>
                <th scope="col">What fired</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="col in columns" :key="`row-${col.day}`">
                <td>{{ col.dayLabel }}</td>
                <td class="num strong">{{ col.total }}</td>
                <td class="what">
                  <template v-if="col.fired.length === 0">—</template>
                  <span v-for="fired in col.fired" :key="fired.code" class="fired">
                    {{ fired.label }} <span class="code">{{ fired.hex }}</span>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </template>
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
}

/* All-clear — a good state, said plainly. */
.clear {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  margin: 1rem 0 0;
}

.clear-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--status-good);
  flex: none;
}

/* Month is the wide case: it scrolls inside its own box, the page body never does. */
.plot-scroll {
  overflow-x: auto;
}

.plot {
  width: 100%;
  position: relative;
  margin-top: 0.9rem;
}

.plot svg {
  width: 100%;
  height: v-bind('PLOT_HEIGHT + "px"');
  display: block;
  overflow: visible;
}

.grid line {
  stroke: var(--gridline);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.grid line.base {
  stroke: var(--baseline);
}

.tick {
  font-family: var(--font-mono);
  font-size: 10px;
  fill: var(--ink-muted);
}

/* One tone for every event. The pack's vocabulary carries no severity and this card invents none. */
.col {
  fill: var(--pack);
}

.total {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  font-weight: 600;
  fill: var(--ink);
}

.xlab {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  fill: var(--ink-muted);
}

.lift {
  fill: var(--raised);
  opacity: 0.55;
}

/* Covers the plot so one cursor reads every column; a touch swipe still scrolls a wide month
   horizontally and the page vertically. */
.cursor {
  position: absolute;
  inset: 0;
  touch-action: pan-x pan-y;
}

.cursor:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -1px;
}

/* The reserved readout row: range total at rest, the focused day's events while tracking. */
.line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 1rem;
  min-height: 1.5rem;
  margin: 0.6rem 0 0;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--ink-muted);
}

.line .day {
  font-family: var(--font-label);
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--ink-secondary);
}

.fired {
  color: var(--ink);
}

/* The raw code beside every label, so a label this build has wrong stays falsifiable on screen. */
.code {
  color: var(--ink-muted);
}

.line .none {
  color: var(--ink-secondary);
}

.numbers {
  margin-top: 1rem;
  border-top: 1px solid var(--gridline);
}

.numbers summary {
  display: flex;
  align-items: center;
  min-height: var(--tap);
  font-family: var(--font-label);
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  color: var(--ink-secondary);
  cursor: pointer;
}

.numbers summary:hover {
  color: var(--ink);
}

.num-scroll {
  overflow-x: auto;
}

.numbers table {
  width: 100%;
  min-width: 22rem;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 0.8125rem;
}

.numbers th,
.numbers td {
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid var(--gridline);
  text-align: left;
  color: var(--ink);
}

.numbers th {
  color: var(--ink-muted);
  font-weight: 500;
}

.numbers .num {
  text-align: right;
}

.numbers .strong {
  color: var(--ink);
  font-weight: 600;
}

.numbers .what {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.9rem;
  color: var(--ink-secondary);
}
</style>
