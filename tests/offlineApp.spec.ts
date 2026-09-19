// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { InstallPromptEvent } from '../src/application/InstallPromptEvent'

function worker(state: ServiceWorkerState) {
  return Object.assign(new EventTarget(), { state, postMessage: vi.fn() })
}

function registration() {
  return Object.assign(new EventTarget(), {
    installing: null as ReturnType<typeof worker> | null,
    waiting: null as ReturnType<typeof worker> | null,
    active: null as ReturnType<typeof worker> | null,
    update: vi.fn(async () => undefined),
  })
}

let registered: ReturnType<typeof registration>
let container: EventTarget & { register: ReturnType<typeof vi.fn> }
let standalone: EventTarget & { matches: boolean }
let offline: typeof import('../src/application/offlineApp')
let stop: (() => void) | null

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
}

async function start(): Promise<ReturnType<typeof offline.useOfflineApp>> {
  stop = offline.startOfflineApp()
  await settle()
  return offline.useOfflineApp()
}

function promptEvent(outcome: 'accepted' | 'dismissed' = 'dismissed'): InstallPromptEvent {
  return Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn(async () => undefined),
    userChoice: Promise.resolve({ outcome }),
  })
}

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('PROD', true)
  vi.stubEnv('VITE_FAKE_BLE', 'false')
  vi.stubEnv('BASE_URL', '/boat/')
  registered = registration()
  container = Object.assign(new EventTarget(), {
    register: vi.fn(async () => registered as unknown as ServiceWorkerRegistration),
  })
  standalone = Object.assign(new EventTarget(), { matches: false })
  vi.stubGlobal('navigator', { onLine: true, serviceWorker: container })
  vi.stubGlobal('matchMedia', vi.fn(() => standalone))
  vi.stubGlobal('isSecureContext', true)
  stop = null
  offline = await import('../src/application/offlineApp')
})

afterEach(() => {
  stop?.()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('offline registration lifecycle', () => {
  it.each(['development', 'fake'])('does not register in %s builds', async (mode) => {
    if (mode === 'development') vi.stubEnv('PROD', false)
    else vi.stubEnv('VITE_FAKE_BLE', 'true')
    const app = await start()
    expect(app.state.value).toBe('development')
    expect(container.register).not.toHaveBeenCalled()
  })

  it.each(['insecure', 'unsupported'])('reports an unavailable offline copy in %s contexts', async (reason) => {
    if (reason === 'insecure') vi.stubGlobal('isSecureContext', false)
    else vi.stubGlobal('navigator', { onLine: true })
    const app = await start()
    expect(app.state.value).toBe('unavailable')
    expect(container.register).not.toHaveBeenCalled()
  })

  it('reports failed registration without an unhandled rejection', async () => {
    container.register.mockRejectedValueOnce(new Error('storage denied'))
    expect((await start()).state.value).toBe('unavailable')
  })

  it('registers under the deployment base and waits for activation before promising offline access', async () => {
    const incoming = worker('installing')
    registered.installing = incoming
    const app = await start()
    expect(container.register).toHaveBeenCalledWith('/boat/sw.js', {
      scope: '/boat/', updateViaCache: 'none',
    })
    expect(app.state.value).toBe('checking')

    incoming.state = 'installed'
    registered.installing = null
    registered.waiting = incoming
    incoming.dispatchEvent(new Event('statechange'))
    expect(app.state.value).toBe('checking')

    incoming.state = 'activating'
    registered.waiting = null
    registered.active = incoming
    incoming.dispatchEvent(new Event('statechange'))
    expect(app.state.value).toBe('checking')

    incoming.state = 'activated'
    incoming.dispatchEvent(new Event('statechange'))
    expect(app.state.value).toBe('ready')
    expect(app.status.value).toBe('Ready offline')
    Object.assign(navigator, { onLine: false })
    window.dispatchEvent(new Event('offline'))
    expect(app.status.value).toBe('Offline · saved app ready')
  })

  it('reports a failed initial installation even before its registration pointer is cleared', async () => {
    const incoming = worker('installing')
    registered.installing = incoming
    const app = await start()
    incoming.state = 'redundant'
    incoming.dispatchEvent(new Event('statechange'))
    expect(app.state.value).toBe('unavailable')
  })

  it('keeps the usable offline copy while an update waits and never forces activation', async () => {
    const active = worker('activated')
    registered.active = active
    const app = await start()
    const incoming = worker('installing')
    registered.installing = incoming
    registered.dispatchEvent(new Event('updatefound'))
    incoming.state = 'installed'
    registered.installing = null
    registered.waiting = incoming
    incoming.dispatchEvent(new Event('statechange'))
    expect(app.state.value).toBe('ready')
    expect(app.updateReady.value).toBe(true)
    expect(incoming.postMessage).not.toHaveBeenCalled()
    expect(active.postMessage).not.toHaveBeenCalled()

    incoming.state = 'redundant'
    registered.waiting = null
    incoming.dispatchEvent(new Event('statechange'))
    expect(app.state.value).toBe('ready')
    expect(app.updateReady.value).toBe(false)
  })

  it('checks for updates when visible and tolerates an offline update failure', async () => {
    registered.active = worker('activated')
    const app = await start()
    registered.update.mockRejectedValueOnce(new Error('network unavailable'))
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(registered.update).toHaveBeenCalledOnce()
    expect(app.state.value).toBe('ready')
    Object.assign(navigator, { onLine: false })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(registered.update).toHaveBeenCalledOnce()
  })

  it('removes listeners and ignores a registration that resolves after cleanup', async () => {
    let resolveRegistration!: (registration: ServiceWorkerRegistration) => void
    container.register.mockReturnValueOnce(new Promise<ServiceWorkerRegistration>((resolve) => {
      resolveRegistration = resolve
    }))
    const app = await start()
    stop?.()
    registered.active = worker('activated')
    resolveRegistration(registered as unknown as ServiceWorkerRegistration)
    await settle()
    window.dispatchEvent(promptEvent())
    window.dispatchEvent(new Event('appinstalled'))
    expect(app.canInstall.value).toBe(false)
    expect(app.installed.value).toBe(false)
    expect(app.state.value).toBe('checking')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(registered.update).not.toHaveBeenCalled()
  })

  it('detaches registration, worker, media, and browser listeners on cleanup', async () => {
    const active = worker('activated')
    registered.active = active
    const targets = [window, document, container, registered, standalone, active]
    const listeners = targets.map((target) => ({
      added: vi.spyOn(target, 'addEventListener'),
      removed: vi.spyOn(target, 'removeEventListener'),
    }))
    await start()
    stop?.()
    for (const { added, removed } of listeners) {
      for (const [type, callback] of added.mock.calls) {
        expect(removed).toHaveBeenCalledWith(type, callback)
      }
    }
  })
})

describe('browser installation prompt', () => {
  it.each(['accepted', 'dismissed'] as const)('uses a single deferred prompt when the user %s', async (outcome) => {
    const app = await start()
    const prompt = promptEvent(outcome)
    window.dispatchEvent(prompt)
    expect(prompt.defaultPrevented).toBe(true)
    expect(app.canInstall.value).toBe(true)
    await app.install()
    expect(prompt.prompt).toHaveBeenCalledOnce()
    expect(app.canInstall.value).toBe(false)
    expect(app.installing.value).toBe(false)
    expect(app.installFailed.value).toBe(false)
    expect(app.installed.value).toBe(false)
    await app.install()
    expect(prompt.prompt).toHaveBeenCalledOnce()
    window.dispatchEvent(new Event('appinstalled'))
    expect(app.installed.value).toBe(true)
  })

  it('shows a prompt failure and allows a later prompt to recover', async () => {
    const app = await start()
    const prompt = promptEvent()
    vi.mocked(prompt.prompt).mockRejectedValueOnce(new Error('browser refused'))
    window.dispatchEvent(prompt)
    await app.install()
    expect(app.installFailed.value).toBe(true)
    expect(app.installing.value).toBe(false)
    window.dispatchEvent(promptEvent())
    expect(app.installFailed.value).toBe(false)
    expect(app.canInstall.value).toBe(true)
  })

  it('detects an existing standalone installation', async () => {
    standalone.matches = true
    expect((await start()).installed.value).toBe(true)
  })
})
