<script setup lang="ts">
/**
 * The virtual shunt.
 *
 * One signed current axis. Zero dead centre. The pack bar runs from zero to its own
 * signed current; the solar bar runs from zero to whatever the panels deliver. The house
 * load is the SPAN between the two tips, because house = solar − pack is exactly that
 * distance. The reading holds in both regimes: when the pack discharges the span brackets
 * across zero, and when it charges hard both tips sit right of zero and the span is a
 * same-side segment. The length is the number either way, and the number is always printed.
 *
 * With no solar connected the span is withheld rather than faked to zero, and what remains
 * is still a complete, honest centre-zero ammeter.
 */
import { computed, ref, watch } from 'vue'

import { ampsAbsolute, watts } from '../application/format'

const props = defineProps<{
  packCurrent: number
  packVoltage: number
  solarCurrent: number | null
  houseCurrent: number | null
  housePower: number | null
  pvPower: number | null
}>()

const WIDTH = 1000
const HEIGHT = 196
const CENTER = WIDTH / 2
// Wide enough that a tip label at full deflection still lands inside the viewBox — the
// SVG clips its overflow, and letting text escape it made the whole page scroll sideways.
const MARGIN = 128
const AXIS_Y = 58
const PACK_Y = 96
const SOLAR_Y = 128
const SPAN_Y = 170
const BAR_HEIGHT = 13

const DOMAIN_LADDER = [5, 10, 20, 40, 80, 160, 320]

const domain = ref(DOMAIN_LADDER[1])

const reach = computed(() =>
  Math.max(Math.abs(props.packCurrent), Math.abs(props.solarCurrent ?? 0)),
)

watch(
  reach,
  (value) => {
    const needed = DOMAIN_LADDER.find((step) => step >= value * 1.15) ?? DOMAIN_LADDER.at(-1)!
    // Grow immediately; shrink only once the trace is comfortably inside a smaller step,
    // so the axis does not breathe on every sample.
    if (needed > domain.value || value * 1.15 < domain.value * 0.45) domain.value = needed
  },
  { immediate: true },
)

const pixelsPerAmp = computed(() => (CENTER - MARGIN) / domain.value)

function x(current: number): number {
  return CENTER + current * pixelsPerAmp.value
}

const solarPresent = computed(() => props.solarCurrent !== null)

const packTip = computed(() => x(props.packCurrent))
const solarTip = computed(() => x(props.solarCurrent ?? 0))

const packBar = computed(() => ({
  x: Math.min(CENTER, packTip.value),
  width: Math.abs(packTip.value - CENTER),
}))
const solarBar = computed(() => ({
  x: Math.min(CENTER, solarTip.value),
  width: Math.abs(solarTip.value - CENTER),
}))
const spanBar = computed(() => ({
  x: Math.min(packTip.value, solarTip.value),
  width: Math.abs(solarTip.value - packTip.value),
}))

const ticks = computed(() => {
  const step = domain.value / 2
  const values: number[] = []
  for (let value = -domain.value; value <= domain.value + 1e-9; value += step) {
    values.push(Number(value.toFixed(2)))
  }
  return values
})

/** Keeps a tip label inside the viewBox when the bar reaches full deflection. */
function labelX(tip: number, toTheRight: boolean): number {
  const offset = toTheRight ? 12 : -12
  return Math.min(WIDTH - 8, Math.max(8, tip + offset))
}

const flow = computed(() => {
  if (props.packCurrent > 0.05) return 'charging'
  if (props.packCurrent < -0.05) return 'discharging'
  return 'at rest'
})

const summary = computed(() =>
  solarPresent.value && props.houseCurrent !== null
    ? `Solar delivers ${ampsAbsolute(props.solarCurrent!)}, the pack is ${flow.value} at ` +
      `${ampsAbsolute(props.packCurrent)}, so the house is drawing ${ampsAbsolute(props.houseCurrent)}, ` +
      `about ${watts(props.housePower ?? 0)}.`
    : `The pack is ${flow.value} at ${ampsAbsolute(props.packCurrent)}. Connect the solar controller to see house load.`,
)
</script>

<template>
  <section class="shunt">
    <header class="head">
      <h2 class="plate">DC bus reconciliation</h2>
      <p class="muted">house = solar − pack</p>
    </header>

    <svg :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" class="chart" role="img" :aria-label="summary">
      <text :x="MARGIN" :y="AXIS_Y - 30" text-anchor="start" class="pole">− discharge</text>
      <text :x="WIDTH - MARGIN" :y="AXIS_Y - 30" text-anchor="end" class="pole">charge +</text>

      <line :x1="MARGIN" :y1="AXIS_Y" :x2="WIDTH - MARGIN" :y2="AXIS_Y" class="axis" />
      <g v-for="tick in ticks" :key="tick">
        <line :x1="x(tick)" :y1="AXIS_Y - 5" :x2="x(tick)" :y2="AXIS_Y" class="axis" />
        <text :x="x(tick)" :y="AXIS_Y - 12" text-anchor="middle" class="tick-label">
          {{ tick === 0 ? '0' : Math.abs(tick) }}
        </text>
      </g>

      <line :x1="CENTER" :y1="AXIS_Y" :x2="CENTER" :y2="SPAN_Y + 12" class="zero" />

      <rect
        :x="packBar.x"
        :y="PACK_Y - BAR_HEIGHT / 2"
        :width="packBar.width"
        :height="BAR_HEIGHT"
        rx="2"
        class="bar pack"
      />
      <text :x="8" :y="PACK_Y + 5" class="row-label">PACK</text>
      <text
        :x="labelX(packTip, packCurrent >= 0)"
        :y="PACK_Y + 5"
        :text-anchor="packCurrent < 0 ? 'end' : 'start'"
        class="value pack-ink"
      >
        {{ packCurrent >= 0 ? '+' : '−' }}{{ Math.abs(packCurrent).toFixed(1) }} A
      </text>

      <template v-if="solarPresent">
        <rect
          :x="solarBar.x"
          :y="SOLAR_Y - BAR_HEIGHT / 2"
          :width="solarBar.width"
          :height="BAR_HEIGHT"
          rx="2"
          class="bar solar"
        />
        <text :x="8" :y="SOLAR_Y + 5" class="row-label">SOLAR</text>
        <text :x="labelX(solarTip, true)" :y="SOLAR_Y + 5" text-anchor="start" class="value solar-ink">
          +{{ (solarCurrent ?? 0).toFixed(1) }} A
        </text>
      </template>
      <template v-else>
        <line :x1="CENTER - 6" :y1="SOLAR_Y" :x2="CENTER + 6" :y2="SOLAR_Y" class="ghost" />
        <text :x="8" :y="SOLAR_Y + 5" class="row-label ghost-ink">SOLAR</text>
        <text :x="CENTER + 20" :y="SOLAR_Y + 5" class="ghost-ink hint">Connect the Victron to see house load</text>
      </template>

      <g v-if="solarPresent && houseCurrent !== null" class="span">
        <text :x="8" :y="SPAN_Y + 5" class="row-label house-ink">HOUSE</text>
        <line :x1="spanBar.x" :y1="SPAN_Y - 7" :x2="spanBar.x" :y2="SPAN_Y + 7" class="cap" />
        <line
          :x1="spanBar.x + spanBar.width"
          :y1="SPAN_Y - 7"
          :x2="spanBar.x + spanBar.width"
          :y2="SPAN_Y + 7"
          class="cap"
        />
        <line :x1="spanBar.x" :y1="SPAN_Y" :x2="spanBar.x + spanBar.width" :y2="SPAN_Y" class="rule" />
        <text
          :x="Math.min(WIDTH - 90, Math.max(150, spanBar.x + spanBar.width / 2))"
          :y="SPAN_Y - 14"
          text-anchor="middle"
          class="value house-ink"
        >
          {{ ampsAbsolute(houseCurrent) }} · {{ watts(housePower ?? 0) }}
        </text>
      </g>
    </svg>

    <footer class="legend">
      <span class="key"><i class="swatch pack" />Pack {{ packVoltage.toFixed(3) }} V</span>
      <span v-if="pvPower !== null" class="key"><i class="swatch solar" />Solar {{ watts(pvPower) }} in</span>
      <span v-if="housePower !== null" class="key"><i class="swatch house" />House {{ watts(housePower) }} out</span>
      <span v-else class="key muted-key">Solar not connected</span>
    </footer>
  </section>
</template>

<style scoped>
.shunt {
  background: var(--surface);
  padding: var(--pad);
  border-bottom: 1px solid var(--gridline);
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin: 0 0 0.25rem;
}

.head h2 {
  margin: 0;
}

.chart {
  width: 100%;
  height: auto;
  display: block;
}

.axis {
  stroke: var(--baseline);
  stroke-width: 1;
}

.zero {
  stroke: var(--baseline);
  stroke-width: 1;
}

.tick-label,
.pole,
.row-label,
.hint {
  font-family: var(--font-label);
  font-size: 13px;
  letter-spacing: 0.08em;
  fill: var(--ink-muted);
}

.pole,
.row-label {
  text-transform: uppercase;
}

.hint {
  font-family: var(--font-body);
  text-transform: none;
  letter-spacing: 0;
}

.value {
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 500;
  fill: var(--ink);
}

.bar {
  transition:
    x 400ms cubic-bezier(0.2, 0.7, 0.2, 1),
    width 400ms cubic-bezier(0.2, 0.7, 0.2, 1);
}

.bar.pack {
  fill: var(--pack);
}
.bar.solar {
  fill: var(--solar);
}

.pack-ink {
  fill: var(--pack);
}
.solar-ink {
  fill: var(--solar);
}
.house-ink {
  fill: var(--house);
}

.span .cap,
.span .rule {
  stroke: var(--house);
  stroke-width: 2;
  transition:
    x1 400ms cubic-bezier(0.2, 0.7, 0.2, 1),
    x2 400ms cubic-bezier(0.2, 0.7, 0.2, 1);
}

.ghost {
  stroke: var(--ink-muted);
  stroke-width: 2;
}

.ghost-ink {
  fill: var(--ink-muted);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 1.25rem;
  margin-top: 0.75rem;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--ink-secondary);
}

.key {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
}

.swatch {
  width: 10px;
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
  background: var(--house);
}

.muted-key {
  color: var(--ink-muted);
}

/*
 * Inside the SVG, font-size is in viewBox units. On a phone the 1000-unit box paints at
 * roughly 390 CSS px, so 15 units would render near 6 px. These sizes hold the rendered
 * text at a legible height once the viewBox is scaled down.
 */
@media (max-width: 720px) {
  .value {
    font-size: 32px;
  }
  .tick-label,
  .pole,
  .row-label {
    font-size: 27px;
  }
  .hint {
    font-size: 26px;
  }
  .legend {
    gap: 0.5rem 1rem;
    font-size: 0.75rem;
  }
}
</style>
