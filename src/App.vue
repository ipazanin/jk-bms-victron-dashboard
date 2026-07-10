<script setup lang="ts">
import { onMounted, ref } from 'vue'

import AnnunciatorStrip from './components/AnnunciatorStrip.vue'
import BreakerPanel from './components/BreakerPanel.vue'
import CellLadder from './components/CellLadder.vue'
import ConnectPanel from './components/ConnectPanel.vue'
import RememberedBanner from './components/RememberedBanner.vue'
import ShuntAmmeter from './components/ShuntAmmeter.vue'
import SocCluster from './components/SocCluster.vue'
import SolarRow from './components/SolarRow.vue'
import TempTrio from './components/TempTrio.vue'
import TrendStrips from './components/TrendStrips.vue'
import { loadAdvertisementKey } from './application/storage'
import { useTelemetry } from './application/telemetry'

const telemetry = useTelemetry()
const {
  capabilities,
  adapterOn,
  source,
  bmsState,
  solarState,
  bmsError,
  solarError,
  foreignDeviceSeen,
  solarRssi,
  device,
  settings,
  battery,
  solar,
  bus,
  projection,
  faults,
  worstFault,
  history,
  rememberedAt,
  rememberedStatus,
} = telemetry

const theme = ref<'dark' | 'light'>('dark')
const initialKey = loadAdvertisementKey()

function applyTheme(next: 'dark' | 'light'): void {
  theme.value = next
  document.documentElement.dataset.theme = next
}

onMounted(() => {
  const query = new URLSearchParams(window.location.search)

  const requestedTheme = query.get('theme')
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches
  applyTheme(requestedTheme === 'light' || (requestedTheme === null && prefersLight) ? 'light' : 'dark')

  // ?demo opens straight into the recording, so the page can be linked and shared by
  // someone who has none of the hardware. It touches no Bluetooth API and needs no gesture.
  // ?demo=bms replays the battery alone, which is what most visitors will actually see.
  if (query.has('demo')) void telemetry.startDemo(query.get('demo') !== 'bms')
  // No ?demo: restore the last live session from localStorage (pure, no gesture), so the
  // instruments render on first paint instead of the empty landing page.
  else telemetry.restoreRemembered()
})
</script>

<template>
  <div class="shell">
    <header class="masthead">
      <div>
        <h1>Shunt</h1>
        <p class="muted">
          A virtual shunt for a JK-BMS and a Victron SmartSolar, read straight from the browser
        </p>
      </div>
      <button type="button" class="theme" @click="applyTheme(theme === 'dark' ? 'light' : 'dark')">
        {{ theme === 'dark' ? 'Light' : 'Dark' }}
      </button>
    </header>

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
      />

      <section v-else class="landing">
        <h2>Read your DC bus.</h2>
        <p>
          Connect the battery to see charge, discharge and cell health. Add the Victron to see
          solar in and house load — the number neither vendor app shows, and which normally needs
          a shunt you never installed.
        </p>
      </section>

      <div v-if="battery" class="instruments">
        <SocCluster
          :battery="battery"
          :to-full="projection?.toFull ?? null"
          :to-empty="projection?.toEmpty ?? null"
        />
        <CellLadder :battery="battery" :balance-trigger="settings?.balanceTriggerDelta ?? null" />
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

      <TrendStrips v-if="battery && source !== 'remembered'" :history="history" />

      <ConnectPanel
        :capabilities="capabilities"
        :adapter-on="adapterOn"
        :source="source"
        :bms-state="bmsState"
        :solar-state="solarState"
        :bms-error="bmsError"
        :solar-error="solarError"
        :foreign-device-seen="foreignDeviceSeen"
        :initial-key="initialKey"
        @connect-bms="telemetry.connectBms"
        @disconnect-bms="telemetry.disconnectBms"
        @start-solar="telemetry.startSolar"
        @stop-solar="telemetry.stopSolar"
        @start-demo="telemetry.startDemo"
        @stop-demo="telemetry.stopDemo"
      />
    </main>

    <footer class="colophon">
      <p class="muted">
        Nothing leaves this page. No backend, no telemetry, no analytics. Your encryption key stays
        in this browser.
      </p>
    </footer>
  </div>
</template>

<style scoped>
.shell {
  max-width: 1180px;
  margin: 0 auto;
  background: var(--surface);
  min-height: 100vh;
}

.masthead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.5rem var(--pad) 1.25rem;
  border-bottom: 1px solid var(--gridline);
}

h1 {
  margin: 0;
  font-family: var(--font-label);
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.masthead .muted {
  margin: 0.35rem 0 0;
  max-width: 60ch;
}

.theme {
  background: transparent;
  border: 1px solid var(--gridline);
  color: var(--ink-secondary);
  border-radius: 2px;
  padding: 0.35rem 0.7rem;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
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

.instruments {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.instruments > * {
  border-right: 1px solid var(--gridline);
  min-width: 0;
}

.instruments > *:last-child {
  border-right: none;
}

.colophon {
  padding: 1.25rem var(--pad) 2rem;
  border-top: 1px solid var(--gridline);
}

.colophon .muted {
  margin: 0;
  max-width: 70ch;
}

@media (max-width: 1080px) {
  .instruments {
    grid-template-columns: repeat(2, 1fr);
  }
  .instruments > *:nth-child(2n) {
    border-right: none;
  }
  .instruments > *:nth-child(-n + 2) {
    border-bottom: 1px solid var(--gridline);
  }
}

@media (max-width: 720px) {
  .instruments {
    grid-template-columns: 1fr;
  }
  .instruments > * {
    border-right: none;
    border-bottom: 1px solid var(--gridline);
  }
}
</style>
