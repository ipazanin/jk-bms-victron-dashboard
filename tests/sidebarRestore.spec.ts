// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import type { App as MountedApp } from 'vue'

vi.stubEnv('VITE_FAKE_BLE', 'true')

const { default: App } = await import('../src/App.vue')
const { applyArchivePreferences } = await import('../src/application/backup/preferences')
const { fakeRadioController } = await import('../src/infrastructure/ble/fake/fakeDeps')

let app: MountedApp | null = null
let host: HTMLElement

beforeAll(() => {
  localStorage.setItem('shunt.sidebar', 'collapsed')
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(App)
  app.mount(host)
})

afterAll(() => {
  app?.unmount()
  app = null
  host.remove()
  fakeRadioController().archive?.close()
  localStorage.clear()
  vi.unstubAllEnvs()
})

describe('restored sidebar preference', () => {
  it('leaves a removed sidebar choice removed instead of writing the default back', async () => {
    applyArchivePreferences([], false, ['shunt.sidebar'])
    await nextTick()
    await nextTick()

    // A written-back 'expanded' would differ from the synced settings and publish a new revision.
    expect(localStorage.getItem('shunt.sidebar')).toBeNull()
  })
})
