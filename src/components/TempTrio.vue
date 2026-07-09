<script setup lang="ts">
import { computed } from 'vue'

import StatusChip from './StatusChip.vue'
import { celsius } from '../application/format'
import type { FaultLevel } from '../application/telemetry'
import type { BatterySnapshot } from '../domain/bms/types'

const props = defineProps<{ battery: BatterySnapshot }>()

const AXIS_MIN = 0
const AXIS_MAX = 90

function level(value: number, warn: number, serious: number, critical: number): FaultLevel {
  if (value >= critical) return 'critical'
  if (value >= serious) return 'serious'
  if (value >= warn) return 'warning'
  return 'good'
}

const gauges = computed(() => [
  { label: 'MOSFET', value: props.battery.mosfetTemperature, level: level(props.battery.mosfetTemperature, 55, 70, 80) },
  { label: 'Cell 1', value: props.battery.temperatureSensor1, level: level(props.battery.temperatureSensor1, 45, 55, 65) },
  { label: 'Cell 2', value: props.battery.temperatureSensor2, level: level(props.battery.temperatureSensor2, 45, 55, 65) },
])

function fraction(value: number): number {
  return Math.min(1, Math.max(0, (value - AXIS_MIN) / (AXIS_MAX - AXIS_MIN)))
}

const hottest = computed(() => gauges.value.reduce((worst, gauge) => (gauge.value > worst.value ? gauge : worst)))
</script>

<template>
  <section class="panel">
    <header>
      <h2 class="plate">Temperatures</h2>
      <StatusChip :level="hottest.level" :label="celsius(hottest.value, 0)" />
    </header>

    <ul class="gauges">
      <li v-for="gauge in gauges" :key="gauge.label">
        <span class="tag">{{ gauge.label }}</span>
        <span class="track">
          <span class="fill" :class="gauge.level" :style="{ width: `${fraction(gauge.value) * 100}%` }" />
        </span>
        <span class="value readout">{{ celsius(gauge.value) }}</span>
      </li>
    </ul>
    <p class="muted">scale 0–90 °C</p>
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

.gauges {
  list-style: none;
  margin: 0.9rem 0 0.5rem;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}

.gauges li {
  display: grid;
  grid-template-columns: 3.75rem minmax(0, 1fr) 4.5rem;
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
  height: 10px;
  background: var(--raised);
  border-radius: 2px;
  overflow: hidden;
}

.fill {
  display: block;
  height: 100%;
  background: var(--ink-secondary);
  transition: width 400ms cubic-bezier(0.2, 0.7, 0.2, 1);
}

.fill.warning {
  background: var(--status-warning);
}
.fill.serious {
  background: var(--status-serious);
}
.fill.critical {
  background: var(--status-critical);
}

.value {
  text-align: right;
  white-space: nowrap;
}

.muted {
  margin: 0;
}
</style>
