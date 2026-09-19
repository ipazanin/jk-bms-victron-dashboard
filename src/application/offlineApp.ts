import { computed, readonly, ref } from 'vue'
import type { InstallPromptEvent } from './InstallPromptEvent'

type OfflineState = 'checking' | 'ready' | 'unavailable' | 'development'

const state = ref<OfflineState>('checking')
const online = ref(true)
const updateReady = ref(false)
const installed = ref(false)
const canInstall = ref(false)
const installing = ref(false)
const installFailed = ref(false)
let installPrompt: InstallPromptEvent | null = null

const status = computed(() => {
  if (state.value === 'ready') return online.value ? 'Ready offline' : 'Offline · saved app ready'
  if (state.value === 'development') return 'Offline cache is available in production builds'
  if (state.value === 'unavailable') return 'Offline copy unavailable'
  return online.value ? 'Preparing offline copy…' : 'Offline copy not ready'
})

export function startOfflineApp(): () => void {
  const standalone = window.matchMedia('(display-mode: standalone)')
  const updateInstalled = (): void => {
    installed.value = standalone.matches || ('standalone' in navigator && navigator.standalone === true)
  }
  const updateOnline = (): void => { online.value = navigator.onLine }
  const onInstallPrompt = (event: Event): void => {
    event.preventDefault()
    installPrompt = event as InstallPromptEvent
    canInstall.value = true
    installFailed.value = false
  }
  const onInstalled = (): void => {
    installed.value = true
    installPrompt = null
    canInstall.value = false
  }

  updateOnline()
  updateInstalled()
  window.addEventListener('online', updateOnline)
  window.addEventListener('offline', updateOnline)
  window.addEventListener('beforeinstallprompt', onInstallPrompt)
  window.addEventListener('appinstalled', onInstalled)
  standalone.addEventListener('change', updateInstalled)

  let stopped = false
  let registration: ServiceWorkerRegistration | null = null
  const observedWorkers = new Set<ServiceWorker>()
  const reportRegistration = (): void => {
    if (stopped || registration === null) return
    updateReady.value = registration.waiting?.state === 'installed'
    if (registration.active?.state === 'activated') state.value = 'ready'
    const worker = registration.installing ?? registration.waiting ?? registration.active
    if (worker !== null && !observedWorkers.has(worker)) {
      observedWorkers.add(worker)
      worker.addEventListener('statechange', reportRegistration)
    }
    const hasUsableWorker = [registration.active, registration.installing, registration.waiting]
      .some((candidate) => candidate !== null && candidate.state !== 'redundant')
    if (!hasUsableWorker) {
      state.value = 'unavailable'
    }
  }
  const onControllerChange = (): void => { reportRegistration() }
  const checkForUpdate = (): void => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      void registration?.update().catch(() => undefined)
    }
  }

  if (!import.meta.env.PROD || import.meta.env.VITE_FAKE_BLE === 'true') {
    state.value = 'development'
  } else if (!window.isSecureContext || !('serviceWorker' in navigator)) {
    state.value = 'unavailable'
  } else {
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    document.addEventListener('visibilitychange', checkForUpdate)
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
      updateViaCache: 'none',
    }).then((registered) => {
      if (stopped) return
      registration = registered
      registration.addEventListener('updatefound', reportRegistration)
      reportRegistration()
    }).catch(() => {
      if (!stopped) state.value = 'unavailable'
    })
  }

  return () => {
    stopped = true
    window.removeEventListener('online', updateOnline)
    window.removeEventListener('offline', updateOnline)
    window.removeEventListener('beforeinstallprompt', onInstallPrompt)
    window.removeEventListener('appinstalled', onInstalled)
    standalone.removeEventListener('change', updateInstalled)
    navigator.serviceWorker?.removeEventListener('controllerchange', onControllerChange)
    document.removeEventListener('visibilitychange', checkForUpdate)
    registration?.removeEventListener('updatefound', reportRegistration)
    for (const worker of observedWorkers) worker.removeEventListener('statechange', reportRegistration)
    installPrompt = null
    canInstall.value = false
  }
}

async function install(): Promise<void> {
  const prompt = installPrompt
  if (prompt === null || installing.value) return
  installing.value = true
  installFailed.value = false
  installPrompt = null
  canInstall.value = false
  try {
    await prompt.prompt()
    await prompt.userChoice
  } catch {
    installFailed.value = true
  } finally {
    installing.value = false
  }
}

export function useOfflineApp() {
  return {
    state: readonly(state),
    status,
    updateReady: readonly(updateReady),
    installed: readonly(installed),
    canInstall: readonly(canInstall),
    installing: readonly(installing),
    installFailed: readonly(installFailed),
    install,
  }
}
