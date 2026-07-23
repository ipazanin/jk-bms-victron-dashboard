<script setup lang="ts">
/**
 * Cells as deviation from the pack mean, on a true zero line.
 *
 * Absolute cell voltages differ by a few millivolts out of ~3400, so a bar chart of
 * absolute values would need a truncated baseline to show anything — which lies about
 * proportion. Deviation from the mean has an honest zero and shows exactly the quantity
 * that matters: which cell is drifting, and by how much.
 *
 * The full scale is a ladder of round stops driven by the last thirty seconds rather than by the
 * instant. Renormalising to the data on every sample would make the longest bar the same length
 * whatever it measures — a 7 mV spread and an 18 mV spread drawing the identical picture — and
 * would let one cell sagging under load re-map its three neighbours between one frame and the next.
 *
 * The chip reports the separated verdict, not the raw spread: under a swinging load most of
 * `cellDelta` is path resistance, which is a terminal to check and not a cell to balance.
 */
import { computed, ref, watch } from 'vue'

import StatusChip from './StatusChip.vue'
import { milliohms } from '../application/format'
import type { FaultLevel } from '../application/severity'
import type { BatterySnapshot } from '../domain/bms/types'
import { deviationsMv } from '../domain/cellBalance'
import type { BalanceVerdict } from '../domain/cellBalance'
import type { Reach } from '../domain/reach'
import { CELL_DEVIATION_LADDER, nextStop } from '../domain/scaleLadder'

const props = defineProps<{
  battery: BatterySnapshot
  /** Volts, from the BMS's own configuration. Null when it never reported one. */
  balanceTrigger: number | null
  /** Null before a window exists, and over remembered or stored data, where nothing was fitted. */
  balance: BalanceVerdict | null
  /** Reach of the largest deviation over the last thirty seconds — what the scale follows. */
  cellReach: Reach | null
}>()

/** Volts of spread, and only a default: the BMS's own balance trigger wins when it reports one. */
const DEFAULT_TRIGGER_V = 0.01
/** Volts. Above this the raw spread is serious whatever its cause, so the chip says so ungated. */
const SERIOUS_SPREAD_V = 0.05

const mean = computed(
  () =>
    props.battery.cellVoltages.reduce((total, value) => total + value, 0) /
    props.battery.cellVoltages.length,
)

/**
 * What the ladder follows: the window when there is one, and the instant when there is not.
 * A remembered or stored pack has no window, and its bars are still owed a scale.
 */
const reachMv = computed(() => {
  if (props.cellReach !== null) return props.cellReach.high
  let largest = 0
  for (const deviationMv of deviationsMv(props.battery.cellVoltages)) {
    const magnitude = Math.abs(deviationMv)
    if (magnitude > largest) largest = magnitude
  }
  return largest
})

const scaleMv = ref(CELL_DEVIATION_LADDER.stops[0])

watch(
  reachMv,
  (reach) => (scaleMv.value = nextStop(CELL_DEVIATION_LADDER, scaleMv.value, reach)),
  { immediate: true },
)

const cells = computed(() =>
  deviationsMv(props.battery.cellVoltages).map((deviationMv, index) => {
    // Clamped so a deviation past the top stop is pinned at the end of the track rather than
    // drawn beyond it, where it would be silently cut off.
    const offset = Math.max(-1, Math.min(1, deviationMv / scaleMv.value))
    return {
      index: index + 1,
      voltage: props.battery.cellVoltages[index],
      resistance: props.battery.cellResistances[index] ?? 0,
      deviationMv,
      left: `${50 + Math.min(0, offset) * 50}%`,
      width: `${Math.abs(offset) * 50}%`,
    }
  }),
)

/** A deviation that rounds to zero is zero — never "−0". */
function signedMv(deviationMv: number): string {
  const rounded = Math.round(deviationMv)
  if (rounded === 0) return '0'
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}`
}

/** The charge divergence a balancer can act on, once the load term has been taken out of it. */
const spreadMv = computed(() => {
  const verdict = props.balance
  if (verdict === null) return props.battery.cellDelta * 1000
  return verdict.kind === 'fitted' ? verdict.balanceSpreadMv : verdict.rawSpreadMv
})

const spreadLevel = computed<FaultLevel>(() => {
  if (props.battery.cellDelta >= SERIOUS_SPREAD_V) return 'serious'
  return spreadMv.value >= (props.balanceTrigger ?? DEFAULT_TRIGGER_V) * 1000 ? 'warning' : 'good'
})

/** 'corrected' is claimed only when the load actually varied enough to separate the two terms. */
const spreadLabel = computed(() => {
  const figure = `spread ${Math.round(spreadMv.value)} mV`
  if (props.balance === null) return figure
  return `${figure} ${props.balance.kind === 'fitted' ? 'corrected' : 'uncorrected'}`
})

/**
 * Null until a fit identifies it. A measurement that has not been made is never drawn in a status
 * colour: StatusChip has four levels and none of them means "we did not measure this".
 */
const jointSpread = computed(() =>
  props.balance?.kind === 'fitted' ? `${(props.balance.jointSpread * 1000).toFixed(1)} mΩ` : null,
)
</script>

<template>
  <section class="panel">
    <header>
      <h2 class="plate">Cell balance</h2>
      <StatusChip :level="spreadLevel" :label="spreadLabel" />
    </header>

    <p class="joint">
      <span class="plate">Joint spread</span>
      <span class="readout" :class="{ unmeasured: jointSpread === null }">
        {{ jointSpread ?? '— needs a load change' }}
      </span>
    </p>

    <p class="muted">
      deviation from mean {{ (mean * 1000).toFixed(0) }} mV · ±{{ scaleMv }} mV full scale
    </p>

    <ul class="ladder">
      <li v-for="cell in cells" :key="cell.index">
        <span class="tag">c{{ cell.index }}</span>
        <span class="track">
          <span class="zero" aria-hidden="true" />
          <span class="bar" :style="{ left: cell.left, width: cell.width }" />
        </span>
        <span class="dev readout">{{ signedMv(cell.deviationMv) }}</span>
        <span class="abs readout">{{ (cell.voltage * 1000).toFixed(0) }} mV</span>
        <span class="res readout">{{ milliohms(cell.resistance) }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.panel {
  padding: var(--pad);
}

header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
}

h2 {
  margin: 0;
}

.joint {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.5rem 0 0;
}

.joint .readout {
  font-size: 0.8125rem;
  color: var(--ink-secondary);
}

.unmeasured {
  color: var(--ink-muted);
}

.muted {
  margin: 0.25rem 0 0.9rem;
}

.ladder {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.45rem;
}

.ladder li {
  display: grid;
  grid-template-columns: 1.75rem 1fr 2.75rem 3.75rem 3.25rem;
  align-items: center;
  gap: 0.5rem;
}

.tag {
  font-family: var(--font-label);
  font-size: 0.8125rem;
  color: var(--ink-muted);
  text-transform: uppercase;
}

.track {
  position: relative;
  height: 12px;
  background: var(--raised);
  border-radius: 2px;
}

.zero {
  position: absolute;
  left: 50%;
  top: -2px;
  bottom: -2px;
  width: 1px;
  background: var(--baseline);
}

/*
 * No transition. These bars are fed a 1 Hz target, so a 400 ms glide runs for the first four
 * tenths of every second and dead-stops for the other six — and motion onset is what peripheral
 * vision is tuned to. A mark that steps once and holds is quieter than one that never settles.
 */
.bar {
  position: absolute;
  top: 2px;
  bottom: 2px;
  min-width: 1px;
  background: var(--pack);
  border-radius: 1px;
}

.dev {
  text-align: right;
  color: var(--ink);
}

.abs,
.res {
  text-align: right;
  color: var(--ink-muted);
  font-size: 0.8125rem;
}

@media (max-width: 720px) {
  .ladder li {
    grid-template-columns: 1.75rem 1fr 2.75rem 3.75rem;
  }
  .res {
    display: none;
  }
}
</style>
