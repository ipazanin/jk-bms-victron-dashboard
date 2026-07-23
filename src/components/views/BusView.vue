<script setup lang="ts">
import { computed } from 'vue'

import AnnunciatorStrip from '../AnnunciatorStrip.vue'
import BreakerPanel from '../BreakerPanel.vue'
import CellLadder from '../CellLadder.vue'
import RememberedBanner from '../RememberedBanner.vue'
import ShuntAmmeter from '../ShuntAmmeter.vue'
import SocCluster from '../SocCluster.vue'
import SolarRow from '../SolarRow.vue'
import TempTrio from '../TempTrio.vue'
import TrendStrips from '../TrendStrips.vue'
import { deviceLabel, packDefaultLabel, packDeviceKeyFor } from '../../domain/history/identity'
import { useHistoryBrowser } from '../../application/history/historyBrowser'
import { hashOf } from '../../application/route'
import { useTelemetry } from '../../application/telemetry'
import { useMediaQuery } from '../../application/useMediaQuery'

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
} = telemetry

const log = useHistoryBrowser()

const connectHref = hashOf({ name: 'connect' })
const logHref = hashOf({ name: 'log' })

const sessionCount = computed(() => log.archive.value.sessions)

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

/*
 * The unpowered instrument: the same viewBox, margins and row positions the live ammeter draws
 * on, so connecting fills the chassis in rather than replacing it with a different picture.
 * Nothing here is a measurement — no ticks, no bars, no numbers — so it teaches the reading
 * order without fabricating a reading.
 */
const CHASSIS_DESKTOP = { width: 1000, height: 196, margin: 128, axisY: 58, packY: 96, solarY: 128, houseY: 170 }
const CHASSIS_PHONE = { width: 420, height: 208, margin: 92, axisY: 54, packY: 100, solarY: 138, houseY: 184 }

const compact = useMediaQuery('(max-width: 720px)')
const chassis = computed(() => (compact.value ? CHASSIS_PHONE : CHASSIS_DESKTOP))
const chassisCentre = computed(() => chassis.value.width / 2)
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
    :bms-state="bmsState"
    :solar-state="solarState"
    :faults="faults"
    :worst-fault="worstFault"
    :device-label="packLabel"
  />

  <main>
    <ShuntAmmeter
      v-if="battery"
      :pack-current="battery.current"
      :pack-voltage="battery.packVoltage"
      :solar-current="solar?.batteryCurrent ?? null"
      :house-current="bus?.houseCurrent ?? null"
      :house-power="bus?.housePower ?? null"
      :house-load-plausible="bus?.houseLoadPlausible ?? null"
      :pv-power="solar?.pvPower ?? null"
      :pack-reach="packReach"
      :solar-reach="solarReach"
    />

    <template v-else>
      <section class="chassis">
        <header class="chassis-head">
          <h2 class="plate">DC bus reconciliation</h2>
          <p class="muted">house = solar − pack</p>
        </header>

        <svg
          :viewBox="`0 0 ${chassis.width} ${chassis.height}`"
          class="chart"
          data-testid="shunt-chassis"
          role="img"
          aria-label="The instrument, unpowered: a centre-zero current axis with a row each for pack, solar and house. It fills in when you connect."
        >
          <text :x="chassis.margin" :y="chassis.axisY - 30" text-anchor="start" class="pole">
            − discharge
          </text>
          <text
            :x="chassis.width - chassis.margin"
            :y="chassis.axisY - 30"
            text-anchor="end"
            class="pole"
          >
            charge +
          </text>

          <line
            :x1="chassis.margin"
            :y1="chassis.axisY"
            :x2="chassis.width - chassis.margin"
            :y2="chassis.axisY"
            class="axis"
          />
          <line
            :x1="chassisCentre"
            :y1="chassis.axisY"
            :x2="chassisCentre"
            :y2="chassis.houseY + 12"
            class="axis"
          />

          <text :x="8" :y="chassis.packY + 5" class="row-label">PACK</text>

          <line
            :x1="chassisCentre - 6"
            :y1="chassis.solarY"
            :x2="chassisCentre + 6"
            :y2="chassis.solarY"
            class="ghost"
          />
          <text :x="8" :y="chassis.solarY + 5" class="row-label">SOLAR</text>
          <text :x="chassisCentre + 20" :y="chassis.solarY + 5" class="hint">
            Connect the Victron
          </text>

          <line
            :x1="chassisCentre - 6"
            :y1="chassis.houseY"
            :x2="chassisCentre + 6"
            :y2="chassis.houseY"
            class="ghost"
          />
          <text :x="8" :y="chassis.houseY + 5" class="row-label">HOUSE</text>
          <text :x="chassisCentre + 20" :y="chassis.houseY + 5" class="hint">
            needs both radios
          </text>
        </svg>

        <p class="muted caption">This is the instrument. It fills in when you connect.</p>
      </section>

      <section class="landing">
        <h2>Read your DC bus.</h2>
        <p>
          Connect the battery to see charge, discharge and cell health. Add the Victron to see solar
          in and house load — the number neither vendor app shows, and which normally needs a shunt
          you never installed.
        </p>
        <p class="copy">
          Needs Chrome or Edge and the two radios. Firefox and Safari cannot do Web Bluetooth at all.
        </p>
        <p class="landing-actions">
          <a class="primary" :href="connectHref">Connect your devices</a>
          <a v-if="sessionCount > 0" class="recorded" :href="logHref">{{ recordedSummary }}</a>
        </p>
      </section>
    </template>

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
      v-if="battery"
      :solar="solar"
      :bus="bus"
      :pack-voltage="battery.packVoltage"
      :rssi="solarRssi"
      :can-scan="capabilities.canScan"
    />

    <TrendStrips v-if="battery && source === 'live'" :history="history" />
  </main>
</template>

<style scoped>
.chassis {
  padding: var(--pad);
  border-bottom: 1px solid var(--gridline);
}

.chassis-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin: 0 0 0.25rem;
}

.chassis-head h2 {
  margin: 0;
}

.caption {
  margin: 0.75rem 0 0;
}

.chart {
  width: 100%;
  height: auto;
  display: block;
}

.axis {
  stroke: var(--baseline);
  stroke-width: 1;
}

.ghost {
  stroke: var(--ink-muted);
  stroke-width: 2;
}

.pole,
.row-label,
.hint {
  font-family: var(--font-label);
  font-size: var(--svg-label);
  letter-spacing: 0.08em;
  fill: var(--ink-muted);
}

.pole,
.row-label {
  text-transform: uppercase;
}

.hint {
  font-family: var(--font-body);
  text-transform: none;
  letter-spacing: 0;
}

.landing {
  padding: 3rem var(--pad);
  border-bottom: 1px solid var(--gridline);
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
  border-radius: var(--radius);
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
 * Track floors, not equal fractions: CellLadder spends 11.5rem on fixed tracks before its bar
 * track gets anything, so an equal quarter of 1080px left the widest drawn mark about a pixel
 * across. The dividers are the container's 1px gaps showing through, which keeps them full
 * height at every breakpoint and turns the row and column rules into the same rule.
 */
.instruments {
  display: grid;
  grid-template-columns:
    minmax(13rem, 0.85fr) minmax(22rem, 1.7fr) minmax(12rem, 0.75fr)
    minmax(12rem, 0.8fr);
  gap: 1px;
  background: var(--gridline);
}

.instruments > * {
  background: var(--surface);
  min-width: 0;
}

@media (max-width: 1180px) {
  .instruments {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .instruments {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
