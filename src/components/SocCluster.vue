<script setup lang="ts">
import { computed } from 'vue'

import { ampHours, hours, volts } from '../application/format'
import type { BatterySnapshot } from '../domain/bms/types'

const props = defineProps<{
  battery: BatterySnapshot
  toFull: number | null
  toEmpty: number | null
}>()

const fraction = computed(() => Math.min(1, Math.max(0, props.battery.stateOfCharge / 100)))
const low = computed(() => props.battery.stateOfCharge <= 20)
</script>

<template>
  <section class="panel">
    <h2 class="plate">State of charge</h2>

    <p class="hero-figure" :class="{ low }">{{ battery.stateOfCharge }}<span class="unit">%</span></p>

    <div class="meter" role="img" :aria-label="`${battery.stateOfCharge} percent charged`">
      <div class="fill" :style="{ width: `${fraction * 100}%` }" />
      <div class="threshold" :style="{ left: '20%' }" aria-hidden="true" />
    </div>

    <dl class="stats">
      <div>
        <dt class="plate">Capacity</dt>
        <dd class="readout">{{ ampHours(battery.remainingCapacity) }} / {{ ampHours(battery.nominalCapacity) }}</dd>
      </div>
      <div>
        <dt class="plate">Pack</dt>
        <dd class="readout">{{ volts(battery.packVoltage) }}</dd>
      </div>
      <div v-if="toFull !== null">
        <dt class="plate">To full</dt>
        <dd class="readout">{{ toFull === 0 ? 'full' : hours(toFull) }}</dd>
      </div>
      <div v-else-if="toEmpty !== null">
        <dt class="plate">To empty</dt>
        <dd class="readout">{{ hours(toEmpty) }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.panel {
  padding: var(--pad);
}

.hero-figure {
  margin: 0.5rem 0 0.75rem;
}

.hero-figure.low {
  color: var(--status-warning);
}

.unit {
  font-size: 1.5rem;
  font-weight: 500;
  color: var(--ink-secondary);
  margin-left: 0.15rem;
}

.meter {
  position: relative;
  height: 10px;
  background: var(--raised);
  border-radius: 2px;
  overflow: hidden;
}

.fill {
  height: 100%;
  background: var(--pack);
  transition: width 400ms cubic-bezier(0.2, 0.7, 0.2, 1);
}

.threshold {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--baseline);
}

.stats {
  display: grid;
  gap: 0.5rem;
  margin: 1rem 0 0;
}

.stats div {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

dt,
dd {
  margin: 0;
}

dd {
  color: var(--ink);
}
</style>
