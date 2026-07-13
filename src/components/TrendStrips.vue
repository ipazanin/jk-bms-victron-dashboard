<script setup lang="ts">
/**
 * Three small multiples over one shared time axis.
 *
 * Pack current, PV power and house power have different units and different scales, so
 * they never share a y-axis. Each strip gets its own baseline: pack current is centre-zero
 * because it is signed; the two power strips run from zero because they are magnitudes.
 */
import { computed, ref } from 'vue'

import { amps, ampsAbsolute, clockTime, watts } from '../application/format'
import type { TrendPoint } from '../application/telemetry'

const props = defineProps<{ history: TrendPoint[] }>()

const showTable = ref(false)

const WIDTH = 1000
const STRIP_HEIGHT = 46

const hasSolar = computed(() => props.history.some((point) => point.pvPower !== null))
const hasHouse = computed(() => props.history.some((point) => point.housePower !== null))

const span = computed(() => {
  const points = props.history
  if (points.length < 2) return null
  return { start: points[0].at, end: points[points.length - 1].at }
})

function xFor(at: number): number {
  const range = span.value
  if (!range || range.end === range.start) return 0
  return ((at - range.start) / (range.end - range.start)) * WIDTH
}

function buildPath(pick: (point: TrendPoint) => number | null, centreZero: boolean): string {
  const values = props.history.map(pick).filter((value): value is number => value !== null)
  if (values.length < 2) return ''

  const maxAbs = Math.max(1, ...values.map(Math.abs))
  // House power goes negative whenever another source (an alternator) charges the bank
  // harder than the panels. Pinning the floor at zero would draw that trace off the strip,
  // so the band always includes zero and stretches to whatever the data actually reaches.
  const top = centreZero ? maxAbs : Math.max(1, ...values, 0)
  const bottom = centreZero ? -maxAbs : Math.min(0, ...values)
  const span = top - bottom || 1

  const scale = (value: number): number => STRIP_HEIGHT - ((value - bottom) / span) * STRIP_HEIGHT

  let path = ''
  let started = false
  for (const point of props.history) {
    const value = pick(point)
    if (value === null) {
      started = false
      continue
    }
    path += `${started ? 'L' : 'M'}${xFor(point.at).toFixed(1)},${scale(value).toFixed(1)}`
    started = true
  }
  return path
}

/** Where zero sits inside a strip, given the band that strip actually spans. */
function zeroY(pick: (point: TrendPoint) => number | null): number {
  const values = props.history.map(pick).filter((value): value is number => value !== null)
  if (!values.length) return STRIP_HEIGHT
  const top = Math.max(1, ...values, 0)
  const bottom = Math.min(0, ...values)
  return STRIP_HEIGHT - ((0 - bottom) / (top - bottom || 1)) * STRIP_HEIGHT
}

const packPath = computed(() => buildPath((point) => point.packCurrent, true))
const pvPath = computed(() => buildPath((point) => point.pvPower, false))
const housePath = computed(() => buildPath((point) => point.housePower, false))

const packZeroY = computed(() => STRIP_HEIGHT / 2)
const pvZeroY = computed(() => zeroY((point) => point.pvPower))
const houseZeroY = computed(() => zeroY((point) => point.housePower))

const latest = computed(() => props.history[props.history.length - 1] ?? null)
const tableRows = computed(() => props.history.slice(-40).reverse())
</script>

<template>
  <section class="panel">
    <header>
      <h2 class="plate">Last ten minutes</h2>
      <button type="button" class="toggle" @click="showTable = !showTable">
        {{ showTable ? 'Chart view' : 'Table view' }}
      </button>
    </header>

    <p v-if="history.length < 2" class="empty">Collecting samples…</p>

    <template v-else-if="!showTable">
      <div class="strip">
        <span class="key"><i class="swatch pack" />Pack A</span>
        <svg :viewBox="`0 0 ${WIDTH} ${STRIP_HEIGHT}`" preserveAspectRatio="none" role="img"
             :aria-label="`Pack current trend, now ${latest ? ampsAbsolute(latest.packCurrent) : ''}`">
          <line x1="0" :y1="packZeroY" :x2="WIDTH" :y2="packZeroY" class="zero" />
          <path :d="packPath" class="trace pack" />
        </svg>
        <span class="now readout">{{ latest ? amps(latest.packCurrent) : '—' }}</span>
      </div>

      <div v-if="hasSolar" class="strip">
        <span class="key"><i class="swatch solar" />PV W</span>
        <svg :viewBox="`0 0 ${WIDTH} ${STRIP_HEIGHT}`" preserveAspectRatio="none" role="img" aria-label="Solar input power trend">
          <line x1="0" :y1="pvZeroY" :x2="WIDTH" :y2="pvZeroY" class="zero" />
          <path :d="pvPath" class="trace solar" />
        </svg>
        <span class="now readout">{{ latest?.pvPower !== null && latest ? watts(latest.pvPower!) : '—' }}</span>
      </div>

      <div v-if="hasHouse" class="strip">
        <span class="key"><i class="swatch house" />House W</span>
        <svg :viewBox="`0 0 ${WIDTH} ${STRIP_HEIGHT}`" preserveAspectRatio="none" role="img" aria-label="House load trend">
          <line x1="0" :y1="houseZeroY" :x2="WIDTH" :y2="houseZeroY" class="zero" />
          <path :d="housePath" class="trace house" />
        </svg>
        <span class="now readout">{{ latest?.housePower !== null && latest ? watts(latest.housePower!) : '—' }}</span>
      </div>

      <div v-if="span" class="axis">
        <span class="muted">{{ clockTime(span.start) }}</span>
        <span class="muted">{{ clockTime(span.end) }}</span>
      </div>
    </template>

    <table v-else class="twin">
      <caption class="muted">Most recent {{ tableRows.length }} samples, newest first</caption>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Pack A</th>
          <th scope="col">PV W</th>
          <th scope="col">House W</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in tableRows" :key="row.at">
          <td>{{ clockTime(row.at) }}</td>
          <td>{{ row.packCurrent.toFixed(2) }}</td>
          <td>{{ row.pvPower === null ? '—' : Math.round(row.pvPower) }}</td>
          <td>{{ row.housePower === null ? '—' : Math.round(row.housePower) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.panel {
  padding: var(--pad);
  border-top: 1px solid var(--gridline);
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

.toggle {
  background: transparent;
  border: 1px solid var(--gridline);
  color: var(--ink-secondary);
  border-radius: 2px;
  padding: 0.25rem 0.6rem;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.toggle:hover {
  color: var(--ink);
  border-color: var(--baseline);
}

.strip {
  display: grid;
  grid-template-columns: 6.5rem 1fr 4.5rem;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.6rem;
}

.strip svg {
  width: 100%;
  height: 46px;
  overflow: visible;
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

.zero {
  stroke: var(--gridline);
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

.trace.pack {
  stroke: var(--pack);
}
.trace.solar {
  stroke: var(--solar);
}
.trace.house {
  stroke: var(--house);
}

.now {
  text-align: right;
  color: var(--ink);
}

.axis {
  display: flex;
  justify-content: space-between;
  margin-left: 7.25rem;
  margin-right: 5.25rem;
}

.empty {
  margin: 0;
  color: var(--ink-muted);
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
    margin-left: 6.25rem;
    margin-right: 4.75rem;
  }
}
</style>
