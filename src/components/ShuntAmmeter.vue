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
 *
 * Three marks, three different claims, and the instrument keeps them apart. The band is the
 * envelope of the last thirty seconds — both edges samples a radio reported, nothing averaged.
 * The bar is the latest sample at full fidelity. The figure is that same sample to a tenth.
 * Only the band is windowed, and only the axis is derived from it.
 */
import { computed, ref, watch } from 'vue'

import { amps, ampsAbsolute, volts, watts } from '../application/format'
import { useMediaQuery } from '../application/useMediaQuery'
import type { Reach } from '../domain/reach'
import { CURRENT_LADDER, nextStop } from '../domain/scaleLadder'

const props = defineProps<{
  packCurrent: number
  packVoltage: number
  solarCurrent: number | null
  houseCurrent: number | null
  housePower: number | null
  houseLoadPlausible: boolean | null
  pvPower: number | null
  packReach: Reach | null
  solarReach: Reach | null
}>()

/*
 * Font size inside an SVG is measured in viewBox units, so a fixed viewBox width means
 * text shrinks with the viewport. Rather than inflate the font on small screens — which
 * makes the rows collide — the whole coordinate system shrinks with it, keeping the ratio
 * of text to axis roughly constant.
 *
 * MARGIN is what reserves the value gutter. x() clamps every mark to MARGIN … WIDTH − MARGIN,
 * so the columns outside it are provably free of bars and the three figures can hold one fixed
 * x whatever the data does. The widest string a 320 A axis can print is eight characters, and
 * --font-mono is fixed-advance at 0.6 em: 72 units against 120 of usable gutter on desktop,
 * 77 against 84 on the phone. The SVG still clips its overflow, because letting text escape it
 * made the entire page scroll sideways.
 */
const DESKTOP = { width: 1000, height: 196, margin: 128, axisY: 58, packY: 96, solarY: 128, spanY: 170, bar: 13 }
const PHONE = { width: 420, height: 208, margin: 92, axisY: 54, packY: 100, solarY: 138, spanY: 184, bar: 12 }

const compact = useMediaQuery('(max-width: 720px)')
const box = computed(() => (compact.value ? PHONE : DESKTOP))

const WIDTH = computed(() => box.value.width)
const HEIGHT = computed(() => box.value.height)
const CENTER = computed(() => box.value.width / 2)
const MARGIN = computed(() => box.value.margin)
const AXIS_Y = computed(() => box.value.axisY)
const PACK_Y = computed(() => box.value.packY)
const SOLAR_Y = computed(() => box.value.solarY)
const SPAN_Y = computed(() => box.value.spanY)
const BAR_HEIGHT = computed(() => box.value.bar)

const VALUE_X = computed(() => WIDTH.value - 8)

/** A band whose edges coincide draws as a tick rather than as nothing. */
const MIN_BAND_WIDTH = 3

/**
 * The axis frames the recent envelope, not the instant, so one excursion cannot rescale the
 * chart under a reading being taken. The latest samples are folded in as well: a remembered or
 * browsed snapshot arrives with no window behind it, and an axis blind to it would draw a bar
 * past its own end.
 */
const reach = computed(() => {
  const edges = [Math.abs(props.packCurrent), Math.abs(props.solarCurrent ?? 0)]
  for (const band of [props.packReach, props.solarReach]) {
    if (band) edges.push(Math.abs(band.low), Math.abs(band.high))
  }
  return Math.max(...edges)
})

const domain = ref(CURRENT_LADDER.stops[1])

// The stop in force is state — the ladder grows on sight and releases only on hysteresis — so it
// cannot live in a computed, which would have no previous value to hold against.
watch(reach, (value) => (domain.value = nextStop(CURRENT_LADDER, domain.value, value)), {
  immediate: true,
})

const unitsPerAmp = computed(() => (CENTER.value - box.value.margin) / domain.value)

function x(current: number): number {
  // Clamp so a reading beyond the ladder's top step is pinned at the axis end rather than
  // drawn outside the viewBox, where it would be silently clipped.
  const limit = domain.value
  const bounded = Math.max(-limit, Math.min(limit, current))
  return CENTER.value + bounded * unitsPerAmp.value
}

const solarPresent = computed(() => props.solarCurrent !== null)

/**
 * House = solar − pack is a real load only while solar is the sole charger. When the pack
 * takes more than the panels give, an unmeasured source (alternator, shore charger) is on the
 * bus and the difference goes negative; reconcile flags that so we withhold the figure rather
 * than paint a confident fiction.
 */
const houseKnown = computed(
  () => solarPresent.value && props.houseCurrent !== null && props.houseLoadPlausible === true,
)
const houseCharged = computed(
  () => solarPresent.value && props.houseCurrent !== null && props.houseLoadPlausible === false,
)

const packTip = computed(() => x(props.packCurrent))
const solarTip = computed(() => x(props.solarCurrent ?? 0))

const packBar = computed(() => ({
  x: Math.min(CENTER.value, packTip.value),
  width: Math.abs(packTip.value - CENTER.value),
}))
const solarBar = computed(() => ({
  x: Math.min(CENTER.value, solarTip.value),
  width: Math.abs(solarTip.value - CENTER.value),
}))
const spanBar = computed(() => ({
  x: Math.min(packTip.value, solarTip.value),
  width: Math.abs(solarTip.value - packTip.value),
}))

/** Null when the window holds nothing: an empty band is not drawn and is never relabelled. */
function bandOf(band: Reach | null): { x: number; width: number } | null {
  if (band === null) return null
  const from = x(band.low)
  const to = x(band.high)
  const width = Math.max(MIN_BAND_WIDTH, to - from)
  return { x: (from + to) / 2 - width / 2, width }
}

const packBand = computed(() => bandOf(props.packReach))
const solarBand = computed(() => bandOf(props.solarReach))

const ticks = computed(() => {
  const step = domain.value / 2
  const values: number[] = []
  for (let value = -domain.value; value <= domain.value + 1e-9; value += step) {
    values.push(Number(value.toFixed(2)))
  }
  return values
})

const flow = computed(() => {
  if (props.packCurrent > 0.05) return 'charging'
  if (props.packCurrent < -0.05) return 'discharging'
  return 'at rest'
})

const solarHint = computed(() =>
  compact.value ? 'Connect the Victron' : 'Connect the Victron to see house load',
)

/** Direction in words: a screen reader reads the typographic minus in '−4.9 A' unreliably. */
function spoken(current: number): string {
  const rounded = Number(current.toFixed(1))
  const magnitude = Math.abs(rounded).toFixed(1)
  if (rounded > 0) return `${magnitude} A charging`
  if (rounded < 0) return `${magnitude} A discharging`
  return '0.0 A'
}

/**
 * The band and the bar answer different questions, so the label states both rather than letting
 * a sighted reader see an envelope a listener is never told about.
 */
const bandSentence = computed(() => {
  const spans: string[] = []
  if (props.packReach) {
    spans.push(`the pack ranged from ${spoken(props.packReach.low)} to ${spoken(props.packReach.high)}`)
  }
  if (props.solarReach) {
    spans.push(`solar from ${spoken(props.solarReach.low)} to ${spoken(props.solarReach.high)}`)
  }
  if (spans.length === 0) return ''
  const windowMs = Math.max(props.packReach?.spanMs ?? 0, props.solarReach?.spanMs ?? 0)
  return ` Shaded, over the last ${Math.round(windowMs / 1000)} seconds: ${spans.join(', and ')}.`
})

const summary = computed(() => {
  const pack = `The pack is ${flow.value} at ${ampsAbsolute(props.packCurrent)}.`

  if (houseKnown.value) {
    return (
      `Solar delivers ${ampsAbsolute(props.solarCurrent!)}, the pack is ${flow.value} at ` +
      `${ampsAbsolute(props.packCurrent)}, so the house is drawing ${ampsAbsolute(props.houseCurrent!)}, ` +
      `about ${watts(props.housePower ?? 0)}.${bandSentence.value}`
    )
  }
  // The pack is taking more than solar delivers, so another charger is on the bus and the
  // difference is no longer a house load. Say so rather than print the negative as a draw.
  if (houseCharged.value) {
    return (
      `Solar delivers ${ampsAbsolute(props.solarCurrent!)}, but the pack is ${flow.value} at ` +
      `${ampsAbsolute(props.packCurrent)} — another source is charging, so house load is ` +
      `unavailable.${bandSentence.value}`
    )
  }
  // Solar can be connected yet still not yield a house load, when the controller reports no
  // current or voltage. Telling the user to connect it would then be wrong.
  if (solarPresent.value) {
    return `${pack} Solar delivers ${ampsAbsolute(props.solarCurrent!)}. House load is unavailable.${bandSentence.value}`
  }
  return `${pack} Connect the solar controller to see house load.${bandSentence.value}`
})
</script>

<template>
  <section class="shunt">
    <header class="head">
      <h2 class="plate">DC bus reconciliation</h2>
      <p class="muted">house = solar − pack</p>
    </header>

    <svg
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      class="chart"
      role="img"
      :aria-label="summary"
      data-testid="shunt-ammeter"
    >
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
        v-if="packBand"
        :x="packBand.x"
        :y="PACK_Y - BAR_HEIGHT / 2"
        :width="packBand.width"
        :height="BAR_HEIGHT"
        rx="2"
        class="band pack"
      />
      <rect
        :x="packBar.x"
        :y="PACK_Y - BAR_HEIGHT / 2"
        :width="packBar.width"
        :height="BAR_HEIGHT"
        rx="2"
        class="bar pack"
      />
      <text :x="8" :y="PACK_Y + 5" class="row-label">PACK</text>
      <text :x="VALUE_X" :y="PACK_Y + 5" text-anchor="end" class="value pack-ink">
        {{ amps(packCurrent) }}
      </text>

      <template v-if="solarPresent">
        <rect
          v-if="solarBand"
          :x="solarBand.x"
          :y="SOLAR_Y - BAR_HEIGHT / 2"
          :width="solarBand.width"
          :height="BAR_HEIGHT"
          rx="2"
          class="band solar"
        />
        <rect
          :x="solarBar.x"
          :y="SOLAR_Y - BAR_HEIGHT / 2"
          :width="solarBar.width"
          :height="BAR_HEIGHT"
          rx="2"
          class="bar solar"
        />
        <text :x="8" :y="SOLAR_Y + 5" class="row-label">SOLAR</text>
        <text :x="VALUE_X" :y="SOLAR_Y + 5" text-anchor="end" class="value solar-ink">
          {{ amps(solarCurrent ?? 0) }}
        </text>
      </template>
      <template v-else>
        <line :x1="CENTER - 6" :y1="SOLAR_Y" :x2="CENTER + 6" :y2="SOLAR_Y" class="ghost" />
        <text :x="8" :y="SOLAR_Y + 5" class="row-label ghost-ink">SOLAR</text>
        <text :x="CENTER + 20" :y="SOLAR_Y + 5" class="ghost-ink hint">{{ solarHint }}</text>
      </template>

      <g v-if="houseKnown" class="span">
        <text :x="8" :y="SPAN_Y + 5" class="row-label house-ink">HOUSE</text>
        <rect :x="spanBar.x - 1" :y="SPAN_Y - 7" width="2" height="14" class="cap" />
        <rect :x="spanBar.x + spanBar.width - 1" :y="SPAN_Y - 7" width="2" height="14" class="cap" />
        <rect :x="spanBar.x" :y="SPAN_Y - 1" :width="spanBar.width" height="2" class="rule" />
        <text :x="VALUE_X" :y="SPAN_Y + 5" text-anchor="end" class="value house-ink">
          {{ ampsAbsolute(houseCurrent!) }}
        </text>
      </g>
      <g v-else-if="houseCharged" class="span">
        <text :x="8" :y="SPAN_Y + 5" class="row-label ghost-ink">HOUSE</text>
        <text :x="CENTER + 20" :y="SPAN_Y + 5" class="ghost-ink hint">
          another source charging — house load unavailable
        </text>
      </g>
    </svg>

    <footer class="legend">
      <span class="key"><i class="swatch pack" />Pack {{ volts(packVoltage, 2) }}</span>
      <span v-if="pvPower !== null" class="key"><i class="swatch solar" />Solar {{ watts(pvPower) }} in</span>
      <span v-if="houseKnown" class="key"><i class="swatch house" />House {{ watts(housePower ?? 0) }} out</span>
      <span v-else-if="houseCharged" class="key muted-key">House load unavailable — another source charging</span>
      <span v-else class="key muted-key">Solar not connected</span>
      <span v-if="packBand || solarBand" class="key muted-key band-key">
        shaded — range over the last 30 s
      </span>
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

/*
 * Nothing below carries a transition, and nothing here may gain one. Every mark on this chart is
 * fed a 1 Hz target, so a 400 ms glide buys 400 ms of motion followed by 600 ms of dead stop,
 * once a second, for as long as the page is open — and motion onset is exactly what peripheral
 * vision is tuned to. There is also no filter behind these marks, so a glide would be
 * interpolating toward a value no radio ever reported.
 */
.bar.pack {
  fill: var(--pack);
}
.bar.solar {
  fill: var(--solar);
}

/* Translucent enough that the live bar reads as the foreground claim and the band as context. */
.band {
  fill-opacity: 0.28;
}

.band.pack {
  fill: var(--pack);
}
.band.solar {
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

/* Filled geometry rather than strokes, so the bracket lives in the same coordinate system as
   the two bars whose tips it measures. */
.span .cap,
.span .rule {
  fill: var(--house);
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

/* Its own row: it describes the marks above rather than naming one more of them. */
.band-key {
  flex-basis: 100%;
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

/* The phone viewBox is 420 units wide and paints near 1:1, so these are close to CSS px. */
@media (max-width: 720px) {
  .value {
    font-size: 16px;
  }
  .tick-label,
  .pole,
  .row-label {
    font-size: 13px;
  }
  .hint {
    font-size: 13px;
  }
  .legend {
    gap: 0.4rem 1rem;
    font-size: 0.75rem;
  }
}
</style>
