<script setup lang="ts">
/**
 * Cells as deviation from the pack mean, on a true zero line.
 *
 * Absolute cell voltages differ by a few millivolts out of ~3400, so a bar chart of
 * absolute values would need a truncated baseline to show anything — which lies about
 * proportion. Deviation from the mean has an honest zero and shows exactly the quantity
 * that matters: which cell is drifting, and by how much.
 */
import { computed } from 'vue'

import StatusChip from './StatusChip.vue'
import { milliohms, millivolts } from '../application/format'
import type { BatterySnapshot } from '../domain/bms/types'

const props = defineProps<{ battery: BatterySnapshot; balanceTrigger: number | null }>()

const mean = computed(
  () => props.battery.cellVoltages.reduce((total, value) => total + value, 0) / props.battery.cellVoltages.length,
)

const deviations = computed(() =>
  props.battery.cellVoltages.map((voltage, index) => ({
    index: index + 1,
    voltage,
    resistance: props.battery.cellResistances[index] ?? 0,
    deviationMv: (voltage - mean.value) * 1000,
  })),
)

const scale = computed(() => Math.max(4, ...deviations.value.map((cell) => Math.abs(cell.deviationMv))) * 1.2)

/** A deviation that rounds to zero is zero — never "−0". */
function signedMv(deviationMv: number): string {
  const rounded = Math.round(deviationMv)
  if (rounded === 0) return '0'
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}`
}

const spreadLevel = computed(() => {
  const spread = props.battery.cellDelta
  if (spread >= 0.05) return 'serious' as const
  if (spread >= (props.balanceTrigger ?? 0.01)) return 'warning' as const
  return 'good' as const
})
</script>

<template>
  <section class="panel">
    <header>
      <h2 class="plate">Cell balance</h2>
      <StatusChip :level="spreadLevel" :label="`spread ${millivolts(battery.cellDelta)}`" />
    </header>
    <p class="muted">deviation from mean {{ (mean * 1000).toFixed(0) }} mV</p>

    <ul class="ladder">
      <li v-for="cell in deviations" :key="cell.index">
        <span class="tag">c{{ cell.index }}</span>
        <span class="track">
          <span class="zero" aria-hidden="true" />
          <span
            class="bar"
            :style="{
              left: `${50 + Math.min(0, cell.deviationMv / scale * 50)}%`,
              width: `${Math.abs(cell.deviationMv / scale) * 50}%`,
            }"
          />
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

.bar {
  position: absolute;
  top: 2px;
  bottom: 2px;
  min-width: 1px;
  background: var(--pack);
  border-radius: 1px;
  transition:
    left 400ms cubic-bezier(0.2, 0.7, 0.2, 1),
    width 400ms cubic-bezier(0.2, 0.7, 0.2, 1);
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
