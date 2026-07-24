<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'

import AppFooter from './components/AppFooter.vue'
import AppHeader from './components/AppHeader.vue'
import type { HeaderStatus } from './components/AppHeader.vue'
import Sidebar from './components/Sidebar.vue'
import BusView from './components/views/BusView.vue'
import ConnectView from './components/views/ConnectView.vue'
import StatsView from './components/views/StatsView.vue'
import WarningsView from './components/views/WarningsView.vue'
import LogView from './components/history/LogView.vue'
import SessionView from './components/history/SessionView.vue'
import { useIsDesktop } from './application/breakpoints'
import { provideHistoryEnvironment, useHistoryBrowser } from './application/history/historyBrowser'
import { route, startRouting } from './application/route'
import { loadSidebarCollapsed, saveSidebarCollapsed } from './application/sidebarLayout'
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

/**
 * Two independent pieces of shell state, plus the reactive width they branch on. The desktop
 * rail's collapse is a remembered preference; the mobile drawer's open state is a momentary thing,
 * closed again by the next navigation, an Escape, a scrim tap, or a resize back up to desktop.
 * The one header button means "collapse the rail" on desktop and "open the drawer" on mobile.
 */
const isDesktop = useIsDesktop()
const collapsed = ref(loadSidebarCollapsed())
const mobileOpen = ref(false)

/** The two fields the header draws, assembled here so the header never reaches into telemetry. */
const headerStatus = computed<HeaderStatus>(() => ({
  source: telemetry.source.value,
  worst: telemetry.worstFault.value,
}))

function onToggleSidebar(): void {
  if (isDesktop.value) collapsed.value = !collapsed.value
  else mobileOpen.value = !mobileOpen.value
}

watch(collapsed, saveSidebarCollapsed)
// Crossing back up to desktop closes any lingering drawer, so a resize can't leave an off-canvas
// panel half-owning the layout; navigating closes it for the same reason.
watch(isDesktop, (wide) => {
  if (wide) mobileOpen.value = false
})
watch(route, () => {
  mobileOpen.value = false
})

/**
 * The open drawer is modal: lock the page behind it so it cannot scroll under the scrim, and move
 * focus into the panel. Closing hands focus back to the button that opened it — but only when focus
 * was still inside the drawer, so a close triggered by navigation does not yank focus off the page.
 */
watch(mobileOpen, async (open) => {
  document.documentElement.style.overflow = open ? 'hidden' : ''
  if (open) {
    await nextTick()
    document.querySelector<HTMLElement>('#app-sidebar a')?.focus()
    return
  }
  const active = document.activeElement
  const wasInDrawer = active instanceof HTMLElement && active.closest('#app-sidebar') !== null
  if (wasInDrawer || active === null || active === document.body) {
    document.getElementById('sidebar-toggle')?.focus()
  }
})

const onKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape' && mobileOpen.value) mobileOpen.value = false
}

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

  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  stopRouting?.()
  stopRouting = null
  stopReconnectWatch?.()
  stopReconnectWatch = null
  window.removeEventListener('keydown', onKeydown)
  document.documentElement.style.overflow = ''
})
</script>

<template>
  <div class="app-shell">
    <AppHeader
      :theme="theme"
      :collapsed="collapsed"
      :mobile-open="mobileOpen"
      :status="headerStatus"
      @toggle-theme="toggleTheme"
      @toggle-sidebar="onToggleSidebar"
    />

    <div class="app-body">
      <Sidebar
        :collapsed="collapsed"
        :mobile-open="mobileOpen"
        :session-count="sessionCount"
        @close="mobileOpen = false"
      />

      <main
        class="workspace"
        :inert="(mobileOpen && !isDesktop) || undefined"
        :aria-hidden="mobileOpen && !isDesktop ? 'true' : undefined"
      >
        <BusView v-if="route.name === 'dashboard'" />
        <ConnectView v-else-if="route.name === 'connect'" />
        <StatsView v-else-if="route.name === 'stats'" />
        <WarningsView v-else-if="route.name === 'warnings'" />
        <LogView v-else-if="route.name === 'log'" />
        <SessionView v-else :id="sessionId" />

        <AppFooter />
      </main>
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  width: 100%;
  /* ~1920px cap — breathes wider than the old 1400px, still bounded for ultrawide readability. */
  max-width: 120rem;
  margin-inline: auto;
  /* Page plane; the rail's --surface now reads as a distinct region one step in. */
  background: var(--plane);
}

.app-body {
  display: grid;
  /* Col 1 follows the rail's own width (auto), so collapse animates the grid with no hardcoded
     column here; col 2 never drops below 0 so wide content scrolls in its own box, not the page. */
  grid-template-columns: auto minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}

.workspace {
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* Fluid gutter from 320px to ultrawide, replacing the one hardcoded rail-plus-fixed-pad size. */
  padding-inline: clamp(1rem, 3.5vw, 2.5rem);
}

/* Keeps the footer pinned to the bottom on short pages. */
.workspace > :first-child {
  flex: 1;
}

@media (max-width: 860px) {
  /* The rail becomes fixed/off-canvas, so the body collapses to a single column. */
  .app-body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
