<script setup lang="ts">
/**
 * The ammeter, integrated.
 *
 * `∫(solar − pack)dt = ∫solar dt − ∫pack dt` holds exactly over any common window, so this is not a
 * second instrument to learn. It is the same signed axis, the same three entity rows in the same
 * order, and the same rule that the house figure is the SPAN between the two tips rather than a bar
 * of its own — because `94.6 − 23.1 = 71.5` is literally that distance. Only the unit changes.
 *
 * The axis differs from the live instrument in two ways, both deliberate. It carries no hysteresis:
 * grow-fast/shrink-slow exists to stop a live scale breathing, and in a scrubbed session it would
 * make the domain depend on which direction the brush was dragged, so one instant would read
 * against two different scales depending on how the reader arrived at it. And it is not symmetric:
 * the integral of solar cannot go negative, so a ±D domain would spend half its width on a region
 * no mark can reach — every sunny day drawn at half scale.
 *
 * The unmeasured-in bar wears no entity hue at all, because we do not know which entity it was,
 * and it is always labelled `≥` rather than as a figure. It is a floor on charge that came from
 * somewhere neither radio measures, not a measurement of it.
 */
import { computed, useId } from 'vue'

import { useMediaQuery } from '../../application/useMediaQuery'
import {
  ledgerGeometry,
  positionOn,
} from '../../domain/history/geometry'
import type { SessionLedger } from '../../domain/history/types'

const props = defineProps<{
  ledger: SessionLedger
  /** False when the controller never reported. Nothing differences the pack, so there is no house
   *  figure to withhold or to print — the row says so rather than drawing a zero. */
  solarSeen: boolean
  /**
   * The dashboard's live band: a footnote to the ammeter above it rather than a peer. No tick
   * ladder, no poles, half-height bars, and the figures in `.readout` rather than `.ledger-figure`.
   */
  recessive?: boolean
}>()

/** Under a minute of overlap integrates to noise, and a bar chart of noise reads as a measurement. */
const MIN_COUNTED_MS = 60_000

const FULL_DESKTOP = {
  width: 1000,
  left: 96,
  right: 848,
  axisY: 56,
  packY: 100,
  solarY: 132,
  spanY: 166,
  figureY: 192,
  unmeasuredY: 232,
  height: 250,
  bar: 13,
}

const FULL_PHONE = {
  width: 420,
  left: 58,
  right: 330,
  axisY: 52,
  packY: 94,
  solarY: 124,
  spanY: 156,
  figureY: 180,
  unmeasuredY: 218,
  height: 236,
  bar: 12,
}

const RECESSIVE = {
  width: 1000,
  left: 74,
  right: 856,
  axisY: 0,
  packY: 16,
  solarY: 36,
  spanY: 56,
  figureY: 56,
  unmeasuredY: 0,
  height: 68,
  bar: 7,
}

const compact = useMediaQuery('(max-width: 720px)')
const box = computed(() => (props.recessive ? RECESSIVE : compact.value ? FULL_PHONE : FULL_DESKTOP))

/** Each instance owns its hatch, so two ledgers on one page cannot share a definition. */
const hatchId = `ledger-hatch-${useId()}`

const packSeen = computed(() => props.ledger.stateOfChargeFirst !== null)

/**
 * What there is to draw. A session with no controller has no counted window at all, so the minute
 * of overlap is not the question there — whether the pack reported is.
 */
const state = computed<'chart' | 'too-short' | 'nothing'>(() => {
  if (props.solarSeen) return props.ledger.countedMs >= MIN_COUNTED_MS ? 'chart' : 'too-short'
  return packSeen.value ? 'chart' : 'nothing'
})

/**
 * With no controller there is no counted window, so the pack column carries the whole-session
 * integral instead — which is exactly what "the pack column is complete on its own" claims. With a
 * controller the counted window is the only honest basis, because that is the window the house
 * figure beside it is differenced over.
 */
const shown = computed<SessionLedger>(() =>
  props.solarSeen ? props.ledger : { ...props.ledger, packAh: props.ledger.packAhWholeSession },
)

const geometry = computed(() => ledgerGeometry(shown.value, box.value.left, box.value.right))

const valueX = computed(() => box.value.width - 8)

const houseWh = computed(() => props.ledger.houseWh)

/** Out to the boat, so it is printed as a magnitude with its direction carried by the row label —
 *  the same reading the live instrument's span gives. */
const houseAh = computed(() => geometry.value.houseAh)

const summary = computed(() => {
  if (!props.solarSeen) {
    return `Across the whole session the pack ${flowWords(shown.value.packAh)}. The solar controller never reported, so there is no house figure.`
  }

  const parts = [
    `Over ${Math.round(props.ledger.countedMs / 60_000)} minutes in which both radios reported:`,
    `the pack ${flowWords(props.ledger.packAh)},`,
    `the panels delivered ${Math.abs(props.ledger.solarAh).toFixed(1)} amp hours,`,
    `so the house drew ${Math.abs(houseAh.value).toFixed(1)} amp hours, about ${Math.round(Math.abs(houseWh.value))} watt hours.`,
  ]
  if (props.ledger.foreignAhFloor > 0) {
    parts.push(
      `At least ${props.ledger.foreignAhFloor.toFixed(1)} amp hours came from a source neither radio measures.`,
    )
  }
  return parts.join(' ')
})

function flowWords(ampHours: number): string {
  const rounded = Number(ampHours.toFixed(1))
  if (rounded > 0) return `took on ${rounded.toFixed(1)} amp hours`
  if (rounded < 0) return `gave up ${Math.abs(rounded).toFixed(1)} amp hours`
  return 'ended level'
}

/** The sign is decided after rounding, so a figure that rounds to zero carries no direction. */
function signedAh(value: number, digits = 1): string {
  const rounded = Number(value.toFixed(digits))
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : ''
  return `${sign}${Math.abs(rounded).toFixed(digits)} Ah`
}

function tickX(tick: number): number {
  return positionOn(geometry.value.scale, tick)
}
</script>

<template>
  <div class="ledger" :class="{ recessive }">
    <p v-if="recessive && state !== 'chart'" class="copy placeholder">
      The ledger starts once there is a minute to integrate.
    </p>

    <p v-else-if="state === 'too-short'" class="copy placeholder">
      Under a minute of both radios. Not enough to integrate.
    </p>

    <template v-else-if="state === 'chart'">
      <svg
        :viewBox="`0 0 ${box.width} ${box.height}`"
        class="chart"
        role="img"
        :aria-label="summary"
        data-testid="shunt-ledger"
      >
        <defs>
          <!-- No entity hue: we do not know which entity it was. -->
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

        <template v-if="!recessive">
          <text :x="box.left" :y="box.axisY - 30" text-anchor="start" class="pole">− out</text>
          <text :x="box.right" :y="box.axisY - 30" text-anchor="end" class="pole">in +</text>

          <line :x1="box.left" :y1="box.axisY" :x2="box.right" :y2="box.axisY" class="axis" />
          <g v-for="tick in geometry.axis.ticks" :key="tick">
            <line :x1="tickX(tick)" :y1="box.axisY - 5" :x2="tickX(tick)" :y2="box.axisY" class="axis" />
            <text :x="tickX(tick)" :y="box.axisY - 12" text-anchor="middle" class="tick-label">
              {{ tick === 0 ? '0' : Math.abs(tick) }}
            </text>
          </g>
          <!-- The one gridline that is emphasised: a signed figure is a distance from this line. -->
          <line :x1="tickX(0)" :y1="box.axisY" :x2="tickX(0)" :y2="box.spanY + 10" class="zero" />
        </template>

        <rect
          :x="geometry.pack.x"
          :y="box.packY - box.bar / 2"
          :width="geometry.pack.width"
          :height="box.bar"
          rx="2"
          class="bar pack"
        />
        <text :x="8" :y="box.packY + 5" class="row-label">PACK</text>
        <text :x="valueX" :y="box.packY + 5" text-anchor="end" class="value pack-ink">
          {{ signedAh(shown.packAh) }}
        </text>

        <template v-if="solarSeen">
          <rect
            :x="geometry.solar.x"
            :y="box.solarY - box.bar / 2"
            :width="geometry.solar.width"
            :height="box.bar"
            rx="2"
            class="bar solar"
          />
          <text :x="8" :y="box.solarY + 5" class="row-label">SOLAR</text>
          <text :x="valueX" :y="box.solarY + 5" text-anchor="end" class="value solar-ink">
            {{ signedAh(ledger.solarAh) }}
          </text>

          <!-- Caps and rule, not a bar: the house figure is the distance between the two tips. -->
          <text :x="8" :y="box.spanY + 5" class="row-label house-ink">HOUSE</text>
          <rect :x="geometry.house.x - 1" :y="box.spanY - 7" width="2" height="14" class="cap" />
          <rect
            :x="geometry.house.x + geometry.house.width - 1"
            :y="box.spanY - 7"
            width="2"
            height="14"
            class="cap"
          />
          <rect
            :x="geometry.house.x"
            :y="box.spanY - 1"
            :width="geometry.house.width"
            height="2"
            class="rule"
          />
          <text
            v-if="recessive"
            :x="valueX"
            :y="box.spanY + 5"
            text-anchor="end"
            class="value house-ink"
          >
            {{ Math.abs(houseAh).toFixed(1) }} Ah · {{ Math.round(Math.abs(houseWh)) }} Wh
          </text>
          <text
            v-else
            :x="geometry.house.x + geometry.house.width / 2"
            :y="box.figureY"
            text-anchor="middle"
            class="span-figure house-ink"
          >
            {{ Math.abs(houseAh).toFixed(1) }} Ah · {{ Math.round(Math.abs(houseWh)) }} Wh
          </text>
        </template>

        <template v-else>
          <line
            :x1="tickX(0) - 6"
            :y1="box.solarY"
            :x2="tickX(0) + 6"
            :y2="box.solarY"
            class="ghost"
          />
          <text :x="8" :y="box.solarY + 5" class="row-label ghost-ink">SOLAR</text>
          <text :x="8" :y="box.spanY + 5" class="row-label ghost-ink">HOUSE</text>
          <text :x="tickX(0) + 20" :y="box.spanY + 5" class="hint ghost-ink">not measurable</text>
        </template>

        <template v-if="!recessive && geometry.unmeasured">
          <rect
            :x="geometry.unmeasured.x"
            :y="box.unmeasuredY - box.bar / 2"
            :width="geometry.unmeasured.width"
            :height="box.bar"
            rx="2"
            :fill="`url(#${hatchId})`"
            class="unmeasured"
          />
          <!-- Above the bar rather than beside it: this row's name does not fit the label gutter
               the three entity rows share, and shortening it would lose the word that says the
               figure is a floor on charge nobody measured. -->
          <text :x="8" :y="box.unmeasuredY - 13" class="row-label">UNMEASURED IN</text>
          <text :x="valueX" :y="box.unmeasuredY + 5" text-anchor="end" class="value">
            ≥ {{ Math.abs(ledger.foreignAhFloor).toFixed(1) }} Ah
          </text>
        </template>
      </svg>

      <p v-if="!solarSeen && !recessive" class="copy">
        The Victron was never connected, so nothing differences the pack. Solar in and house out
        need both radios; the pack column is complete on its own.
      </p>
    </template>
  </div>
</template>

<style scoped>
.chart {
  width: 100%;
  height: auto;
  display: block;
}

.axis,
.zero {
  stroke: var(--baseline);
  stroke-width: 1;
}

.tick-label,
.pole,
.row-label,
.hint {
  font-family: var(--font-label);
  font-size: var(--svg-label);
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
  font-size: var(--svg-value);
  font-weight: 500;
  fill: var(--ink);
}

/*
 * No transition on any mark here or below. The live band is fed a fresh ledger once a second, and a
 * 400 ms glide would spend 400 ms interpolating toward a total no fold ever produced, followed by
 * 600 ms of dead stop — a stop-start cycle is exactly what peripheral vision is tuned to.
 */
.bar.pack {
  fill: var(--pack);
}

.bar.solar {
  fill: var(--solar);
}

.cap,
.rule {
  fill: var(--house);
}

/* Thin enough that the bar reads as hatched rather than as a solid light block, which is what a
   heavier stroke on an 8-unit pitch collapses into. */
.hatch-line {
  stroke: var(--ink-muted);
  stroke-width: 1.5;
}

.unmeasured {
  stroke: var(--ink-muted);
  stroke-width: 1;
}

.pack-ink {
  fill: var(--pack-ink);
}
.solar-ink {
  fill: var(--solar-ink);
}
.house-ink {
  fill: var(--house-ink);
}

.ghost {
  stroke: var(--ink-muted);
  stroke-width: 2;
}

.ghost-ink {
  fill: var(--ink-muted);
}

/* The one figure the page exists to produce, so it is set larger than the two it is derived from. */
.span-figure {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 20px;
  font-weight: 600;
}

.placeholder {
  margin: 0;
  color: var(--ink-muted);
}

.recessive .value {
  font-size: var(--svg-label);
  fill: var(--ink-secondary);
}

.copy {
  margin: 0.5rem 0 0;
}
</style>
