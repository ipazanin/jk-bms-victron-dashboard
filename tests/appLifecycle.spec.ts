// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import type { App as MountedApp } from 'vue'
import type { HistoryStore } from '../src/application/history/port'
import App from '../src/App.vue'

const lifecycle = vi.hoisted(() => ({
  openStore: vi.fn<() => Promise<HistoryStore>>(),
  attachHistoryStore: vi.fn(),
  attachLocalStore: vi.fn(),
  initialize: vi.fn<() => Promise<void>>(),
  selectSource: vi.fn<() => Promise<void>>(),
  restoreRemembered: vi.fn(),
  startRejoin: vi.fn(),
}))

vi.mock('../src/infrastructure/history/openHistoryStore', () => ({ openHistoryStore: lifecycle.openStore }))
vi.mock('../src/application/backup/useArchiveWorkspace', async () => {
  const { ref } = await import('vue')
  const workspace = {
    selectedSourceId: ref(null),
    attachLocalStore: lifecycle.attachLocalStore,
    initialize: lifecycle.initialize,
    selectSource: lifecycle.selectSource,
    dispose: vi.fn(),
  }
  return { useArchiveWorkspace: () => workspace }
})
vi.mock('../src/application/telemetry', async () => {
  const { ref } = await import('vue')
  return {
    attachHistoryStore: lifecycle.attachHistoryStore,
    useTelemetry: () => ({
      source: ref('none'),
      worstFault: ref(null),
      restoreRemembered: lifecycle.restoreRemembered,
      startRejoin: lifecycle.startRejoin,
      stopRejoin: vi.fn(),
    }),
  }
})
vi.mock('../src/application/history/historyBrowser', async () => {
  const { ref } = await import('vue')
  return { useHistoryBrowser: () => ({ archive: ref({ sessions: 0 }), unloadSession: vi.fn(), loadSession: vi.fn() }) }
})
vi.mock('../src/application/sync/useGoogleSync', () => ({ useGoogleSync: () => ({ start: vi.fn(), dispose: vi.fn() }) }))
vi.mock('../src/components/AppFooter.vue', () => ({ default: { render: () => null } }))
vi.mock('../src/components/AppHeader.vue', () => ({ default: { render: () => null } }))
vi.mock('../src/components/Sidebar.vue', () => ({ default: { render: () => null } }))
vi.mock('../src/components/views/BusView.vue', () => ({ default: { render: () => null } }))
vi.mock('../src/components/views/ConnectView.vue', () => ({ default: { render: () => null } }))
vi.mock('../src/components/views/StatsView.vue', () => ({ default: { render: () => null } }))
vi.mock('../src/components/views/WarningsView.vue', () => ({ default: { render: () => null } }))
vi.mock('../src/components/history/LogView.vue', () => ({ default: { render: () => null } }))
vi.mock('../src/components/history/SessionView.vue', () => ({ default: { render: () => null } }))
vi.mock('../src/components/backup/ArchiveSourceBar.vue', () => ({ default: { render: () => null } }))

function deferred<T>() {
  let resolve!: (result: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

let app: MountedApp | null = null
let host: HTMLElement

function mountApp(): void {
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(App)
  app.mount(host)
}

function unmountApp(): void {
  app?.unmount()
  app = null
}

async function settleInitialization(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VITE_FAKE_BLE', 'false')
  lifecycle.initialize.mockResolvedValue(undefined)
  lifecycle.selectSource.mockResolvedValue(undefined)
  window.history.replaceState(null, '', '/?archive=other-source')
})

afterEach(() => {
  vi.unstubAllGlobals()
  unmountApp()
  host.remove()
  localStorage.clear()
  vi.unstubAllEnvs()
})

describe('archive initialization during app teardown', () => {
  it('closes a store opened after unmount without attaching it', async () => {
    const opening = deferred<HistoryStore>()
    const close = vi.fn()
    lifecycle.openStore.mockReturnValue(opening.promise)
    mountApp()

    expect(lifecycle.restoreRemembered).toHaveBeenCalledOnce()
    expect(lifecycle.startRejoin).toHaveBeenCalledOnce()
    unmountApp()
    opening.resolve({ close } as unknown as HistoryStore)
    await settleInitialization()

    expect(close).toHaveBeenCalledOnce()
    expect(lifecycle.attachHistoryStore).not.toHaveBeenCalled()
    expect(lifecycle.attachLocalStore).not.toHaveBeenCalled()
    expect(lifecycle.initialize).not.toHaveBeenCalled()
  })

  it('does not read the location or select a source when initialization finishes after unmount', async () => {
    const initializing = deferred<void>()
    lifecycle.openStore.mockResolvedValue({ close: vi.fn() } as unknown as HistoryStore)
    lifecycle.initialize.mockReturnValue(initializing.promise)
    mountApp()
    await settleInitialization()
    expect(lifecycle.initialize).toHaveBeenCalledOnce()
    unmountApp()

    const location = window.location
    const readLocation = vi.fn(() => location)
    vi.stubGlobal('window', { get location() { return readLocation() } })
    initializing.resolve()
    await settleInitialization()
    vi.unstubAllGlobals()

    expect(readLocation).not.toHaveBeenCalled()
    expect(lifecycle.selectSource).not.toHaveBeenCalled()
  })

  it('handles initialization rejection through the archive opening error handler', async () => {
    const initializing = deferred<void>()
    lifecycle.openStore.mockResolvedValue({ close: vi.fn() } as unknown as HistoryStore)
    lifecycle.initialize.mockReturnValue(initializing.promise)
    mountApp()
    await settleInitialization()
    initializing.reject(new Error('Archive initialization failed'))
    await settleInitialization()

    expect(lifecycle.selectSource).not.toHaveBeenCalled()
  })

  it('handles source selection rejection through the archive opening error handler', async () => {
    lifecycle.openStore.mockResolvedValue({ close: vi.fn() } as unknown as HistoryStore)
    lifecycle.selectSource.mockRejectedValue(new Error('Source unavailable'))
    mountApp()
    await settleInitialization()

    expect(lifecycle.selectSource).toHaveBeenCalledWith('other-source')
  })
})
