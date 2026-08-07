<script setup lang="ts">
import { computed } from 'vue'

import AnnunciatorStrip from '../AnnunciatorStrip.vue'
import BreakerPanel from '../BreakerPanel.vue'
import CellLadder from '../CellLadder.vue'
import EnergyFlow from '../bus/EnergyFlow.vue'
import RecordingPlate from '../RecordingPlate.vue'
import RememberedBanner from '../RememberedBanner.vue'
import ShuntAmmeter from '../ShuntAmmeter.vue'
import SocCluster from '../SocCluster.vue'
import SolarRow from '../SolarRow.vue'
import TempTrio from '../TempTrio.vue'
import TrendStrips from '../TrendStrips.vue'
import { storedEnergy } from '../../domain/dcBus'
import { deviceLabel, packDefaultLabel, packDeviceKeyFor } from '../../domain/history/identity'
import { useHistoryBrowser } from '../../application/history/historyBrowser'
import { linkPhase } from '../../application/linkPhase'
import { hashOf } from '../../application/route'
import { useTelemetry } from '../../application/telemetry'

const telemetry = useTelemetry()
const {
  capabilities,
  source,
  bmsState,
  solarState,
  solarRssi,
  device,
  settings,
  battery,
  solar,
  bus,
  balance,
  cellReach,
  packReach,
  solarReach,
  projection,
  faults,
  worstFault,
  history,
  rememberedAt,
  rememberedStatus,
  recording,
} = telemetry

const log = useHistoryBrowser()
// Destructured so the template reads it as a top-level ref, which `<script setup>` unwraps.
const { availability: archiveAvailability } = log

const connectHref = hashOf({ name: 'connect' })
const logHref = hashOf({ name: 'log' })

const packPhase = computed(() => linkPhase(bmsState.value, battery.value !== null))
const solarPhase = computed(() => linkPhase(solarState.value, solar.value !== null))

/** Something to show, or something on its way: the page has left the cold landing. */
const engaged = computed(() => packPhase.value !== 'absent' || solarPhase.value !== 'absent')

/**
 * Not live. `linkPhase` reads a snapshot in hand ahead of the link state, which is correct — a
 * reading IS in hand — but it leaves every instrument painting a restored session exactly as it
 * paints a measured one, marching dashes and all. The banner above says so and scrolls away on a
 * phone, so each instrument that paints these figures has to say so on its own surface.
 */
const stale = computed(() => source.value === 'remembered' || source.value === 'history')

const sessionCount = computed(() => log.archive.value.sessions)

/** The configured series count wins; the domain falls back to the cell frame's own when it is absent. */
const packStored = computed(() => {
  const snapshot = battery.value
  return snapshot === null ? null : storedEnergy(snapshot, settings.value?.cellCount ?? null)
})

/**
 * The live pack under whatever name the Log knows it by. Telemetry holds the device info the radio
 * reported, the archive holds the name the owner typed, and neither can join them alone. The
 * advertised name is deliberately not consulted, so a pack with no serial falls back to its label.
 */
const packLabel = computed(() => {
  const info = device.value
  if (info === null) return null
  const key = packDeviceKeyFor(info, null)
  const known = key === null ? null : log.devices.value.find((record) => record.key === key)
  return deviceLabel(known ?? null, packDefaultLabel(info, null))
})

/** The landing's third state: neither live nor remembered, but this browser has recorded before. */
const oldestDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' })
const recordedSummary = computed(() => {
  const { sessions, oldestStartedAt } = log.archive.value
  const line = `→ ${sessions} session${sessions === 1 ? '' : 's'} in the log`
  return oldestStartedAt === null ? line : `${line}, back to ${oldestDay.format(oldestStartedAt)}`
})
</script>

<template>
  <RememberedBanner
    v-if="source === 'remembered'"
    :captured-at="rememberedAt"
    :status="rememberedStatus"
    @forget="telemetry.forgetRemembered"
  />
  <AnnunciatorStrip
    v-else
    :source="source"
    :pack-phase="packPhase"
    :solar-phase="solarPhase"
    :faults="faults"
    :worst-fault="worstFault"
    :device-label="packLabel"
  >
    <RecordingPlate :state="recording" :availability="archiveAvailability" />
  </AnnunciatorStrip>

  <main>
    <EnergyFlow
      v-if="engaged"
      class="card"
      :pack-current="battery?.current ?? null"
      :pack-voltage="battery?.packVoltage ?? null"
      :pack-phase="packPhase"
      :solar-current="solar?.batteryCurrent ?? null"
      :solar-phase="solarPhase"
      :bus-voltage="battery?.packVoltage ?? solar?.batteryVoltage ?? null"
      :pv-power="solar?.pvPower ?? null"
      :house-current="bus?.houseCurrent ?? null"
      :house-power="bus?.housePower ?? null"
      :house-load-plausible="bus?.houseLoadPlausible ?? null"
      :pack-stored="packStored"
      :projection="projection"
      :pack-reach="packReach"
      :solar-reach="solarReach"
      :stale="stale"
      :captured-at="rememberedAt"
    />

    <ShuntAmmeter
      class="card"
      :pack-current="battery?.current ?? null"
      :pack-voltage="battery?.packVoltage ?? null"
      :pack-phase="packPhase"
      :solar-current="solar?.batteryCurrent ?? null"
      :solar-phase="solarPhase"
      :house-current="bus?.houseCurrent ?? null"
      :house-power="bus?.housePower ?? null"
      :house-load-plausible="bus?.houseLoadPlausible ?? null"
      :pv-power="solar?.pvPower ?? null"
      :pack-reach="packReach"
      :solar-reach="solarReach"
      :stale="stale"
    />

    <div v-if="battery" class="instruments">
      <SocCluster :battery="battery" :projection="projection" />
      <CellLadder
        :battery="battery"
        :balance="balance"
        :cell-reach="cellReach"
        :balance-trigger="settings?.balanceTriggerDelta ?? null"
      />
      <TempTrio :battery="battery" />
      <BreakerPanel :battery="battery" :device="device" />
    </div>

    <SolarRow
      v-if="engaged"
      class="card"
      :solar="solar"
      :solar-phase="solarPhase"
      :bus="bus"
      :pack-voltage="battery?.packVoltage ?? null"
      :rssi="solarRssi"
      :can-listen-solar="capabilities.canListenSolar"
    />

    <!-- The live trend sits last: a strip mounting when a series first arrives grows the panel,
         and from the foot of the stack that nudges only the footer, never the instruments above. -->
    <TrendStrips
      v-if="source === 'live' && packPhase !== 'absent'"
      class="card"
      :history="history"
    />

    <section v-if="!engaged" class="landing card">
      <h2>Read your DC bus.</h2>
      <p>
        Connect the battery to see charge, discharge and cell health. Add the Victron to see solar in
        and boat load — the number neither vendor app shows, and which normally needs a shunt you
        never installed.
      </p>
      <p class="copy">
        Needs Chrome or Edge and the two radios. Firefox and Safari cannot do Web Bluetooth at all.
      </p>
      <p class="landing-actions">
        <a class="primary" :href="connectHref">Connect your devices</a>
        <a v-if="sessionCount > 0" class="recorded" :href="logHref">{{ recordedSummary }}</a>
      </p>
    </section>
  </main>
</template>

<style scoped>
main {
  --stack-gap: clamp(0.75rem, 1.5vw, 1.25rem);
  display: flex;
  flex-direction: column;
  gap: var(--stack-gap);
  padding-block: var(--stack-gap);
  /* The cluster wraps against the width actually available to it, not the raw viewport, so the
     four columns fold to two before the rail and page padding can push them off the edge. */
  container: bus / inline-size;
}

/*
 * The elevated-card treatment shared by every top-level block on the Bus: the flow hero, the
 * ammeter, the trend, the solar row, the landing, and each instrument in the cluster.
 * Contrast between blocks comes from the plane → card elevation step, not a 1px rule. The class
 * falls through to each child component's root, which carries this scope, and each panel supplies
 * its own padding, so the card sets only surface, edge, radius and shadow.
 */
.card,
.instruments > * {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
  min-width: 0;
}

.landing {
  padding: 3rem var(--pad);
}

.landing h2 {
  margin: 0 0 0.75rem;
  font-size: 2rem;
  font-weight: 600;
}

.landing p {
  margin: 0;
  max-width: 62ch;
  color: var(--ink-secondary);
}

.landing .copy {
  margin-top: 0.75rem;
  color: var(--ink-muted);
}

.landing-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem 1.5rem;
  margin-top: 1.5rem;
}

.landing-actions .primary {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  padding: 0 1.1rem;
  background: var(--pack-ink);
  border: 1px solid var(--pack-ink);
  color: var(--on-pack);
  border-radius: var(--r-sm);
  font-family: var(--font-label);
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-decoration: none;
}

.landing-actions .recorded {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  color: var(--pack-ink);
  font-family: var(--font-mono);
  font-size: 0.9375rem;
  text-decoration: none;
}

.landing-actions .recorded:hover {
  text-decoration: underline;
}

/*
 * Track floors, not equal fractions: CellLadder spends ~11.5rem on fixed columns before its bar
 * track gets anything, so an equal quarter of the row leaves the widest drawn mark about a pixel
 * across. The wide second track is the ladder's; the other three hold the readouts they carry.
 * Cards separate on the stack gap now, so there is no gridline show-through to keep aligned.
 */
.instruments {
  display: grid;
  grid-template-columns:
    minmax(13rem, 0.85fr) minmax(22rem, 1.7fr) minmax(12rem, 0.75fr)
    minmax(12rem, 0.8fr);
  gap: var(--stack-gap);
}

/* The four fixed floors sum to ~59rem plus gaps; below that the row cannot hold four without
   overflowing, so fold to two, then to one when even two would crowd. */
@container bus (max-width: 1060px) {
  .instruments {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@container bus (max-width: 680px) {
  .instruments {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
