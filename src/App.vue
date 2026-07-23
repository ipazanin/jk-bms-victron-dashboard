<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'

import Sidebar from './components/Sidebar.vue'
import BusView from './components/views/BusView.vue'
import ConnectView from './components/views/ConnectView.vue'
import StatsView from './components/views/StatsView.vue'
import WarningsView from './components/views/WarningsView.vue'
import LogView from './components/history/LogView.vue'
import SessionView from './components/history/SessionView.vue'
import { provideHistoryEnvironment, useHistoryBrowser } from './application/history/historyBrowser'
import { route, startRouting } from './application/route'
import { applyTheme, loadThemeChoice, resolveTheme, saveThemeChoice, themeFromQuery } from './application/theme'
import type { Theme } from './application/theme'
import { attachHistoryStore, useTelemetry } from './application/telemetry'
import { useMediaQuery } from './application/useMediaQuery'
import { downloadJson } from './infrastructure/history/downloadJson'
import { openHistoryStore } from './infrastructure/history/openHistoryStore'

const telemetry = useTelemetry()
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

function toggleTheme(): void {
  forcedTheme.value = null
  const next: Theme = theme.value === 'dark' ? 'light' : 'dark'
  chosenTheme.value = next
  saveThemeChoice(next)
}

const sessionCount = computed(() => log.archive.value.sessions)

/**
 * Empty only in the branches that never render the session view. Reading the id out here rather
 * than narrowing inside the template keeps the route's shape in TypeScript's hands.
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

let stopRouting: (() => void) | null = null
let stopReconnectWatch: (() => void) | null = null
let reconnectTried = false

// main.ts sets the attribute before the mount so nothing paints on the wrong plane; this keeps it
// in step afterwards, when the owner toggles or the machine changes its mind.
watchEffect(() => applyTheme(theme.value))

onMounted(() => {
  // Restore the last live session from localStorage, so the instruments render on first paint
  // instead of the empty landing page. Synchronous by necessity: the archive probe below is a
  // promise, and first paint can never be made to wait on one.
  telemetry.restoreRemembered()

  // Then try, once and silently, to rejoin the last pack without the chooser — but only once the
  // radio is confirmed on. Firing before that would leave the Connect tab stuck on 'connecting' for
  // the whole reconnect timeout when Bluetooth is simply off. It holds the remembered view up and
  // only replaces it if the link comes live; a pack merely out of range leaves the remembered
  // numbers on screen and the reconnect button in the Connect tab. getDevices()/gatt.connect() need
  // no user gesture, so this is safe off a watcher rather than a click.
  stopReconnectWatch = watch(
    telemetry.adapterOn,
    (on) => {
      if (on !== true || reconnectTried) return
      reconnectTried = true
      void telemetry.reconnectBms(true)
    },
    { immediate: true },
  )

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
  stopReconnectWatch?.()
  stopReconnectWatch = null
})
</script>

<template>
  <div class="layout">
    <Sidebar :theme="theme" :session-count="sessionCount" @toggle-theme="toggleTheme" />

    <div class="workspace">
      <BusView v-if="route.name === 'dashboard'" />
      <ConnectView v-else-if="route.name === 'connect'" />
      <StatsView v-else-if="route.name === 'stats'" />
      <WarningsView v-else-if="route.name === 'warnings'" />
      <LogView v-else-if="route.name === 'log'" />
      <SessionView v-else :id="sessionId" />

      <footer class="colophon">
        <p class="muted">
          Nothing leaves this page. It makes no network request after it loads: no backend, no
          telemetry, no analytics. Your encryption key and your log stay in this browser.
        </p>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 15rem minmax(0, 1fr);
  min-height: 100vh;
  max-width: 1400px;
  margin: 0 auto;
  background: var(--surface);
}

.workspace {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.workspace > :first-child {
  flex: 1;
}

.colophon {
  padding: 1.25rem var(--pad) 2rem;
  border-top: 1px solid var(--gridline);
}

.colophon .muted {
  margin: 0;
  max-width: 70ch;
}

@media (max-width: 860px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
