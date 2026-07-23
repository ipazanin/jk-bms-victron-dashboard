<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'

import AnnunciatorStrip from './components/AnnunciatorStrip.vue'
import BreakerPanel from './components/BreakerPanel.vue'
import CellLadder from './components/CellLadder.vue'
import ConnectPanel from './components/ConnectPanel.vue'
import LogView from './components/history/LogView.vue'
import RememberedBanner from './components/RememberedBanner.vue'
import SessionView from './components/history/SessionView.vue'
import ShuntAmmeter from './components/ShuntAmmeter.vue'
import SocCluster from './components/SocCluster.vue'
import SolarRow from './components/SolarRow.vue'
import TempTrio from './components/TempTrio.vue'
import TrendStrips from './components/TrendStrips.vue'
import { deviceLabel, packDefaultLabel, packDeviceKeyFor } from './domain/history/identity'
import { provideHistoryEnvironment, useHistoryBrowser } from './application/history/historyBrowser'
import { hashOf, route, startRouting } from './application/route'
import { loadAdvertisementKey } from './application/storage'
import { applyTheme, loadThemeChoice, resolveTheme, saveThemeChoice, themeFromQuery } from './application/theme'
import type { Theme } from './application/theme'
import { attachHistoryStore, useTelemetry } from './application/telemetry'
import { useMediaQuery } from './application/useMediaQuery'
import { downloadJson } from './infrastructure/history/downloadJson'
import { openHistoryStore } from './infrastructure/history/openHistoryStore'

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

/**
 * `?theme` pins the first render; a click on the toggle clears it, so the query parameter cannot
 * leave the control looking broken. `chosen` stays null until the owner actually picks one, which
 * is what lets the page keep following the machine to light at dusk and back until they do.
 */
const forcedTheme = ref<Theme | null>(themeFromQuery(window.location.search))
const chosenTheme = ref<Theme | null>(loadThemeChoice())
const systemPrefersLight = useMediaQuery('(prefers-color-scheme: light)')

const theme = computed(() =>
  resolveTheme(forcedTheme.value, chosenTheme.value, systemPrefersLight.value),
)

function chooseTheme(next: Theme): void {
  forcedTheme.value = null
  chosenTheme.value = next
  saveThemeChoice(next)
}
const initialKey = loadAdvertisementKey()
const logHref = hashOf({ name: 'log' })
const dashboardHref = hashOf({ name: 'dashboard' })

const showsDashboard = computed(() => route.value.name === 'dashboard')
const showsLog = computed(() => route.value.name === 'log')
/**
 * Empty only in the two branches that never render the session view. Reading the id out here
 * rather than narrowing inside the template keeps the route's shape in TypeScript's hands.
 */
const sessionId = computed(() => (route.value.name === 'session' ? route.value.id : ''))

/**
 * The route owns the load, not the view that displays it. A loaded session holds the decoded
 * chunks and the hold that keeps pruning off them, and that hold has to outlive a component which
 * unmounts on every navigation — so the owner is whatever survives the route change.
 *
 * Immediate, because a deep link arrives with the id already set: a watcher that only fires on
 * change would leave someone following a shared link on an empty page, with nothing loading and
 * nothing to say about why.
 */
watch(
  sessionId,
  (id) => (id === '' ? log.unloadSession() : void log.loadSession(id)),
  { immediate: true },
)

const sessionCount = computed(() => log.archive.value.sessions)

/**
 * The live pack under whatever name the Log knows it by. This is the one place the two halves
 * meet: telemetry holds the device info the radio reported, the archive holds the name the owner
 * typed, and neither can join them alone. The advertised name is deliberately not consulted — only
 * the recorder is handed it — so a pack with no serial falls back to its derived label.
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

let stopRouting: (() => void) | null = null

// main.ts sets the attribute before the mount so nothing paints on the wrong plane; this keeps it
// in step afterwards, when the owner toggles or the machine changes its mind.
watchEffect(() => applyTheme(theme.value))

onMounted(() => {
  // Restore the last live session from localStorage, so the instruments render on first paint
  // instead of the empty landing page. Synchronous by necessity: the archive probe below is a
  // promise, and first paint can never be made to wait on one.
  telemetry.restoreRemembered()

  stopRouting = startRouting()

  // One store, handed to both halves: the recorder writes through telemetry, the views read
  // through the browser model, and neither reaches into the other.
  void openHistoryStore()
    .then((store) => {
      attachHistoryStore(store)
      provideHistoryEnvironment({ store, downloadJson })
    })
    .catch(() => undefined)
})

onBeforeUnmount(() => {
  stopRouting?.()
  stopRouting = null
})
</script>

<template>
  <div class="shell">
    <header class="masthead">
      <div class="identity">
        <h1>Shunt</h1>
        <p class="muted">
          A virtual shunt for a JK-BMS and a Victron SmartSolar, read straight from the browser
        </p>
      </div>

      <nav class="views" aria-label="Views">
        <a :href="dashboardHref" :aria-current="showsDashboard ? 'page' : undefined">Bus</a>
        <a :href="logHref" :aria-current="showsDashboard ? undefined : 'page'">
          Log<span v-if="sessionCount > 0">&nbsp;{{ sessionCount }}</span>
        </a>
      </nav>

      <button type="button" class="theme" @click="chooseTheme(theme === 'dark' ? 'light' : 'dark')">
        {{ theme === 'dark' ? 'Light' : 'Dark' }}
      </button>
    </header>

    <template v-if="showsDashboard">
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
              Connect the battery to see charge, discharge and cell health. Add the Victron to see
              solar in and house load — the number neither vendor app shows, and which normally needs
              a shunt you never installed.
            </p>
            <p class="copy">
              Needs Chrome or Edge and the two radios. Firefox and Safari cannot do Web Bluetooth at
              all.
            </p>
            <p v-if="sessionCount > 0" class="recorded">
              <a :href="logHref">{{ recordedSummary }}</a>
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
        />
      </main>
    </template>

    <main v-else-if="showsLog">
      <LogView />
    </main>

    <main v-else>
      <SessionView :id="sessionId" />
    </main>

    <footer class="colophon">
      <p class="muted">
        Nothing leaves this page. It makes no network request after it loads: no backend, no
        telemetry, no analytics. Your encryption key and your log stay in this browser.
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
  flex-wrap: wrap;
  gap: 1rem;
  padding: 1.5rem var(--pad) 1.25rem;
  border-bottom: 1px solid var(--gridline);
}

.identity {
  flex: 1 1 18rem;
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

.views {
  display: inline-flex;
  border: 1px solid var(--gridline);
  border-radius: var(--radius);
  overflow: hidden;
}

.views a {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  padding: 0 0.9rem;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-secondary);
  text-decoration: none;
}

.views a + a {
  border-left: 1px solid var(--gridline);
}

.views a[aria-current='page'] {
  background: var(--raised);
  color: var(--ink);
}

.theme {
  background: transparent;
  border: 1px solid var(--gridline);
  color: var(--ink-secondary);
  border-radius: 2px;
  min-height: var(--tap);
  padding: 0.35rem 0.7rem;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

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

.recorded {
  margin-top: 1.25rem;
}

.recorded a {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  color: var(--pack-ink);
  font-family: var(--font-mono);
  font-size: 0.9375rem;
  text-decoration: none;
}

.recorded a:hover {
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

.colophon {
  padding: 1.25rem var(--pad) 2rem;
  border-top: 1px solid var(--gridline);
}

.colophon .muted {
  margin: 0;
  max-width: 70ch;
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
