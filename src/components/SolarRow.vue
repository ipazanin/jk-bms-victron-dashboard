<script setup lang="ts">
import { computed } from 'vue'

import StageStepper from './StageStepper.vue'
import StatusChip from './StatusChip.vue'
import { amps, kilowattHours, volts, watts } from '../application/format'
import type { BusReconciliation } from '../domain/dcBus'
import type { SolarReading } from '../domain/solar/types'

const props = defineProps<{
  solar: SolarReading | null
  bus: BusReconciliation | null
  packVoltage: number | null
  rssi: number
  canScan: boolean
}>()

const errorLevel = computed(() => (props.solar && props.solar.chargerError !== 0 ? 'critical' : 'good'))
</script>

<template>
  <section class="panel">
    <header>
      <h2 class="plate">Solar — Victron SmartSolar</h2>
      <StatusChip
        v-if="solar"
        :level="errorLevel"
        :label="solar.chargerError === 0 ? 'no error' : `error ${solar.chargerError}`"
      />
    </header>

    <template v-if="solar">
      <StageStepper :stage="solar.chargeState" />

      <dl class="stats">
        <div>
          <dt class="plate">PV input</dt>
          <dd class="secondary-figure">{{ solar.pvPower === null ? '—' : watts(solar.pvPower) }}</dd>
        </div>
        <div>
          <dt class="plate">To battery</dt>
          <dd class="secondary-figure">
            {{ solar.batteryCurrent === null ? '—' : amps(solar.batteryCurrent) }}
          </dd>
        </div>
        <div>
          <dt class="plate">Yield today</dt>
          <dd class="secondary-figure">
            {{ solar.yieldTodayKwh === null ? '—' : kilowattHours(solar.yieldTodayKwh) }}
          </dd>
        </div>
      </dl>

      <p v-if="bus && packVoltage !== null" class="crosscheck">
        <span class="plate">Voltage cross-check</span>
        <span class="readout">
          BMS {{ volts(packVoltage) }} · Victron {{ volts(solar.batteryVoltage ?? 0, 2) }} ·
          Δ {{ (bus.voltageDelta * 1000).toFixed(0) }} mV
        </span>
        <StatusChip
          :level="bus.voltagesAgree ? 'good' : 'warning'"
          :label="bus.voltagesAgree ? 'agree' : 'disagree'"
        />
      </p>

      <p v-if="rssi !== 0" class="muted">signal {{ rssi }} dBm</p>
    </template>

    <template v-else>
      <p class="empty">Solar not connected. Boat load needs both radios.</p>
      <p v-if="!canScan" class="hint">
        This browser cannot read Bluetooth advertisements. Enable
        <code>chrome://flags/#enable-experimental-web-platform-features</code> in Chrome on Android
        or macOS, then reload.
      </p>
    </template>
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
  margin-bottom: 0.75rem;
}

h2 {
  margin: 0;
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 2.5rem;
  margin: 1rem 0;
}

dt,
dd {
  margin: 0;
}

dd {
  margin-top: 0.15rem;
}

.crosscheck {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 0.5rem 0 0;
  padding-top: 0.75rem;
  border-top: 1px solid var(--gridline);
}

.crosscheck .readout {
  color: var(--ink-secondary);
}

.empty {
  margin: 0;
  color: var(--ink-secondary);
}

.hint {
  margin: 0.5rem 0 0;
  font-size: 0.875rem;
  color: var(--ink-muted);
}

code {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  background: var(--raised);
  padding: 0.1rem 0.3rem;
  border-radius: 2px;
  overflow-wrap: anywhere;
}

.muted {
  margin: 0.75rem 0 0;
}
</style>
