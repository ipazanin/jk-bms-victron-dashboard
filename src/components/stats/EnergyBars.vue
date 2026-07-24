<script setup lang="ts">
/**
 * Per-day energy, three column panels over one shared day axis.
 *
 * Solar in, house out and pack net are three different units — amp-hours, watt-hours, signed
 * amp-hours — so they never share a y-axis. Each panel is its own single-series column chart off
 * `signedAxis`/`centredAxis`, and the three stack over one categorical day axis, the way the trend
 * strips stack over one time axis. Pack net is centre-zero because it is signed: charge grows up
 * from the middle, discharge down, one hue, because the identity being shown is *the pack*.
 *
 * The days handed in are the days that were recorded, not every calendar day the range spans. A day
 * with no session is absent rather than a fabricated zero column, so a column is always a day that
 * really happened and adjacent columns need not be calendar-adjacent.
 */
import { computed, onScopeDispose, ref, watch } from 'vue'

import { ampHours, hours, kilowattHours } from '../../application/format'
import type { DailyTotal } from '../../application/history/daily'
import { hashOf } from '../../application/route'
import {
  centredAxis,
  extentOf,
  linearScale,
  maxMagnitudeOf,
  positionOn,
  signedAxis,
} from '../../domain/history/geometry'
import type { LinearScale } from '../../domain/history/geometry'

const props = defineProps<{
  days: readonly DailyTotal[]
  range: 'week' | 'month'
}>()

/** One viewBox unit is one CSS pixel, as in the trend strips, so a bar width and a corner radius
 *  mean the same thing at 390px and 1440px. The viewBox is measured rather than fixed. */
const GUTTER = 46
const INSET = 1
const PANEL_H = 64
const XLABEL_H = 20
const FALLBACK_WIDTH = 640
/** Cap the bar; the leftover in the slot is the 2px surface gap, never filled. */
const BAR_MAX = 24
const SURFACE_GAP = 2
const CORNER = 4
/** Headroom above (and below, for pack) the plot area, so a cap label never clips off the top. */
const LABEL_PAD = 12
/** Keeps each column at least ~8px wide when the month overflows into its own scroll box. */
const COLUMN_MIN_PX = 14
/** House drawn in Wh rather than kWh once the peak day would otherwise read as "0.xx". */
const KWH_THRESHOLD_WH = 1000

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

const dayCount = computed(() => props.days.length)

/** Wide enough that the month never crushes its columns; the card scrolls this, the page never does. */
const plotMinWidth = computed(() => `max(100%, ${dayCount.value * COLUMN_MIN_PX}px)`)

const houseUnit = computed<'kWh' | 'Wh'>(() => {
  const peak = maxMagnitudeOf(props.days.map((day) => day.houseWh))
  return peak < KWH_THRESHOLD_WH ? 'Wh' : 'kWh'
})

// ── shared column geometry ──────────────────────────────────────────────────

interface Slot {
  readonly index: number
  readonly day: number
  readonly cx: number
  readonly slotX: number
  readonly xLabel: string
  readonly showX: boolean
}

const geom = computed(() => {
  const count = Math.max(1, dayCount.value)
  const slot = (plotWidth.value - GUTTER) / count
  const barWidth = Math.max(1, Math.min(BAR_MAX, slot - SURFACE_GAP))
  const stride = props.range === 'week' ? 1 : Math.max(1, Math.ceil(28 / slot))

  const slots: Slot[] = props.days.map((day, index) => ({
    index,
    day: day.day,
    cx: GUTTER + (index + 0.5) * slot,
    slotX: GUTTER + index * slot,
    xLabel: xLabelFor(day.day),
    showX: index % stride === 0,
  }))

  return { slot, barWidth, slots }
})

// ── panels ──────────────────────────────────────────────────────────────────

type PanelKey = 'solar' | 'house' | 'pack'

interface Cap {
  readonly index: number
  readonly path: string
  readonly label: string | null
  readonly labelY: number
}

interface Tick {
  readonly y: number
  readonly text: string
}

interface PanelView {
  readonly key: PanelKey
  readonly name: string
  readonly unit: string
  readonly aria: string
  readonly baselineY: number
  readonly topTick: Tick
  readonly zeroTick: Tick
  readonly botTick: Tick | null
  readonly caps: readonly Cap[]
}

const rangeWord = computed(() => (props.range === 'week' ? 'this week' : 'this month'))

/** Values grow up from a bottom baseline (solar, house) or out from a centre baseline (pack). Both
 *  reserve LABEL_PAD of headroom so the extreme's cap label sits above the tip rather than clipped. */
function bottomScale(axis: { low: number; high: number }): LinearScale {
  return linearScale(axis.low, axis.high, PANEL_H - INSET, LABEL_PAD)
}
function centredScale(axis: { low: number; high: number }): LinearScale {
  return linearScale(axis.low, axis.high, PANEL_H - LABEL_PAD, LABEL_PAD)
}

const panels = computed<PanelView[]>(() => {
  const days = props.days
  const { barWidth, slots } = geom.value

  const solarAxis = signedAxis(extentOf([...days.map((day) => day.solarAh), 0]))
  const houseAxis = signedAxis(extentOf([...days.map((day) => day.houseWh), 0]))
  const packAxis = centredAxis(maxMagnitudeOf(days.map((day) => day.packAh)))

  const solarScale = bottomScale(solarAxis)
  const houseScale = bottomScale(houseAxis)
  const packScale = centredScale(packAxis)

  const labelAll = days.length <= 4
  const solarPeak = indexOfPeak(days.map((day) => day.solarAh))
  const housePeak = indexOfPeak(days.map((day) => day.houseWh))
  const packPeak = indexOfPeak(days.map((day) => day.packAh))

  const buildCaps = (
    scale: LinearScale,
    value: (day: DailyTotal) => number,
    format: (value: number) => string,
    peakIndex: number,
  ): Cap[] => {
    const baselineY = positionOn(scale, 0)
    return slots.map((slot) => {
      const raw = value(days[slot.index])
      const tipY = positionOn(scale, raw)
      const path = columnPath(slot.cx, baselineY, tipY, barWidth)
      const wanted = labelAll || slot.index === peakIndex
      const show = wanted && path.length > 0
      return {
        index: slot.index,
        path,
        label: show ? format(raw) : null,
        labelY: labelYFor(tipY, baselineY),
      }
    })
  }

  return [
    {
      key: 'solar',
      name: 'Solar in',
      unit: 'Ah',
      aria: `Solar delivered per day, ${rangeWord.value}, amp-hours`,
      baselineY: positionOn(solarScale, 0),
      topTick: { y: 9, text: ampHours(solarAxis.high, 0) },
      zeroTick: { y: positionOn(solarScale, 0), text: '0' },
      botTick: tickBelow(solarAxis, (value) => ampHours(value, 0)),
      caps: buildCaps(solarScale, (day) => day.solarAh, (value) => ampHours(value, 0), solarPeak),
    },
    {
      key: 'house',
      name: 'Boat out',
      unit: houseUnit.value,
      aria: `Boat load per day, ${rangeWord.value}, ${houseUnit.value}`,
      baselineY: positionOn(houseScale, 0),
      topTick: { y: 9, text: houseLabel(houseAxis.high) },
      zeroTick: { y: positionOn(houseScale, 0), text: '0' },
      botTick: tickBelow(houseAxis, houseLabel),
      caps: buildCaps(houseScale, (day) => day.houseWh, houseLabel, housePeak),
    },
    {
      key: 'pack',
      name: 'Pack net',
      unit: 'Ah',
      aria: `Net through the pack per day, ${rangeWord.value}, signed amp-hours; charge up, discharge down`,
      baselineY: positionOn(packScale, 0),
      topTick: { y: 9, text: signedAh(packAxis.high) },
      zeroTick: { y: positionOn(packScale, 0), text: '0' },
      botTick: { y: PANEL_H - 3, text: signedAh(packAxis.low) },
      caps: buildCaps(packScale, (day) => day.packAh, signedAh, packPeak),
    },
  ]
})

// ── cursor (shared across the three panels) ─────────────────────────────────

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
    when: tooltipDayFmt.format(day.day),
    solar: ampHours(day.solarAh, 0),
    house: houseLabel(day.houseWh),
    pack: signedAh(day.packAh),
  }
})

const cursorAria = computed(
  () => `Days, ${dayCount.value}. Use the arrow keys to read a day's totals.`,
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
  if (activeIndex.value === null && props.days.length > 0) {
    activeIndex.value = props.days.length - 1
  }
}

// ── show-the-numbers table ──────────────────────────────────────────────────

const tableRows = computed(() =>
  [...props.days].reverse().map((day) => ({
    key: day.day,
    when: tableDayFmt.format(day.day),
    recorded: hours(day.recordedMs / 3_600_000),
    sessions: day.sessions,
    solar: ampHours(day.solarAh, 0),
    house: houseLabel(day.houseWh),
    pack: signedAh(day.packAh),
    deepest: day.deepestSoc === null ? '—' : `${day.deepestSoc}%`,
  })),
)

// ── formatting ──────────────────────────────────────────────────────────────

const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const tooltipDayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' })
const tableDayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

function xLabelFor(day: number): string {
  return props.range === 'week' ? weekdayFmt.format(day) : String(new Date(day).getDate())
}

/** House printed in whichever unit keeps the peak legible, negative zero normalised either way. */
function houseLabel(wh: number): string {
  if (houseUnit.value === 'kWh') {
    const kwh = Number((wh / 1000).toFixed(2))
    return kilowattHours(kwh === 0 ? 0 : kwh)
  }
  const rounded = Math.round(wh)
  return `${rounded === 0 ? 0 : rounded} Wh`
}

/** Signed amp-hours with the sign decided after rounding, so a day that folds to zero carries no
 *  direction and is never drawn as '−0 Ah'. */
function signedAh(value: number, digits = 0): string {
  const rounded = Number(value.toFixed(digits))
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : ''
  return `${sign}${Math.abs(rounded).toFixed(digits)} Ah`
}

// ── geometry helpers ────────────────────────────────────────────────────────

/** A column whose data-end carries the 4px rounded corners and whose baseline end stays square. The
 *  rounded end is whichever end points away from the baseline, so a centre-zero discharge rounds at
 *  the bottom. A value that rounds to nothing draws no bar; the baseline gridline carries the zero. */
function columnPath(cx: number, baselineY: number, tipY: number, width: number): string {
  const half = width / 2
  const left = cx - half
  const right = cx + half
  const height = Math.abs(tipY - baselineY)
  if (height < 0.5) return ''

  const radius = Math.min(CORNER, half, height)
  const up = tipY < baselineY
  const corner = up ? tipY + radius : tipY - radius

  return (
    `M${f(left)},${f(baselineY)}` +
    `L${f(left)},${f(corner)}` +
    `Q${f(left)},${f(tipY)} ${f(left + radius)},${f(tipY)}` +
    `L${f(right - radius)},${f(tipY)}` +
    `Q${f(right)},${f(tipY)} ${f(right)},${f(corner)}` +
    `L${f(right)},${f(baselineY)}Z`
  )
}

function labelYFor(tipY: number, baselineY: number): number {
  const above = tipY < baselineY ? tipY - 4 : tipY + 11
  return Math.min(PANEL_H - 3, Math.max(8, above))
}

function tickBelow(axis: { low: number }, format: (value: number) => string): Tick | null {
  return axis.low < 0 ? { y: PANEL_H - 3, text: format(axis.low) } : null
}

function indexOfPeak(values: readonly number[]): number {
  let best = -1
  let reach = 0
  for (let index = 0; index < values.length; index += 1) {
    const distance = Math.abs(values[index])
    if (distance > reach) {
      reach = distance
      best = index
    }
  }
  return best
}

function f(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '0'
}

const PANEL_HEIGHT = PANEL_H
const XLABEL_HEIGHT = XLABEL_H
</script>

<template>
  <section class="card" data-testid="stats-energy-bars">
    <header class="head">
      <h3 class="plate">Energy by day</h3>
      <p class="muted">Recorded days {{ rangeWord }} — solar in, boat out, and net through the pack.</p>
    </header>

    <p v-if="days.length === 0" class="state copy">
      No days recorded in this range. Days appear as you record sessions in the
      <a :href="logHref">log</a>.
    </p>

    <template v-else>
      <div class="plot-scroll">
        <div ref="plot" class="plot" :style="{ minWidth: plotMinWidth }">
          <div v-for="panel in panels" :key="panel.key" class="panel">
            <div class="phead">
              <span class="key"><i class="sw" :class="panel.key" />{{ panel.name }}</span>
              <span class="unit muted">{{ panel.unit }}</span>
            </div>
            <svg
              :viewBox="`0 0 ${plotWidth} ${PANEL_HEIGHT}`"
              preserveAspectRatio="none"
              role="img"
              :aria-label="panel.aria"
            >
              <rect
                v-if="activeIndex !== null"
                class="lift"
                :x="bandX"
                y="0"
                :width="geom.slot"
                :height="PANEL_HEIGHT"
                rx="2"
              />

              <text :x="GUTTER - 6" :y="panel.topTick.y" text-anchor="end" class="tick">
                {{ panel.topTick.text }}
              </text>
              <text :x="GUTTER - 6" :y="panel.zeroTick.y" text-anchor="end" class="tick">
                {{ panel.zeroTick.text }}
              </text>
              <text
                v-if="panel.botTick"
                :x="GUTTER - 6"
                :y="panel.botTick.y"
                text-anchor="end"
                class="tick"
              >
                {{ panel.botTick.text }}
              </text>

              <line
                :x1="GUTTER"
                :y1="panel.baselineY"
                :x2="plotWidth"
                :y2="panel.baselineY"
                class="baseline"
              />

              <template v-for="cap in panel.caps" :key="cap.index">
                <path v-if="cap.path" :d="cap.path" class="col" :class="panel.key" />
                <text
                  v-if="cap.label"
                  :x="geom.slots[cap.index].cx"
                  :y="cap.labelY"
                  text-anchor="middle"
                  class="cap"
                >
                  {{ cap.label }}
                </text>
              </template>
            </svg>
          </div>

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

          <!-- One cursor reads all three panels: a real day, snapped, never an interpolated bar. -->
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
          <span class="cue"><i class="sw solar" /><b>{{ active.solar }}</b> <em>Solar</em></span>
          <span class="cue"><i class="sw house" /><b>{{ active.house }}</b> <em>Boat</em></span>
          <span class="cue"><i class="sw pack" /><b>{{ active.pack }}</b> <em>Pack</em></span>
        </template>
        <span v-else class="hint">Hover or focus a day for its totals.</span>
      </p>
    </template>

    <details class="numbers">
      <summary>Show the numbers</summary>
      <div class="table-scroll">
        <table class="daily">
          <thead>
            <tr>
              <th class="col-day">Day</th>
              <th>Recorded</th>
              <th class="num">Solar in</th>
              <th class="num">Boat out</th>
              <th class="num">Pack net</th>
              <th class="num">Deepest</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="tableRows.length === 0">
              <td colspan="6">— no days —</td>
            </tr>
            <tr v-for="row in tableRows" :key="row.key">
              <td class="col-day">{{ row.when }}</td>
              <td class="recorded">
                {{ row.recorded }} <span class="muted">· {{ row.sessions }}</span>
              </td>
              <td class="num readout-cell">{{ row.solar }}</td>
              <td class="num readout-cell">{{ row.house }}</td>
              <td class="num readout-cell">{{ row.pack }}</td>
              <td class="num readout-cell">{{ row.deepest }}</td>
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

.head .muted {
  margin: 0.35rem 0 0;
}

.state {
  margin: 0.5rem 0 0;
}

.state a {
  color: var(--pack-ink);
}

/* The month is the wide case: it scrolls inside this box, the page body never does. */
.plot-scroll {
  overflow-x: auto;
}

.plot {
  position: relative;
}

.panel {
  margin-bottom: 0.4rem;
}

.phead {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  /* Pinned to the left so the panel's identity stays legible while a wide month scrolls under it. */
  position: sticky;
  left: 0;
  width: fit-content;
}

.key {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--ink-secondary);
}

.unit {
  margin: 0;
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
.sw.pack {
  background: var(--pack);
}

.panel svg {
  width: 100%;
  height: 64px;
  display: block;
  overflow: visible;
}

.xaxis {
  width: 100%;
  height: 20px;
  display: block;
  overflow: visible;
}

.tick {
  font-family: var(--font-mono);
  font-size: 10px;
  fill: var(--ink-muted);
}

.baseline {
  stroke: var(--gridline);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

/* The bars are solid identity, so they carry no fill wash — the hue is the whole mark. */
.col.solar {
  fill: var(--solar);
}
.col.house {
  fill: var(--house);
}
.col.pack {
  fill: var(--pack);
}

.cap {
  font-family: var(--font-mono);
  font-size: 10px;
  fill: var(--ink);
}

.xlabel {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  fill: var(--ink-muted);
}

/* The active day, lifted a step behind its columns in every panel. */
.lift {
  fill: var(--raised);
}

/* Covers the panels so one cursor reads all three; horizontal drags still scroll a wide month. */
.cursor {
  position: absolute;
  inset: 0;
  touch-action: pan-x;
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

.daily {
  width: 100%;
  min-width: 24rem;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.daily th {
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

.daily td {
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--gridline);
  color: var(--ink);
  vertical-align: middle;
}

.daily .num {
  text-align: right;
}

.readout-cell {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.col-day {
  font-family: var(--font-label);
  letter-spacing: 0.02em;
  white-space: nowrap;
}

@media (max-width: 720px) {
  .key {
    font-size: 0.75rem;
  }
}
</style>
