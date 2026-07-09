<script setup lang="ts">
import { duration } from '../application/format'
import type { BatterySnapshot, DeviceInfo } from '../domain/bms/types'

defineProps<{ battery: BatterySnapshot; device: DeviceInfo | null }>()
</script>

<template>
  <section class="panel">
    <h2 class="plate">MOSFET breakers</h2>

    <ul class="breakers">
      <li>
        <span class="tag">Charge</span>
        <span class="pill" :class="{ off: !battery.chargingEnabled }">
          <span aria-hidden="true">{{ battery.chargingEnabled ? '✓' : '✕' }}</span>
          {{ battery.chargingEnabled ? 'ON' : 'OFF' }}
        </span>
      </li>
      <li>
        <span class="tag">Discharge</span>
        <span class="pill" :class="{ off: !battery.dischargingEnabled }">
          <span aria-hidden="true">{{ battery.dischargingEnabled ? '✓' : '✕' }}</span>
          {{ battery.dischargingEnabled ? 'ON' : 'OFF' }}
        </span>
      </li>
    </ul>

    <dl class="stats">
      <div>
        <dt class="plate">Uptime</dt>
        <dd class="readout">{{ duration(battery.uptimeSeconds) }}</dd>
      </div>
      <div>
        <dt class="plate">Cycles</dt>
        <dd class="readout">{{ battery.cycleCount }}</dd>
      </div>
      <div v-if="device">
        <dt class="plate">Firmware</dt>
        <dd class="readout">{{ device.softwareVersion }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.panel {
  padding: var(--pad);
}

h2 {
  margin: 0 0 0.9rem;
}

.breakers {
  list-style: none;
  margin: 0 0 1rem;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}

.breakers li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.tag {
  font-family: var(--font-label);
  font-size: 0.8125rem;
  color: var(--ink-muted);
  text-transform: uppercase;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  padding: 0.15rem 0.55rem;
  border: 1px solid var(--status-good);
  color: var(--status-good);
  border-radius: 2px;
}

.pill.off {
  border-color: var(--status-warning);
  color: var(--status-warning);
}

.stats {
  display: grid;
  gap: 0.5rem;
  margin: 0;
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
</style>
