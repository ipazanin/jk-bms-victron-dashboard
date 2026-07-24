<script setup lang="ts">
/**
 * The energy-flow schematic.
 *
 * One horizontal DC bus. Solar feeds in from the left, the house draws off to the right, the
 * pack hangs below and swings between charging and discharging. Each edge is a pipe whose WIDTH
 * carries the magnitude and whose marching dashes carry the direction; width is the channel that
 * survives with the dashes frozen, so the picture stays true under reduced motion.
 *
 * Purely presentational — every figure arrives as a prop, the same bindings that feed the shunt
 * beneath. The component never fabricates a flow it cannot measure: solar with no controller and a
 * house load the difference cannot vouch for both render as static muted ghosts, honestly labelled
 * "no reading", rather than as a confident line to nowhere.
 *
 * Geometry is a fixed viewBox with every mark on constant coordinates. A value update rewrites only
 * text content, a stroke width, and the flow period — never an x, a y, a d, or a points list — so a
 * changing reading reflows nothing and cannot perturb the sibling ammeter's steady labels.
 */
import { computed, ref, watch } from 'vue'

import { amps, ampsAbsolute, volts, watts } from '../../application/format'
import { useMediaQuery } from '../../application/useMediaQuery'
import type { Reach } from '../../domain/reach'
import { CURRENT_LADDER, nextStop } from '../../domain/scaleLadder'

const props = defineProps<{
  packCurrent: number
  packVoltage: number
  solarCurrent: number | null
  pvPower: number | null
  houseCurrent: number | null
  housePower: number | null
  houseLoadPlausible: boolean | null
  packReach: Reach | null
  solarReach: Reach | null
}>()

/** Flow deadband, matching the shunt: below this a reading rounds to zero and carries no direction. */
const REST = 0.05

type Anchor = 'start' | 'middle' | 'end'
interface Rect {
  x: number
  y: number
  w: number
  h: number
}
interface NodeGeo extends Rect {
  cx: number
  glyphX: number
  nameY: number
  primaryY: number
  subY: number
}
interface EdgeGeo {
  d: string
  readX: number
  readY: number
  readAnchor: Anchor
  headForward: string
  headReverse: string
}
interface Geometry {
  viewBox: string
  solar: NodeGeo
  house: NodeGeo
  pack: NodeGeo
  bus: NodeGeo
  edges: { solar: EdgeGeo; house: EdgeGeo; pack: EdgeGeo }
}

/**
 * Text anchors derived once from a constant node rect, so they are themselves constant per
 * breakpoint. `twoLine` is the small hub, which carries only a name and the bus voltage.
 */
function nodeGeo(rect: Rect, twoLine = false): NodeGeo {
  const cx = rect.x + rect.w / 2
  const glyphX = rect.x + 18
  if (twoLine) {
    return { ...rect, cx, glyphX, nameY: rect.y + 24, primaryY: rect.y + 44, subY: rect.y + 44 }
  }
  return {
    ...rect,
    cx,
    glyphX,
    nameY: rect.y + 26,
    primaryY: rect.y + rect.h * 0.6 + 6,
    subY: rect.y + rect.h * 0.6 + 26,
  }
}

// Both viewBoxes are constant strings; the layout only ever swaps wholesale on breakpoint.
const DESKTOP_GEO: Geometry = {
  viewBox: '0 0 960 300',
  solar: nodeGeo({ x: 24, y: 86, w: 176, h: 84 }),
  house: nodeGeo({ x: 760, y: 86, w: 176, h: 84 }),
  pack: nodeGeo({ x: 392, y: 212, w: 176, h: 80 }),
  bus: nodeGeo({ x: 438, y: 98, w: 84, h: 60 }, true),
  edges: {
    solar: {
      d: 'M200,128 L438,128',
      readX: 319,
      readY: 110,
      readAnchor: 'middle',
      headForward: '438,128 426,121 426,135',
      headReverse: '',
    },
    house: {
      d: 'M522,128 L760,128',
      readX: 641,
      readY: 110,
      readAnchor: 'middle',
      headForward: '760,128 748,121 748,135',
      headReverse: '',
    },
    pack: {
      d: 'M480,158 L480,212',
      readX: 508,
      readY: 190,
      readAnchor: 'start',
      headForward: '480,212 473,200 487,200',
      headReverse: '480,158 473,170 487,170',
    },
  },
}

const PHONE_GEO: Geometry = {
  viewBox: '0 0 480 600',
  solar: nodeGeo({ x: 150, y: 26, w: 300, h: 88 }),
  house: nodeGeo({ x: 150, y: 486, w: 300, h: 88 }),
  pack: nodeGeo({ x: 21, y: 252, w: 190, h: 96 }),
  bus: nodeGeo({ x: 254, y: 270, w: 92, h: 60 }, true),
  edges: {
    solar: {
      d: 'M300,114 L300,270',
      readX: 318,
      readY: 196,
      readAnchor: 'start',
      headForward: '300,270 293,258 307,258',
      headReverse: '',
    },
    house: {
      d: 'M300,330 L300,486',
      readX: 318,
      readY: 412,
      readAnchor: 'start',
      headForward: '300,486 293,474 307,474',
      headReverse: '',
    },
    pack: {
      d: 'M254,300 L211,300',
      readX: 232,
      readY: 286,
      readAnchor: 'middle',
      headForward: '211,300 223,293 223,307',
      headReverse: '254,300 242,293 242,307',
    },
  },
}

const compact = useMediaQuery('(max-width: 720px)')
const geo = computed(() => (compact.value ? PHONE_GEO : DESKTOP_GEO))

const solarPresent = computed(() => props.solarCurrent !== null)

/**
 * House = solar − pack is a real load only while solar is the sole charger. reconcile() flags the
 * case where the pack takes more than the panels give — another source is on the bus — and we
 * withhold the figure rather than paint the negative difference as a draw.
 */
const houseKnown = computed(
  () => solarPresent.value && props.houseCurrent !== null && props.houseLoadPlausible === true,
)
const houseCharged = computed(
  () => solarPresent.value && props.houseCurrent !== null && props.houseLoadPlausible === false,
)

const packFlow = computed<'charging' | 'discharging' | 'at rest'>(() =>
  props.packCurrent > REST ? 'charging' : props.packCurrent < -REST ? 'discharging' : 'at rest',
)

/**
 * The shared current scale, auto-ranged off the recent envelope with hysteresis, so one spike
 * cannot rescale the whole picture mid-read. Same mechanism, same ladder as the shunt beneath.
 */
const reachA = computed(() => {
  const edges = [
    Math.abs(props.packCurrent),
    Math.abs(props.solarCurrent ?? 0),
    houseKnown.value ? Math.abs(props.houseCurrent!) : 0,
  ]
  for (const band of [props.packReach, props.solarReach]) {
    if (band) edges.push(Math.abs(band.low), Math.abs(band.high))
  }
  return Math.max(...edges)
})

const domain = ref(CURRENT_LADDER.stops[1])

// The stop in force is state — grows on sight, releases on hysteresis — so it cannot be a computed.
watch(reachA, (value) => (domain.value = nextStop(CURRENT_LADDER, domain.value, value)), {
  immediate: true,
})

function intensity(magnitude: number): number {
  if (domain.value <= 0) return 0
  return Math.max(0, Math.min(1, magnitude / domain.value))
}

// sqrt keeps a small current visible; 2px is the dataviz floor, 12px the full-scale ceiling. Width
// is the magnitude channel and is the one thing legible with the animation off.
function strokeWidth(magnitude: number): number {
  return 2 + 10 * Math.sqrt(intensity(magnitude))
}

/**
 * The marching line rides THIN down the middle of the magnitude pipe. A dash as fat as the pipe just
 * doubles its weight and smears into the arrowhead; a thin bright dash on the dim band reads as flow.
 */
function flowWidth(pipe: number): number {
  return Math.max(2, Math.min(3.5, pipe * 0.5))
}

// 2.6s slow … 0.55s fast. Bound as an inline var; changing it on a live animation is a timing
// change, never layout.
function flowPeriod(magnitude: number): number {
  return 2.6 - 2.05 * intensity(magnitude)
}

const solarMagnitude = computed(() => props.solarCurrent ?? 0)
const packMagnitude = computed(() => Math.abs(props.packCurrent))
const houseMagnitude = computed(() => (houseKnown.value ? Math.abs(props.houseCurrent!) : 0))

type EdgeState = 'active' | 'idle' | 'ghost'

const solarState = computed<EdgeState>(() =>
  !solarPresent.value ? 'ghost' : props.solarCurrent! > REST ? 'active' : 'idle',
)
const packState = computed<EdgeState>(() => (packFlow.value === 'at rest' ? 'idle' : 'active'))
const houseState = computed<EdgeState>(() =>
  houseKnown.value ? (houseMagnitude.value > REST ? 'active' : 'idle') : 'ghost',
)

const solarWidth = computed(() =>
  solarState.value === 'active' ? strokeWidth(solarMagnitude.value) : 2,
)
const packWidth = computed(() => (packState.value === 'active' ? strokeWidth(packMagnitude.value) : 2))
const houseWidth = computed(() =>
  houseState.value === 'active' ? strokeWidth(houseMagnitude.value) : 2,
)

const solarFlowWidth = computed(() => flowWidth(solarWidth.value))
const packFlowWidth = computed(() => flowWidth(packWidth.value))
const houseFlowWidth = computed(() => flowWidth(houseWidth.value))

const solarPeriod = computed(() => `${flowPeriod(solarMagnitude.value).toFixed(2)}s`)
const packPeriod = computed(() => `${flowPeriod(packMagnitude.value).toFixed(2)}s`)
const housePeriod = computed(() => `${flowPeriod(houseMagnitude.value).toFixed(2)}s`)

const packReverse = computed(() => packFlow.value === 'discharging')
const packHead = computed(() =>
  packFlow.value === 'charging' ? geo.value.edges.pack.headForward : geo.value.edges.pack.headReverse,
)

// Node contents. Every figure is printed, so nothing on the diagram is animation-only.
const solarPrimary = computed(() => (props.pvPower !== null ? watts(props.pvPower) : '—'))
const solarSub = computed(() => amps(props.solarCurrent ?? 0))

const packPrimary = computed(() => amps(props.packCurrent))
const packSub = computed(() => `${volts(props.packVoltage, 2)} · ${packFlow.value}`)

const housePrimary = computed(() => (props.housePower !== null ? watts(props.housePower) : '—'))
const houseSub = computed(() => (props.houseCurrent !== null ? ampsAbsolute(props.houseCurrent) : '—'))
const houseNote = computed(() =>
  houseCharged.value ? 'unavailable — another source charging' : 'no reading',
)

const busVolts = computed(() => volts(props.packVoltage, 1))

// Edge readouts. Idle edges still read '0.0 A · 0 W'; ghosts read nothing (the node carries the note).
const solarRead = computed(() => {
  if (!solarPresent.value) return ''
  const magnitude = ampsAbsolute(props.solarCurrent!)
  if (props.solarCurrent! <= REST) return `${magnitude} · 0 W`
  return props.pvPower !== null ? `${magnitude} · ${watts(props.pvPower)}` : magnitude
})
const houseRead = computed(() => {
  if (!houseKnown.value) return ''
  const magnitude = ampsAbsolute(props.houseCurrent!)
  if (houseMagnitude.value <= REST) return `${magnitude} · 0 W`
  return props.housePower !== null ? `${magnitude} · ${watts(props.housePower)}` : magnitude
})
const packRead = computed(() =>
  packFlow.value === 'at rest'
    ? amps(props.packCurrent)
    : `${amps(props.packCurrent)} · ${watts(props.packCurrent * props.packVoltage)}`,
)

// The aria sentence carries direction in words, so the arrowhead is never the only direction channel.
function cap(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

const solarPhrase = computed(() =>
  !solarPresent.value
    ? 'solar not connected'
    : props.solarCurrent! <= REST
      ? 'solar idle'
      : props.pvPower !== null
        ? `Solar ${watts(props.pvPower)} in`
        : `Solar ${ampsAbsolute(props.solarCurrent!)} in`,
)

const packPhrase = computed(() =>
  packFlow.value === 'at rest'
    ? 'pack at rest'
    : `pack ${packFlow.value} ${ampsAbsolute(props.packCurrent)}`,
)

const housePhrase = computed(() =>
  houseKnown.value
    ? props.housePower !== null
      ? `boat ${watts(props.housePower)} out`
      : `boat ${ampsAbsolute(props.houseCurrent!)} out`
    : houseCharged.value
      ? 'boat load unavailable, another source charging'
      : 'boat load not measured',
)

const summary = computed(
  () => `${cap(solarPhrase.value)}, ${packPhrase.value}, ${housePhrase.value}.`,
)
</script>

<template>
  <section class="flow-card">
    <header class="head">
      <h2 class="plate">Energy flow</h2>
      <p class="muted">solar · bus · boat · pack</p>
    </header>

    <svg
      :viewBox="geo.viewBox"
      class="diagram"
      role="img"
      :aria-label="summary"
      data-testid="energy-flow"
    >
      <!-- Edges first, so their pipes tuck under the node rects at each end. -->
      <g class="edge solar" :class="solarState" :style="{ '--flow-period': solarPeriod }">
        <template v-if="solarState === 'ghost'">
          <path class="ghost-pipe" :d="geo.edges.solar.d" />
        </template>
        <template v-else>
          <path class="pipe" :d="geo.edges.solar.d" :stroke-width="solarWidth" />
          <path
            v-if="solarState === 'active'"
            class="flow"
            :d="geo.edges.solar.d"
            :stroke-width="solarFlowWidth"
          />
          <polygon
            v-if="solarState === 'active'"
            class="head"
            :points="geo.edges.solar.headForward"
            aria-hidden="true"
          />
          <text
            class="edge-read solar-ink"
            :x="geo.edges.solar.readX"
            :y="geo.edges.solar.readY"
            :text-anchor="geo.edges.solar.readAnchor"
          >
            {{ solarRead }}
          </text>
        </template>
      </g>

      <g class="edge house" :class="houseState" :style="{ '--flow-period': housePeriod }">
        <template v-if="houseState === 'ghost'">
          <path class="ghost-pipe" :d="geo.edges.house.d" />
        </template>
        <template v-else>
          <path class="pipe" :d="geo.edges.house.d" :stroke-width="houseWidth" />
          <path
            v-if="houseState === 'active'"
            class="flow"
            :d="geo.edges.house.d"
            :stroke-width="houseFlowWidth"
          />
          <polygon
            v-if="houseState === 'active'"
            class="head"
            :points="geo.edges.house.headForward"
            aria-hidden="true"
          />
          <text
            class="edge-read house-ink"
            :x="geo.edges.house.readX"
            :y="geo.edges.house.readY"
            :text-anchor="geo.edges.house.readAnchor"
          >
            {{ houseRead }}
          </text>
        </template>
      </g>

      <g class="edge pack" :class="packState" :style="{ '--flow-period': packPeriod }">
        <path class="pipe" :d="geo.edges.pack.d" :stroke-width="packWidth" />
        <path
          v-if="packState === 'active'"
          class="flow"
          :class="{ reverse: packReverse }"
          :d="geo.edges.pack.d"
          :stroke-width="packFlowWidth"
        />
        <polygon
          v-if="packState === 'active'"
          class="head"
          :points="packHead"
          aria-hidden="true"
        />
        <text
          class="edge-read pack-ink"
          :x="geo.edges.pack.readX"
          :y="geo.edges.pack.readY"
          :text-anchor="geo.edges.pack.readAnchor"
        >
          {{ packRead }}
        </text>
      </g>

      <!-- Nodes on top. -->
      <g class="node solar" :class="{ dim: !solarPresent }">
        <rect :x="geo.solar.x" :y="geo.solar.y" :width="geo.solar.w" :height="geo.solar.h" rx="16" />
        <text class="glyph" :x="geo.solar.glyphX" :y="geo.solar.nameY" aria-hidden="true">☀</text>
        <text class="node-name" :x="geo.solar.cx" :y="geo.solar.nameY" text-anchor="middle">SOLAR</text>
        <template v-if="solarPresent">
          <text class="node-primary solar-ink" :x="geo.solar.cx" :y="geo.solar.primaryY" text-anchor="middle">
            {{ solarPrimary }}
          </text>
          <text class="node-sub" :x="geo.solar.cx" :y="geo.solar.subY" text-anchor="middle">
            {{ solarSub }}
          </text>
        </template>
        <text v-else class="node-note" :x="geo.solar.cx" :y="geo.solar.primaryY" text-anchor="middle">
          no controller
        </text>
      </g>

      <g class="node pack">
        <rect :x="geo.pack.x" :y="geo.pack.y" :width="geo.pack.w" :height="geo.pack.h" rx="16" />
        <text class="glyph" :x="geo.pack.glyphX" :y="geo.pack.nameY" aria-hidden="true">▮</text>
        <text class="node-name" :x="geo.pack.cx" :y="geo.pack.nameY" text-anchor="middle">PACK</text>
        <text class="node-primary pack-ink" :x="geo.pack.cx" :y="geo.pack.primaryY" text-anchor="middle">
          {{ packPrimary }}
        </text>
        <text class="node-sub" :x="geo.pack.cx" :y="geo.pack.subY" text-anchor="middle">
          {{ packSub }}
        </text>
      </g>

      <g class="node house" :class="{ dim: !houseKnown }">
        <rect :x="geo.house.x" :y="geo.house.y" :width="geo.house.w" :height="geo.house.h" rx="16" />
        <text class="glyph" :x="geo.house.glyphX" :y="geo.house.nameY" aria-hidden="true">⚓</text>
        <text class="node-name" :x="geo.house.cx" :y="geo.house.nameY" text-anchor="middle">BOAT</text>
        <template v-if="houseKnown">
          <text class="node-primary house-ink" :x="geo.house.cx" :y="geo.house.primaryY" text-anchor="middle">
            {{ housePrimary }}
          </text>
          <text class="node-sub" :x="geo.house.cx" :y="geo.house.subY" text-anchor="middle">
            {{ houseSub }}
          </text>
        </template>
        <text v-else class="node-note" :x="geo.house.cx" :y="geo.house.primaryY" text-anchor="middle">
          {{ houseNote }}
        </text>
      </g>

      <g class="node hub">
        <rect :x="geo.bus.x" :y="geo.bus.y" :width="geo.bus.w" :height="geo.bus.h" rx="12" />
        <text class="hub-name" :x="geo.bus.cx" :y="geo.bus.nameY" text-anchor="middle">DC BUS</text>
        <text class="hub-volts" :x="geo.bus.cx" :y="geo.bus.subY" text-anchor="middle">
          {{ busVolts }}
        </text>
      </g>
    </svg>
  </section>
</template>

<style scoped>
/* Surface, edge, radius and shadow come from the shared `.card` class BusView passes onto this
   root; the component supplies only its own padding, the same split ShuntAmmeter and SolarRow use. */
.flow-card {
  padding: var(--pad);
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin: 0 0 0.5rem;
}

.head h2 {
  margin: 0;
}

/*
 * Fixed viewBox, height a pure function of container width. The steadiness run holds the viewport
 * width fixed, so scrollHeight takes exactly one value — the same reason the shunt passes.
 */
.diagram {
  width: 100%;
  height: auto;
  display: block;
  overflow: hidden;
}

/*
 * The animation surface is exactly the marching dashes. Nothing here carries a transition: every
 * mark is fed a 1 Hz target with no filter behind it, so a glide would interpolate toward a value
 * no radio reported, once a second, forever. Width and content snap.
 */
.pipe,
.flow {
  fill: none;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}

/* The dim channel: the magnitude pipe under the bright marching overlay. */
.pipe {
  opacity: 0.32;
}

.flow {
  opacity: 0.95;
  stroke-dasharray: 9 13;
  animation: march var(--flow-period, 1.4s) linear infinite;
}

/* Discharge runs the pack edge backwards; the arrowhead flips to match. */
.flow.reverse {
  animation-direction: reverse;
}

.head {
  stroke: none;
}

/*
 * A ghost is an honest "no reading": static muted dashes, no overlay, no arrowhead. Never a
 * fabricated flow.
 */
.ghost-pipe {
  fill: none;
  stroke: var(--ink-muted);
  stroke-width: 2;
  stroke-dasharray: 4 6;
  opacity: 0.7;
  vector-effect: non-scaling-stroke;
}

.edge.solar .pipe,
.edge.solar .flow {
  stroke: var(--solar);
}
.edge.solar .head {
  fill: var(--solar);
}
.edge.pack .pipe,
.edge.pack .flow {
  stroke: var(--pack);
}
.edge.pack .head {
  fill: var(--pack);
}
.edge.house .pipe,
.edge.house .flow {
  stroke: var(--house);
}
.edge.house .head {
  fill: var(--house);
}

/* One cell of the desktop dasharray (9 + 13); the phone override marches its own 7 + 10 cell. */
@keyframes march {
  to {
    stroke-dashoffset: -22;
  }
}
@keyframes march-phone {
  to {
    stroke-dashoffset: -17;
  }
}

.node rect {
  fill: var(--card);
  stroke: var(--card-border);
  stroke-width: 1;
}

.node.hub rect {
  fill: var(--raised);
}

/* A ghosted node recedes; its note text carries the reason. */
.node.dim rect {
  opacity: 0.6;
}

.node-name,
.hub-name {
  font-family: var(--font-label);
  font-size: 13px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  fill: var(--ink-muted);
}

.node-primary {
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 22px;
  font-variant-numeric: tabular-nums;
  fill: var(--ink);
}

.node-sub,
.hub-volts,
.edge-read {
  font-family: var(--font-mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  fill: var(--ink-secondary);
}

.node-note {
  font-family: var(--font-body);
  font-size: 13px;
  fill: var(--ink-muted);
}

.glyph {
  font-size: 15px;
  fill: var(--ink-muted);
}

.solar-ink {
  fill: var(--solar-ink);
}
.pack-ink {
  fill: var(--pack-ink);
}
.house-ink {
  fill: var(--house-ink);
}

@media (max-width: 720px) {
  .flow {
    stroke-dasharray: 7 10;
    animation-name: march-phone;
  }
}

/*
 * With motion off the diagram leans on nothing animated: drop the frozen dashes entirely and let
 * the solid magnitude-width pipe, the static arrowhead, and every printed figure carry it.
 */
@media (prefers-reduced-motion: reduce) {
  .flow {
    display: none;
  }
  .pipe {
    opacity: 0.95;
  }
}
</style>
