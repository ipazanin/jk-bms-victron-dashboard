<script setup lang="ts">
import { clockTimeWithSeconds } from '../../application/format'
import type { SessionHourMoment, SessionHourMomentReason } from '../../domain/history/SessionHourMoment'
import type { SessionHourMetric } from '../../domain/history/SessionHourMetric'
import { deriveHouse } from '../../domain/dcBus'

defineProps<{ moments: readonly SessionHourMoment[] }>()

const metricLabels: Record<SessionHourMetric, string> = {
  packCurrentA: 'pack current',
  solarCurrentA: 'solar current',
  houseCurrentA: 'boat current',
  housePowerW: 'boat power',
  stateOfCharge: 'state of charge',
  cellDeltaV: 'cell spread',
  mosfetTemperatureC: 'MOSFET temperature',
  packVoltageV: 'pack voltage',
  pvPowerW: 'PV power',
}

function reasonLabel(reason: SessionHourMomentReason): string {
  if (reason === 'first-pack') return 'first pack reading'
  if (reason === 'last-pack') return 'last pack reading'
  if (reason === 'first-solar') return 'first solar reading'
  if (reason === 'last-solar') return 'last solar reading'
  const separator = reason.lastIndexOf('-')
  const metric = reason.slice(0, separator) as SessionHourMetric
  return `${reason.slice(separator + 1)} ${metricLabels[metric]}`
}

function number(reading: number | null | undefined, unit: string, digits = 1): string {
  return reading == null ? 'Not observed' : `${reading.toFixed(digits)} ${unit}`
}

function house(moment: SessionHourMoment): string {
  const pack = moment.sample.pack
  const solar = moment.sample.solar
  if (pack === null || solar?.batteryCurrentA == null) return 'Not observed together'
  const reading = deriveHouse(pack.currentA, solar.batteryCurrentA, pack.packVoltageV)
  return reading.plausible
    ? `${reading.currentA.toFixed(1)} A · ${reading.powerW.toFixed(1)} W`
    : 'Withheld: another charging source or measurement uncertainty'
}
</script>

<template>
  <section class="moments">
    <h4 class="plate">Important moments · {{ moments.length }}</h4>
    <p class="copy">Original readings selected for boundaries and extremes. They do not show spike duration or every change between them.</p>
    <details v-for="(moment, index) in moments" :key="index">
      <summary>
        <span class="readout">{{ clockTimeWithSeconds(moment.sample.at) }}</span>
        · {{ moment.reasons.map(reasonLabel).join(', ') }}
      </summary>
      <dl>
        <dt>Pack observation</dt><dd>{{ moment.sample.pack ? clockTimeWithSeconds(moment.sample.pack.at) : 'Not observed' }}</dd>
        <dt>Solar observation</dt><dd>{{ moment.sample.solar ? clockTimeWithSeconds(moment.sample.solar.at) : 'Not observed' }}</dd>
        <dt>Pack current</dt><dd>{{ number(moment.sample.pack?.currentA, 'A', 3) }}</dd>
        <dt>Solar current</dt><dd>{{ number(moment.sample.solar?.batteryCurrentA, 'A') }}</dd>
        <dt>Boat load</dt><dd>{{ house(moment) }}</dd>
        <dt>Pack voltage</dt><dd>{{ number(moment.sample.pack?.packVoltageV, 'V', 3) }}</dd>
        <dt>State of charge</dt><dd>{{ number(moment.sample.pack?.stateOfCharge, '%', 0) }}</dd>
        <dt>Remaining capacity</dt><dd>{{ number(moment.sample.pack?.remainingCapacityAh, 'Ah', 3) }}</dd>
        <dt>Cell spread</dt><dd>{{ number(moment.sample.pack?.cellDeltaV, 'V', 3) }}</dd>
        <dt>Highest / lowest cell</dt><dd>{{ moment.sample.pack ? `${moment.sample.pack.highestCell} / ${moment.sample.pack.lowestCell}` : 'Not observed' }}</dd>
        <dt>MOSFET temperature</dt><dd>{{ number(moment.sample.pack?.mosfetTemperatureC, '°C') }}</dd>
        <dt>Temperature probes</dt><dd>{{ number(moment.sample.pack?.temperatureSensor1C, '°C') }} / {{ number(moment.sample.pack?.temperatureSensor2C, '°C') }}</dd>
        <dt>Charging / discharging enabled</dt><dd>{{ moment.sample.pack ? `${moment.sample.pack.chargingEnabled ? 'Yes' : 'No'} / ${moment.sample.pack.dischargingEnabled ? 'Yes' : 'No'}` : 'Not observed' }}</dd>
        <dt>PV power</dt><dd>{{ number(moment.sample.solar?.pvPowerW, 'W', 0) }}</dd>
        <dt>Solar battery voltage</dt><dd>{{ number(moment.sample.solar?.batteryVoltageV, 'V', 2) }}</dd>
        <dt>Solar charge state</dt><dd>{{ moment.sample.solar?.chargeState ?? 'Not observed' }}</dd>
        <dt>Charger error</dt><dd>{{ moment.sample.solar?.chargerError ?? 'Not observed' }}</dd>
        <dt>Solar yield today</dt><dd>{{ number(moment.sample.solar?.yieldTodayKwh, 'kWh', 2) }}</dd>
        <dt>Solar load output</dt><dd>{{ number(moment.sample.solar?.loadCurrentA, 'A') }}</dd>
        <dt>Signal strength</dt><dd>{{ number(moment.sample.solar?.rssi, 'dBm', 0) }}</dd>
      </dl>
    </details>
  </section>
</template>

<style scoped>
.moments { display: grid; gap: 0.65rem; }
h4, p { margin: 0; }
details { border-top: 1px solid var(--gridline); padding-top: 0.5rem; }
summary { cursor: pointer; min-height: var(--tap); overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: minmax(9rem, 1fr) minmax(0, 2fr); gap: 0.45rem 1rem; }
dt { color: var(--ink-secondary); }
dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 480px) { dl { grid-template-columns: 1fr; } dd { margin-bottom: 0.45rem; } }
</style>
