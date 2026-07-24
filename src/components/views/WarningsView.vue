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
import type { WarningLevel, WarningRecord, WarningSnapshot } from '../../domain/history/types'

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

/** The severity in words, so the tier is not carried by the dot's colour alone — a channel a screen
 *  reader and a colour-blind reader both lose. */
const TIER_WORDS: Readonly<Record<WarningLevel, string>> = {
  warning: 'Warning',
  serious: 'Serious',
  critical: 'Critical',
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
  push('Boat load', houseLabel(snapshot))
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
      <h2 class="head-title">Warnings</h2>
      <p class="copy head-sub">
        Faults captured as they fired, each with the readings behind it. Kept so a fault can be
        debugged later — what caused it, and what the pack was doing at the time.
      </p>
    </header>

    <LogTabs />

    <div class="body">
      <section class="card list-card">
        <p v-if="loaded && warnings.length === 0" class="state copy">
          No warnings recorded. A warning is written the moment a fault first appears during a live
          session — a hot MOSFET, a cell imbalance, a charger error — and stays here afterwards.
        </p>

        <ul class="list">
          <li v-for="warning in warnings" :key="`${warning.sessionId}:${warning.seq}`" class="item">
            <details>
              <summary>
                <span class="dot" :class="warning.level" aria-hidden="true" />
                <span class="tier" :class="warning.level">{{ TIER_WORDS[warning.level] }}</span>
                <span class="title">{{ warning.title }}</span>
                <span class="when readout">{{ stamp.format(warning.at) }}</span>
              </summary>
              <p class="detail copy">{{ warning.detail }}</p>
              <dl class="readings">
                <div
                  v-for="reading in readingsOf(warning.snapshot)"
                  :key="reading.label"
                  class="reading"
                >
                  <dt>{{ reading.label }}</dt>
                  <dd class="readout">{{ reading.value }}</dd>
                </div>
              </dl>
              <a class="session-link" :href="sessionHref(warning)">Open the session →</a>
            </details>
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>

<style scoped>
.head {
  padding: clamp(1rem, 3vw, 1.75rem) var(--pad) 0;
}

.head-title {
  margin: 0;
  font-family: var(--font-body);
  font-weight: 600;
  font-size: clamp(1.35rem, 1rem + 1.6vw, 1.85rem);
  letter-spacing: -0.01em;
  color: var(--ink);
}

.head-sub {
  margin: 0.4rem 0 0;
}

/* One stack gap replaces the old inter-panel gridline rules; the card below carries its own
   elevation, so blocks separate on space rather than a 1px border. */
.body {
  display: flex;
  flex-direction: column;
  gap: clamp(1rem, 2.5vw, 1.5rem);
  padding: 1.25rem var(--pad) 2.5rem;
}

.list-card {
  padding: var(--pad);
}

.state {
  margin: 0;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.item {
  border-bottom: 1px solid var(--gridline);
}

.item:first-child summary {
  padding-top: 0;
}

.item:last-child {
  border-bottom: none;
}

summary {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: var(--tap);
  padding: 0.5rem 0;
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

/* The severity in words, so the tier is not colour-only: the dot beside it now reinforces this
   label rather than being the only channel that carries it. The -ink half of each status hue is the
   one that clears AA as text on the card. Fixed width so the titles rule down the page. */
.tier {
  flex: none;
  min-width: 4rem;
  font-family: var(--font-label);
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 600;
}

.tier.warning {
  color: var(--status-warning-ink);
}

.tier.serious {
  color: var(--status-serious-ink);
}

.tier.critical {
  color: var(--status-critical-ink);
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
  padding: 0 0 0.75rem;
  padding-left: calc(9px + 0.75rem);
}

.readings {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
  gap: 1px;
  margin: 0;
  padding: 0 0 1rem;
  padding-left: calc(9px + 0.75rem);
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
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  margin: 0 0 1rem;
  margin-left: calc(9px + 0.75rem);
  color: var(--pack-ink);
  text-decoration: none;
  font-size: 0.875rem;
}

.session-link:hover {
  text-decoration: underline;
}
</style>
