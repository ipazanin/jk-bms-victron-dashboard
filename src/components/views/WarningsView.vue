<script setup lang="ts">
/**
 * Every warning the recorder captured, most recent first, each kept with the readings that were
 * standing when it fired. A warning is written once when its fault first appears — so this is a log
 * of episodes, not of every second a fault stood — and it exists to answer, later and off the boat,
 * what caused a fault and what the pack was doing at the time.
 */
import { onMounted, ref } from 'vue'

import LogTabs from '../history/LogTabs.vue'
import { useHistoryBrowser } from '../../application/history/historyBrowser'
import { amps, celsius, chargeStateLabel, volts, watts } from '../../application/format'
import { hashOf } from '../../application/route'
import type { WarningRecord, WarningSnapshot } from '../../domain/history/types'

const browser = useHistoryBrowser()
const { warnings } = browser

// The empty state waits for the first load to finish, so an archive that has warnings does not
// flash "none recorded" in the window between mount and the async refresh returning.
const loaded = ref(false)

onMounted(() => {
  void browser
    .refresh()
    .catch(() => undefined)
    .finally(() => (loaded.value = true))
})

const stamp = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function sessionHref(warning: WarningRecord): string {
  return hashOf({ name: 'session', id: warning.sessionId })
}

interface Reading {
  readonly label: string
  readonly value: string
}

/** The non-null readings behind a warning, formatted for a compact grid. */
function readingsOf(snapshot: WarningSnapshot): Reading[] {
  const rows: Reading[] = []
  const push = (label: string, value: string | null): void => {
    if (value !== null) rows.push({ label, value })
  }
  push('Pack current', snapshot.packCurrentA === null ? null : amps(snapshot.packCurrentA))
  push('Pack voltage', snapshot.packVoltageV === null ? null : volts(snapshot.packVoltageV, 2))
  push('Charge', snapshot.stateOfCharge === null ? null : `${snapshot.stateOfCharge}%`)
  push('Cell spread', snapshot.cellDeltaMv === null ? null : `${snapshot.cellDeltaMv} mV`)
  push('MOSFET', snapshot.mosfetTemperatureC === null ? null : celsius(snapshot.mosfetTemperatureC))
  push('Temp 1', snapshot.temperature1C === null ? null : celsius(snapshot.temperature1C))
  push('Temp 2', snapshot.temperature2C === null ? null : celsius(snapshot.temperature2C))
  push('Charge MOS', boolLabel(snapshot.chargingEnabled))
  push('Discharge MOS', boolLabel(snapshot.dischargingEnabled))
  push('Solar', snapshot.solarChargeState === null ? null : chargeStateLabel(snapshot.solarChargeState))
  push('PV power', snapshot.pvPowerW === null ? null : watts(snapshot.pvPowerW))
  push('Solar current', snapshot.solarBatteryCurrentA === null ? null : amps(snapshot.solarBatteryCurrentA))
  push('House load', houseLabel(snapshot))
  return rows
}

function boolLabel(value: boolean | null): string | null {
  return value === null ? null : value ? 'on' : 'off'
}

function houseLabel(snapshot: WarningSnapshot): string | null {
  if (snapshot.housePowerW === null) return null
  const power = watts(snapshot.housePowerW)
  return snapshot.houseLoadPlausible === false ? `${power} (unmeasured source)` : power
}
</script>

<template>
  <section class="warnings" data-testid="warnings-view">
    <header class="head">
      <h2 class="plate">Warnings</h2>
      <p class="copy">
        Faults captured as they fired, each with the readings behind it. Kept so a fault can be
        debugged later — what caused it, and what the pack was doing at the time.
      </p>
    </header>

    <LogTabs />

    <p v-if="loaded && warnings.length === 0" class="state copy">
      No warnings recorded. A warning is written the moment a fault first appears during a live
      session — a hot MOSFET, a cell imbalance, a charger error — and stays here afterwards.
    </p>

    <ul class="list">
      <li v-for="warning in warnings" :key="`${warning.sessionId}:${warning.seq}`" class="item">
        <details>
          <summary>
            <span class="dot" :class="warning.level" aria-hidden="true" />
            <span class="title">{{ warning.title }}</span>
            <span class="when readout">{{ stamp.format(warning.at) }}</span>
          </summary>
          <p class="detail copy">{{ warning.detail }}</p>
          <dl class="readings">
            <div v-for="reading in readingsOf(warning.snapshot)" :key="reading.label" class="reading">
              <dt>{{ reading.label }}</dt>
              <dd class="readout">{{ reading.value }}</dd>
            </div>
          </dl>
          <a class="session-link" :href="sessionHref(warning)">Open the session →</a>
        </details>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.warnings {
  background: var(--surface);
}

.head {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 1.25rem var(--pad);
  border-bottom: 1px solid var(--gridline);
}

.head h2 {
  margin: 0;
}

.head .copy {
  margin: 0;
}

.state {
  padding: 1.5rem var(--pad);
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.item {
  border-bottom: 1px solid var(--gridline);
}

summary {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: var(--tap);
  padding: 0.5rem var(--pad);
  cursor: pointer;
  list-style: none;
}

summary::-webkit-details-marker {
  display: none;
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
}

.dot.warning {
  background: var(--status-warning);
}

.dot.serious {
  background: var(--status-serious);
}

.dot.critical {
  background: var(--status-critical);
}

.title {
  flex: 1;
  font-weight: 600;
}

.when {
  color: var(--ink-muted);
  font-size: 0.8125rem;
}

.detail {
  margin: 0;
  padding: 0 var(--pad) 0.75rem;
  padding-left: calc(var(--pad) + 9px + 0.75rem);
}

.readings {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
  gap: 1px;
  margin: 0;
  padding: 0 var(--pad) 1rem;
  padding-left: calc(var(--pad) + 9px + 0.75rem);
}

.reading {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.35rem 0;
}

.reading dt {
  font-family: var(--font-label);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
}

.reading dd {
  margin: 0;
  color: var(--ink);
}

.session-link {
  display: inline-block;
  margin: 0 var(--pad) 1rem;
  margin-left: calc(var(--pad) + 9px + 0.75rem);
  color: var(--pack-ink);
  text-decoration: none;
  font-size: 0.875rem;
}

.session-link:hover {
  text-decoration: underline;
}
</style>
