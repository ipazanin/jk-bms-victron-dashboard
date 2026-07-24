<script setup lang="ts">
/**
 * Energy in against energy out, per bucket, as paired bars over one shared time axis.
 *
 * Two series only — solar delivered (IN) and house drawn (OUT) — so they share a single watt-hour
 * axis and stand side by side in each bucket, the reading the eye is meant to make being the gap
 * between the two bars. The bucket is the range's own: a week reads day-by-day, a year week-by-week,
 * the whole archive month-by-month. A bucket no session fell in carries no bars — a gap in the
 * timeline, never a fabricated zero.
 *
 * Out is exact; in is solar amp-hours valued at the pack's voltage, so the caption says "estimated"
 * whenever the estimate is on rather than letting a derived figure pass for a measured one.
 */
import { computed, onScopeDispose, ref, watch } from 'vue'

import type { BucketUnit, EnergyBucket } from '../../application/history/statsRange'
import { hashOf } from '../../application/route'
import { extentOf, linearScale, maxMagnitudeOf, positionOn, signedAxis } from '../../domain/history/geometry'

const props = defineProps<{
  buckets: readonly EnergyBucket[]
  unit: BucketUnit
  estimated: boolean
}>()

const GUTTER = 52
const PLOT_H = 132
const XLABEL_H = 20
const INSET = 1
/** Headroom above the plot so a peak's cap label sits above its bar rather than clipping off. */
const LABEL_PAD = 14
const BAR_MAX = 22
/** The 2px surface gap the design language keeps between a bar and its slot edge and its twin. */
const SURFACE_GAP = 2
const PAIR_GAP = 2
const CORNER = 4
const FALLBACK_WIDTH = 640
/** Two bars per slot need more room than one, so the month scrolls sooner than the single-series bars. */
const COLUMN_MIN_PX = 26
const KWH_THRESHOLD_WH = 1000
const DAY_MS = 86_400_000

const logHref = hashOf({ name: 'log' })

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

const count = computed(() => props.buckets.length)
const recordedCount = computed(() => props.buckets.filter((bucket) => bucket.recorded).length)

const plotMinWidth = computed(() => `max(100%, ${count.value * COLUMN_MIN_PX}px)`)

const unitLabel = computed<'kWh' | 'Wh'>(() => {
  const peak = maxMagnitudeOf(props.buckets.flatMap((bucket) => [bucket.inWh, bucket.outWh]))
  return peak >= KWH_THRESHOLD_WH ? 'kWh' : 'Wh'
})

// ── geometry ─────────────────────────────────────────────────────────────────

interface Slot {
  readonly index: number
  readonly cx: number
  readonly slotX: number
  readonly inCx: number
  readonly outCx: number
  readonly xLabel: string
  readonly showX: boolean
}

const geom = computed(() => {
  const n = Math.max(1, count.value)
  const slot = (plotWidth.value - GUTTER) / n
  const barWidth = Math.max(1, Math.min(BAR_MAX, (slot - SURFACE_GAP - PAIR_GAP) / 2))
  const offset = (barWidth + PAIR_GAP) / 2
  const stride = Math.max(1, Math.ceil(n / labelBudget(slot)))

  const slots: Slot[] = props.buckets.map((bucket, index) => {
    const cx = GUTTER + (index + 0.5) * slot
    return {
      index,
      cx,
      slotX: GUTTER + index * slot,
      inCx: cx - offset,
      outCx: cx + offset,
      xLabel: xLabelFor(bucket.start),
      showX: index % stride === 0,
    }
  })

  return { slot, barWidth, slots }
})

// ── bars + axis ──────────────────────────────────────────────────────────────

interface Bar {
  readonly index: number
  readonly inPath: string
  readonly outPath: string
}

interface AxisTick {
  readonly y: number
  readonly text: string
}

const view = computed(() => {
  const buckets = props.buckets
  const { barWidth, slots } = geom.value

  const peak = maxMagnitudeOf(buckets.flatMap((bucket) => [bucket.inWh, bucket.outWh]))
  const axis = signedAxis(extentOf([0, peak]))
  const scale = linearScale(axis.low, axis.high, PLOT_H - INSET, LABEL_PAD)
  const baselineY = positionOn(scale, 0)

  const bars: Bar[] = slots.map((slot) => {
    const bucket = buckets[slot.index]
    if (!bucket.recorded) return { index: slot.index, inPath: '', outPath: '' }
    return {
      index: slot.index,
      inPath: columnPath(slot.inCx, baselineY, positionOn(scale, bucket.inWh), barWidth),
      outPath: columnPath(slot.outCx, baselineY, positionOn(scale, bucket.outWh), barWidth),
    }
  })

  const ticks: AxisTick[] = axis.ticks
    .filter((value) => value >= 0)
    .map((value) => ({ y: positionOn(scale, value), text: value === 0 ? '0' : energyLabel(value) }))

  return { baselineY, bars, ticks, scale }
})

// ── cursor ─────────────────────────────────────────────────────────────────

const activeIndex = ref<number | null>(null)

const bandX = computed(() => {
  const index = activeIndex.value
  return index === null ? 0 : GUTTER + index * geom.value.slot
})

const active = computed(() => {
  const index = activeIndex.value
  if (index === null || index >= props.buckets.length) return null
  const bucket = props.buckets[index]
  return {
    when: bucketLabel(bucket),
    recorded: bucket.recorded,
    inEnergy: energyLabel(bucket.inWh),
    outEnergy: energyLabel(bucket.outWh),
  }
})

const cursorAria = computed(
  () => `${count.value} buckets. Use the arrow keys to read a bucket's energy in and out.`,
)

function columnAt(clientX: number): number | null {
  const layer = plot.value
  if (layer === null) return null
  const box = layer.getBoundingClientRect()
  if (box.width === 0) return null
  const x = ((clientX - box.left) / box.width) * plotWidth.value
  if (x < GUTTER) return null
  const index = Math.floor((x - GUTTER) / geom.value.slot)
  return Math.min(props.buckets.length - 1, Math.max(0, index))
}

function onPointerMove(event: PointerEvent): void {
  activeIndex.value = columnAt(event.clientX)
}

function onKeydown(event: KeyboardEvent): void {
  const last = props.buckets.length - 1
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
  if (activeIndex.value === null && props.buckets.length > 0) {
    activeIndex.value = lastRecordedIndex()
  }
}

// ── show-the-numbers ─────────────────────────────────────────────────────────

const tableRows = computed(() =>
  [...props.buckets]
    .reverse()
    .filter((bucket) => bucket.recorded)
    .map((bucket) => ({
      key: bucket.start,
      when: bucketLabel(bucket),
      inEnergy: energyLabel(bucket.inWh),
      outEnergy: energyLabel(bucket.outWh),
    })),
)

// ── formatting ───────────────────────────────────────────────────────────────

const weekdayDayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' })
const dayMonthFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short' })
const monthYearFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const fullDayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

function xLabelFor(start: number): string {
  if (props.unit === 'month') return monthFmt.format(start)
  if (props.unit === 'week') return dayMonthFmt.format(start)
  return count.value <= 10 ? weekdayDayFmt.format(start) : String(new Date(start).getDate())
}

function bucketLabel(bucket: EnergyBucket): string {
  if (props.unit === 'month') return monthYearFmt.format(bucket.start)
  if (props.unit === 'week') {
    return `${dayMonthFmt.format(bucket.start)} – ${dayMonthFmt.format(bucket.end - DAY_MS)}`
  }
  return fullDayFmt.format(bucket.start)
}

/** Wh under a kilowatt-hour, kWh above, negative zero normalised so a folded bucket carries no sign. */
function energyLabel(wh: number): string {
  if (unitLabel.value === 'kWh') {
    const kwh = Number((wh / 1000).toFixed(2))
    return `${kwh === 0 ? 0 : kwh} kWh`
  }
  const rounded = Math.round(wh)
  return `${rounded === 0 ? 0 : rounded} Wh`
}

/** How many x labels the current slot width can hold without them touching. */
function labelBudget(slot: number): number {
  return Math.max(4, Math.floor((plotWidth.value - GUTTER) / Math.max(28, slot)))
}

// ── geometry helpers (shared shape with the single-series bars) ──────────────

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
  for (let index = props.buckets.length - 1; index >= 0; index -= 1) {
    if (props.buckets[index].recorded) return index
  }
  return props.buckets.length - 1
}

function f(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '0'
}

const PLOT_HEIGHT = PLOT_H
const XLABEL_HEIGHT = XLABEL_H
</script>

<template>
  <section class="card" data-testid="stats-energy-inout">
    <header class="head">
      <div class="titles">
        <h3 class="plate">Energy in vs out</h3>
        <p class="muted">
          Solar delivered against boat drawn, per {{ unit }}.<template v-if="estimated"> Solar energy
          estimated from amp-hours at pack voltage.</template>
        </p>
      </div>
      <div class="legend" aria-hidden="true">
        <span class="key"><i class="sw solar" />In</span>
        <span class="key"><i class="sw house" />Out</span>
      </div>
    </header>

    <p v-if="recordedCount === 0" class="state copy">
      No energy recorded in this range. Days appear as you record sessions in the
      <a :href="logHref">log</a>.
    </p>

    <template v-else>
      <div class="plot-scroll">
        <div ref="plot" class="plot" :style="{ minWidth: plotMinWidth }">
          <svg
            :viewBox="`0 0 ${plotWidth} ${PLOT_HEIGHT}`"
            preserveAspectRatio="none"
            role="img"
            :aria-label="`Energy in versus out per ${unit}, in ${unitLabel}. Solar in and boat out as paired bars.`"
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
              <line :x1="GUTTER" :y1="tick.y" :x2="plotWidth" :y2="tick.y" class="grid" />
              <text :x="GUTTER - 6" :y="tick.y + 3" text-anchor="end" class="tick">{{ tick.text }}</text>
            </template>

            <template v-for="bar in view.bars" :key="bar.index">
              <path v-if="bar.inPath" :d="bar.inPath" class="col solar" />
              <path v-if="bar.outPath" :d="bar.outPath" class="col house" />
            </template>
          </svg>

          <svg
            class="xaxis"
            :viewBox="`0 0 ${plotWidth} ${XLABEL_HEIGHT}`"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <text
              v-for="slot in geom.slots"
              v-show="slot.showX"
              :key="slot.index"
              :x="slot.cx"
              y="13"
              text-anchor="middle"
              class="xlabel"
            >
              {{ slot.xLabel }}
            </text>
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
            <span class="cue"><i class="sw solar" /><b>{{ active.inEnergy }}</b> <em>in</em></span>
            <span class="cue"><i class="sw house" /><b>{{ active.outEnergy }}</b> <em>out</em></span>
          </template>
          <span v-else class="hint">nothing recorded</span>
        </template>
        <span v-else class="hint">Hover or focus a {{ unit }} for its energy in and out.</span>
      </p>
    </template>

    <details class="numbers">
      <summary>Show the numbers</summary>
      <div class="table-scroll">
        <table class="grid-table">
          <thead>
            <tr>
              <th class="col-when">{{ unit === 'month' ? 'Month' : unit === 'week' ? 'Week' : 'Day' }}</th>
              <th class="num">In</th>
              <th class="num">Out</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="tableRows.length === 0">
              <td colspan="3">— nothing recorded —</td>
            </tr>
            <tr v-for="row in tableRows" :key="row.key">
              <td class="col-when">{{ row.when }}</td>
              <td class="num readout-cell">{{ row.inEnergy }}</td>
              <td class="num readout-cell">{{ row.outEnergy }}</td>
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
  margin-bottom: 1rem;
}

.titles h3 {
  margin: 0;
}

.titles .muted {
  margin: 0.35rem 0 0;
  max-width: 46ch;
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

.sw {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex: none;
}

.sw.solar {
  background: var(--solar);
}
.sw.house {
  background: var(--house);
}

.state {
  margin: 0.5rem 0 0;
}

.state a {
  color: var(--pack-ink);
}

/* The wide case scrolls inside this box; the page body never does. */
.plot-scroll {
  overflow-x: auto;
}

.plot {
  position: relative;
}

.plot > svg {
  width: 100%;
  height: 132px;
  display: block;
  overflow: visible;
}

.xaxis {
  width: 100%;
  height: 20px;
  display: block;
  overflow: visible;
}

.grid {
  stroke: var(--gridline);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.tick {
  font-family: var(--font-mono);
  font-size: 10px;
  fill: var(--ink-muted);
}

/* Solid identity: the hue is the whole mark, no fill wash. */
.col.solar {
  fill: var(--solar);
}
.col.house {
  fill: var(--house);
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

/* Covers the plot so one cursor reads a bucket; horizontal drags still scroll a wide month. */
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

@container (max-width: 560px) {
  .head {
    flex-direction: column;
    gap: 0.5rem;
  }
}
</style>
