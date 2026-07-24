<script setup lang="ts">
/**
 * Warnings per day, stacked by severity on one day-category axis.
 *
 * Escalation reads upward: warning at the baseline, then serious, then critical at the cap, and the
 * order never follows the counts — a day where criticals outnumber warnings still stacks warning
 * below, so the most severe segment is always the one the eye finds at the top. Status colour is
 * never left to carry severity alone: the legend and the per-day total pair a word with every hue.
 *
 * A range with no warnings is not an empty chart. Drawing an axis over zeros would ask the reader to
 * decode a blank grid for the good news; instead the card says it plainly, in the good-status green
 * that is legitimate here because it is a labelled state, not a data series.
 */
import { computed, onScopeDispose, ref, watch } from 'vue'

import type { DailyErrors, RangeKind } from '../../application/history/statsRange'
import { extentOf, linearScale, positionOn, signedAxis } from '../../domain/history/geometry'
import type { WarningLevel } from '../../domain/history/types'

const props = defineProps<{ days: readonly DailyErrors[]; range: RangeKind }>()

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
/** The rounded data-end at the cap of the topmost segment. */
const CAP_RADIUS = 4
/** Half of the 2px surface gap between stacked segments — one applied each side of a boundary. */
const SEGMENT_INSET = 1
/** Keeps every month column at least this wide inside its own scroll box. */
const COLUMN_MIN_PX = 14
/** Only ever the first frame's width: the observer answers before anything is painted twice. */
const FALLBACK_WIDTH = 640

/** bottom → top. The array order IS the stack order and is never re-sorted by count. */
const LEVELS: readonly { readonly level: WarningLevel; readonly label: string }[] = [
  { level: 'warning', label: 'Warning' },
  { level: 'serious', label: 'Serious' },
  { level: 'critical', label: 'Critical' },
]
/** The legend reads most-severe first, the reverse of the stack. */
const LEGEND = [...LEVELS].reverse()

/**
 * One viewBox unit is one CSS pixel, so the viewBox is measured rather than fixed. The plot is
 * given a min-width wide enough to keep a month's columns legible; where that exceeds the card it
 * scrolls inside its own box and the page body never moves.
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

const dayCount = computed(() => props.days.length)
const rangeTotal = computed(() => props.days.reduce((sum, day) => sum + day.total, 0))
const maxDayTotal = computed(() => props.days.reduce((most, day) => Math.max(most, day.total), 0))

/** A clean range is a good state, not an absent one — the good-status line stands in for the axis. */
const allClear = computed(() => maxDayTotal.value === 0)

const subtitle = computed(() => {
  switch (props.range) {
    case 'hour':
      return 'By severity · last hour'
    case 'day':
      return 'By severity · last 24 hours'
    case 'week':
      return 'By severity · last 7 days'
    case 'month':
      return 'By severity · last 30 days'
    case 'all':
      return 'By severity · all recorded'
    case 'custom':
      return 'By severity · selected range'
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

interface Segment {
  readonly level: WarningLevel
  readonly d: string
}

interface Column {
  readonly index: number
  readonly day: number
  readonly cx: number
  readonly slotX: number
  readonly slotWidth: number
  readonly segments: readonly Segment[]
  readonly total: number
  readonly warning: number
  readonly serious: number
  readonly critical: number
  readonly labelY: number
  readonly xLabel: string
  readonly showXLabel: boolean
  /** Whether the running total is stamped over the column, or left to the hover. */
  readonly showTotal: boolean
  readonly dayLabel: string
}

/** Month is the wide case, so its day numbers thin to roughly six labels; week and the sub-day
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
  // to the hover, as the energy bars do; week and the sub-day ranges label every column.
  const peak = props.range === 'month' ? peakTotalIndexOf(props.days) : -1

  return props.days.map((day, index) => {
    const slotX = GUTTER + slot * index
    const cx = slotX + slot / 2

    const present = LEVELS.filter((level) => day[level.level] > 0)
    const segments: Segment[] = []
    let low = 0
    present.forEach((entry, order) => {
      const high = low + day[entry.level]
      const isBottom = order === 0
      const isTop = order === present.length - 1
      // Inset every shared boundary by 1px on each side; the baseline and the rounded cap keep
      // their real edges, so the 2px surface gap sits only between two stacked severities.
      const top = (isTop ? positionOn(scale.value, high) : positionOn(scale.value, high) + SEGMENT_INSET)
      const bottom = (isBottom ? positionOn(scale.value, low) : positionOn(scale.value, low) - SEGMENT_INSET)
      segments.push({
        level: entry.level,
        d: columnPath(cx, top, bottom, barWidth, isTop ? CAP_RADIUS : 0),
      })
      low = high
    })

    return {
      index,
      day: day.day,
      cx: round(cx),
      slotX: round(slotX),
      slotWidth: round(slot),
      segments,
      total: day.total,
      warning: day.warning,
      serious: day.serious,
      critical: day.critical,
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
    `Warnings per day, ${dayCount.value} day${dayCount.value === 1 ? '' : 's'}. ` +
    `Use the arrow keys to read a day's severities.`,
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

/** The busiest day, whose total the month stamps and leaves the rest to the hover. First on a tie. */
function peakTotalIndexOf(days: readonly DailyErrors[]): number {
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
 * one-rounded-end mark has to be a path; a zero radius yields the square corners of the interior
 * segments through the same code.
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
  <section class="card" data-testid="stats-errors-per-day">
    <header class="head">
      <h3 class="plate">Warnings per day</h3>
      <p class="muted sub">{{ subtitle }}</p>
    </header>

    <p v-if="allClear" class="clear copy">
      <span class="clear-dot" aria-hidden="true" />
      No warnings in this range. A clean run — nothing fired.
    </p>

    <template v-else>
      <ul class="legend">
        <li v-for="key in LEGEND" :key="key.level">
          <span class="swatch" :class="key.level" aria-hidden="true" />{{ key.label }}
        </li>
      </ul>

      <div class="plot-scroll">
        <div ref="plot" class="plot" :style="{ minWidth }">
          <svg
            :viewBox="`0 0 ${plotWidth} ${PLOT_HEIGHT}`"
            role="img"
            :aria-label="`Warnings per day by severity, ${subtitle.toLowerCase()}`"
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
              <path
                v-for="seg in col.segments"
                :key="seg.level"
                :d="seg.d"
                class="seg"
                :class="seg.level"
              />
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
          <span v-if="activeColumn.total === 0" class="none">no warnings</span>
          <template v-else>
            <span v-if="activeColumn.warning > 0" class="tally">
              <i class="swatch warning" aria-hidden="true" /><b>{{ activeColumn.warning }}</b> warning
            </span>
            <span v-if="activeColumn.serious > 0" class="tally">
              <i class="swatch serious" aria-hidden="true" /><b>{{ activeColumn.serious }}</b> serious
            </span>
            <span v-if="activeColumn.critical > 0" class="tally">
              <i class="swatch critical" aria-hidden="true" /><b>{{ activeColumn.critical }}</b> critical
            </span>
          </template>
        </template>
        <span v-else class="rest">
          {{ rangeTotal }} warning{{ rangeTotal === 1 ? '' : 's' }} across
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
                <th scope="col" class="num">Warning</th>
                <th scope="col" class="num">Serious</th>
                <th scope="col" class="num">Critical</th>
                <th scope="col" class="num">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="col in columns" :key="`row-${col.day}`">
                <td>{{ col.dayLabel }}</td>
                <td class="num">{{ col.warning }}</td>
                <td class="num">{{ col.serious }}</td>
                <td class="num">{{ col.critical }}</td>
                <td class="num strong">{{ col.total }}</td>
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

/* Legend — the required label channel; status colour never rides alone. */
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1.1rem;
  margin: 0.9rem 0 0.5rem;
  padding: 0;
  list-style: none;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  color: var(--ink-secondary);
}

.legend li {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
  flex: none;
}

.swatch.warning {
  background: var(--status-warning);
}
.swatch.serious {
  background: var(--status-serious);
}
.swatch.critical {
  background: var(--status-critical);
}

/* Month is the wide case: it scrolls inside its own box, the page body never does. */
.plot-scroll {
  overflow-x: auto;
}

.plot {
  width: 100%;
  position: relative;
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

.seg.warning {
  fill: var(--status-warning);
}
.seg.serious {
  fill: var(--status-serious);
}
.seg.critical {
  fill: var(--status-critical);
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

/* The reserved readout row: range total at rest, the focused day's breakdown while tracking. */
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

.line .tally {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.line .tally b {
  color: var(--ink);
  font-weight: 600;
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

@media (max-width: 720px) {
  .legend {
    gap: 0.35rem 0.85rem;
  }
}
</style>
