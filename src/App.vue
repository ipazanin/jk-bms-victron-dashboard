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
import { useHistoryBrowser } from './application/history/historyBrowser'
import type { HistoryStore } from './application/history/port'
import { route, startRouting } from './application/route'
import { loadSidebarCollapsed, saveSidebarCollapsed } from './application/sidebarLayout'
import { applyTheme, loadThemeChoice, resolveTheme, saveThemeChoice, themeFromQuery } from './application/theme'
import type { Theme } from './application/theme'
import { attachHistoryStore, useTelemetry } from './application/telemetry'
import { useMediaQuery } from './application/useMediaQuery'
import { useArchiveWorkspace } from './application/backup/useArchiveWorkspace'
import { useGoogleSync } from './application/sync/useGoogleSync'
import { restoredPreferencesRevision } from './application/backup/preferences'
import ArchiveSourceBar from './components/backup/ArchiveSourceBar.vue'
import { fakeRadioController } from './infrastructure/ble/fake/fakeDeps'
import { FAKE_ARCHIVE_NAME } from './infrastructure/history/fakeArchiveName'
import { DATABASE_NAME } from './infrastructure/history/IdbHistoryStore'
import { openHistoryStore } from './infrastructure/history/openHistoryStore'

const telemetry = useTelemetry()
const log = useHistoryBrowser()
const archives = useArchiveWorkspace()
const googleSync = useGoogleSync()
const historyViewKey = computed(() => `${archives.selectedSourceId.value ?? 'local'}:${restoredPreferencesRevision.value}`)
watch(archives.selectedSourceId, (sourceId) => {
  const address = new URL(window.location.href)
  if (sourceId === null) address.searchParams.delete('archive')
  else address.searchParams.set('archive', sourceId)
  window.history.replaceState(window.history.state, '', address)
})

/** A theme query overrides the system preference until the user chooses a theme. */
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

const sessionId = computed(() => (route.value.name === 'session' ? route.value.id : ''))

// The route keeps the viewed session protected from pruning across component remounts.
watch(
  sessionId,
  (id) => (id === '' ? log.unloadSession() : void log.loadSession(id)),
  { immediate: true },
)

const isDesktop = useIsDesktop()
const collapsed = ref(loadSidebarCollapsed())
const mobileOpen = ref(false)

const headerStatus = computed<HeaderStatus>(() => ({
  source: telemetry.source.value,
  worst: telemetry.worstFault.value,
}))

function onToggleSidebar(): void {
  if (isDesktop.value) {
    collapsed.value = !collapsed.value
    saveSidebarCollapsed(collapsed.value)
  } else {
    mobileOpen.value = !mobileOpen.value
  }
}

watch(restoredPreferencesRevision, () => {
  forcedTheme.value = null
  chosenTheme.value = loadThemeChoice()
  collapsed.value = loadSidebarCollapsed()
})
watch(isDesktop, (wide) => {
  if (wide) mobileOpen.value = false
})
watch(route, () => {
  mobileOpen.value = false
})

// Restore drawer focus only if navigation has not moved it into the page.
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
let stopArchiveLevers: (() => void) | null = null
let disposed = false

function wireArchive(store: HistoryStore): void {
  attachHistoryStore(store)
  archives.attachLocalStore(store)
}

watchEffect(() => applyTheme(theme.value))

onMounted(() => {
  googleSync.start()
  telemetry.restoreRemembered()

  telemetry.startRejoin()

  stopRouting = startRouting()

  const archiveName = import.meta.env.VITE_FAKE_BLE === 'true' ? FAKE_ARCHIVE_NAME : DATABASE_NAME
  void openHistoryStore(archiveName)
    .then((store) => {
      if (disposed) {
        store.close()
        return
      }
      const archive =
        import.meta.env.VITE_FAKE_BLE === 'true' ? fakeRadioController().archiveFor(store) : store
      wireArchive(archive)
      const browserName = navigator.userAgent.includes('Firefox/')
        ? 'Firefox'
        : navigator.userAgent.includes('Edg/')
          ? 'Edge'
          : navigator.userAgent.includes('Chrome/') ? 'Chrome' : 'Browser'
      if (import.meta.env.VITE_FAKE_BLE === 'true') {
        stopArchiveLevers = fakeRadioController().onArchiveChange(wireArchive)
      }
      return archives.initialize(archiveName, archive, `${browserName} on ${navigator.platform || 'this device'}`).then(() => {
        if (disposed) return
        const selectedSource = new URL(window.location.href).searchParams.get('archive')
        if (selectedSource !== null) return archives.selectSource(selectedSource)
      })
    })
    .catch(() => undefined)

  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  disposed = true
  googleSync.dispose()
  stopRouting?.()
  stopRouting = null
  telemetry.stopRejoin()
  stopArchiveLevers?.()
  stopArchiveLevers = null
  archives.dispose()
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
        <ArchiveSourceBar v-if="['stats', 'warnings', 'log', 'session'].includes(route.name)" />
        <BusView v-if="route.name === 'dashboard'" />
        <ConnectView v-else-if="route.name === 'connect'" :key="restoredPreferencesRevision" />
        <StatsView v-else-if="route.name === 'stats'" :key="historyViewKey" />
        <WarningsView v-else-if="route.name === 'warnings'" :key="historyViewKey" />
        <LogView v-else-if="route.name === 'log'" :key="historyViewKey" />
        <SessionView v-else :key="historyViewKey" :id="sessionId" />

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
