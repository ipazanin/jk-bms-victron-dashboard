// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, shallowRef } from 'vue'
import type { App } from 'vue'
import type { CloudWorkspace } from '../src/domain/sync/CloudWorkspace'
import type { CloudArchiveRevision } from '../src/domain/sync/CloudArchiveRevision'
import type { CloudSettingsRevision } from '../src/domain/sync/CloudSettingsRevision'
import GoogleSyncPanel from '../src/components/backup/GoogleSyncPanel.vue'

vi.mock('../src/application/sync/useGoogleSync', () => ({ useGoogleSync: () => sync }))

const sync = {
  enabled: ref(false),
  configured: ref(true),
  prepared: ref(false),
  preparing: ref(false),
  connected: ref(false),
  workspace: shallowRef<CloudWorkspace | null>(null),
  workspaces: shallowRef<readonly CloudWorkspace[]>([]),
  revisions: shallowRef<readonly CloudArchiveRevision[]>([]),
  sourceLabel: ref('Boat tablet'),
  includeSecret: ref(false),
  autoSync: ref(true),
  busy: ref(false),
  progress: ref<string | null>(null),
  failure: ref<string | null>(null),
  notice: ref<string | null>(null),
  lastSyncAt: ref<number | null>(null),
  conflicts: shallowRef<readonly CloudSettingsRevision[]>([]),
  conflictReason: ref<string | null>(null),
  setEnabled: vi.fn((enabled: boolean) => { sync.enabled.value = enabled }),
  connect: vi.fn(),
  prepare: vi.fn(),
  disconnect: vi.fn(),
  createWorkspace: vi.fn(),
  selectWorkspace: vi.fn(),
  chooseWorkspace: vi.fn(),
  setSourceLabel: vi.fn(),
  setIncludeSecret: vi.fn(),
  setAutoSync: vi.fn(),
  syncNow: vi.fn(),
  cancel: vi.fn(),
  openRevision: vi.fn(),
  resolveSettings: vi.fn(),
  trashWorkspace: vi.fn(),
}

let app: App
let host: HTMLElement

beforeEach(() => {
  vi.clearAllMocks()
  sync.enabled.value = false
  sync.configured.value = true
  sync.prepared.value = false
  sync.preparing.value = false
  sync.connected.value = false
  sync.workspace.value = null
  sync.workspaces.value = []
  sync.revisions.value = []
  sync.sourceLabel.value = 'Boat tablet'
  sync.includeSecret.value = false
  sync.autoSync.value = true
  sync.busy.value = false
  sync.progress.value = null
  sync.failure.value = null
  sync.notice.value = null
  sync.lastSyncAt.value = null
  sync.conflicts.value = []
  sync.conflictReason.value = null
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  app.unmount()
  host.remove()
})

async function mount(): Promise<void> {
  app = createApp(GoogleSyncPanel)
  app.mount(host)
  await nextTick()
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  if (found === undefined) throw new Error(`Missing button: ${label}`)
  return found
}

function connectWorkspace(): void {
  sync.enabled.value = true
  sync.connected.value = true
  sync.workspace.value = { id: 'sheet', name: 'Boat history', folderId: 'folder', version: 2 }
}

function archiveRevision(): CloudArchiveRevision {
  return {
    storage: 'snapshot',
    id: 'archive-revision', source: { id: 'remote', label: 'Cabin laptop' },
    exportedAt: Date.UTC(2026, 9, 18), createdAt: Date.UTC(2026, 9, 18), snapshotFileId: 'snapshot', snapshotHash: 'hash',
    contentHash: 'content', sessions: 12, samples: 0, hours: 168, bytes: 1200, storedBytes: 300,
  }
}

describe('Google sync controls', () => {
  it('starts disabled and does not connect merely by enabling the setting', async () => {
    await mount()
    const enable = host.querySelector<HTMLInputElement>('[data-testid="enable-google-sync"]')!
    expect(enable.checked).toBe(false)
    expect(host.querySelector('[data-testid="connect-google"]')).toBeNull()
    enable.click()
    await nextTick()
    expect(sync.setEnabled).toHaveBeenCalledWith(true)
    expect(sync.connect).not.toHaveBeenCalled()
    expect(button('Connect Google').disabled).toBe(true)

    sync.prepared.value = true
    await nextTick()
    button('Connect Google').click()
    expect(sync.connect).toHaveBeenCalledOnce()
  })

  it('keeps an unconfigured installation local and explains setup', async () => {
    sync.enabled.value = true
    sync.configured.value = false
    await mount()
    expect(host.textContent).toContain('Google sync is not configured for this installation')
    expect(host.textContent).toContain('Local recording and JSON archives remain available')
    expect(host.querySelector('[data-testid="connect-google"]')).toBeNull()
    expect(sync.connect).not.toHaveBeenCalled()
  })

  it('offers a retry when Google sign-in could not load', async () => {
    sync.enabled.value = true
    sync.failure.value = 'Google sign-in could not load.'
    await mount()
    expect(button('Connect Google').disabled).toBe(true)
    button('Retry Google setup').click()
    expect(sync.prepare).toHaveBeenCalledOnce()
    expect(sync.connect).not.toHaveBeenCalled()
  })

  it('requires its own key opt-in and makes sync available without Bluetooth', async () => {
    connectWorkspace()
    await mount()
    expect(navigator.bluetooth).toBeUndefined()
    const secret = host.querySelector<HTMLInputElement>('[data-testid="sync-secret"]')!
    expect(secret.checked).toBe(false)
    secret.click()
    expect(sync.setIncludeSecret).toHaveBeenCalledWith(true)
    expect(host.textContent).toContain('Turning this off does not remove keys from older cloud copies')
    button('Sync now').click()
    expect(sync.syncNow).toHaveBeenCalledOnce()
    host.querySelector<HTMLInputElement>('[data-testid="automatic-sync"]')!.click()
    expect(sync.setAutoSync).toHaveBeenCalledWith(false)
  })

  it('keeps the old workspace selected until choosing another succeeds', async () => {
    connectWorkspace()
    sync.workspaces.value = [sync.workspace.value!, { id: 'second', name: 'Other boat', folderId: 'second-folder' }]
    await mount()
    const picker = host.querySelector<HTMLSelectElement>('select')!
    picker.value = 'second'
    picker.dispatchEvent(new Event('change'))
    expect(sync.selectWorkspace).toHaveBeenCalledWith('second')
    expect(picker.value).toBe('sheet')
    button('Choose in Google Drive').click()
    expect(sync.chooseWorkspace).toHaveBeenCalledOnce()
  })

  it('opens a cloud revision as a saved history source', async () => {
    connectWorkspace()
    sync.revisions.value = [archiveRevision()]
    await mount()
    expect(host.textContent).toContain('Cabin laptop')
    expect(host.textContent).toContain('12 sessions')
    expect(host.textContent).toContain('168 hourly summaries')
    expect(host.textContent).toContain('permanently removes its older copies')
    expect(host.textContent).toContain('Raw recordings stay local')
    button('Open saved history').click()
    expect(sync.openRevision).toHaveBeenCalledWith('archive-revision')
  })

  it('keeps legacy copies openable and guides creation without offering uploads', async () => {
    connectWorkspace()
    sync.workspace.value = { ...sync.workspace.value!, version: 1 }
    sync.revisions.value = [{
      id: 'legacy', source: { id: 'phone', label: 'Phone' }, exportedAt: Date.UTC(2026, 9, 18),
      manifestFileId: 'manifest', manifestHash: 'hash', contentHash: 'content', sessions: 1, samples: 8000, bytes: 1200,
    }]
    await mount()
    expect(host.textContent).toContain('This legacy workspace is read-only')
    expect(host.textContent).toContain('Create a compact workspace')
    expect(host.textContent).toContain('8,000 samples')
    expect(host.querySelector('[data-testid="sync-now"]')).toBeNull()
    button('Open saved history').click()
    expect(sync.openRevision).toHaveBeenCalledWith('legacy')
  })

  it('lists saved cloud copies newest first', async () => {
    connectWorkspace()
    sync.revisions.value = [archiveRevision(), { ...archiveRevision(), id: 'newer', source: { id: 'phone', label: 'Galley phone' } }]
    await mount()
    const labels = [...host.querySelectorAll('.revision-list strong')].map((label) => label.textContent)
    expect(labels).toEqual(['Galley phone', 'Cabin laptop'])
  })

  it('offers an explicit settings choice without displaying a stored key', async () => {
    connectWorkspace()
    sync.revisions.value = [archiveRevision()]
    sync.conflicts.value = [{
      id: 'cloud-settings', sourceId: 'remote', parents: [], createdAt: Date.UTC(2026, 9, 18),
      preferences: [{ key: 'victron.advertisementKey', value: 'secret-not-for-the-screen' }],
    }]
    sync.conflictReason.value = 'Both devices changed their shared settings.'
    await mount()
    expect(host.textContent).toContain('Both devices changed their shared settings')
    expect(host.textContent).not.toContain('secret-not-for-the-screen')
    button("Use this browser's settings").click()
    expect(sync.resolveSettings).toHaveBeenLastCalledWith('local')
    button('Use these cloud settings').click()
    expect(sync.resolveSettings).toHaveBeenLastCalledWith('cloud-settings')
  })

  it('leaves cancellation and disabling available during a transfer', async () => {
    connectWorkspace()
    sync.busy.value = true
    sync.progress.value = 'Uploading saved history…'
    await mount()
    expect(host.textContent).toContain('Uploading saved history…')
    expect(button('Sync now').matches(':disabled')).toBe(true)
    expect(button('Disconnect Google').disabled).toBe(true)
    expect(host.querySelector('[data-testid="sync-secret"]')!.matches(':disabled')).toBe(true)
    expect(host.querySelector('[data-testid="cloud-device-label"]')!.matches(':disabled')).toBe(true)
    host.querySelector<HTMLInputElement>('[data-testid="sync-secret"]')!.click()
    expect(sync.setIncludeSecret).not.toHaveBeenCalled()
    expect(button('Cancel sync').disabled).toBe(false)
    button('Cancel sync').click()
    expect(sync.cancel).toHaveBeenCalledOnce()
    host.querySelector<HTMLInputElement>('[data-testid="enable-google-sync"]')!.click()
    expect(sync.setEnabled).toHaveBeenCalledWith(false)
  })

  it('requires the exact workspace name before moving it to trash', async () => {
    connectWorkspace()
    await mount()
    const confirmation = host.querySelector<HTMLInputElement>('[data-testid="delete-workspace-name"]')!
    expect(button('Move workspace to trash').disabled).toBe(true)
    confirmation.value = 'Boat'
    confirmation.dispatchEvent(new Event('input'))
    await nextTick()
    expect(button('Move workspace to trash').disabled).toBe(true)
    confirmation.value = 'Boat history'
    confirmation.dispatchEvent(new Event('input'))
    await nextTick()
    button('Move workspace to trash').click()
    expect(sync.trashWorkspace).toHaveBeenCalledWith('Boat history')
    expect(host.textContent).toContain('any files added manually')
    expect(host.textContent).toContain('Local recordings and imported copies remain in this browser')
  })

  it('clears deletion confirmation when the selected workspace changes', async () => {
    connectWorkspace()
    await mount()
    const confirmation = host.querySelector<HTMLInputElement>('[data-testid="delete-workspace-name"]')!
    confirmation.value = 'Boat history'
    confirmation.dispatchEvent(new Event('input'))
    await nextTick()
    sync.workspace.value = { id: 'different', name: 'Boat history', folderId: 'different-folder' }
    await nextTick()
    expect(confirmation.value).toBe('')
    expect(button('Move workspace to trash').disabled).toBe(true)
  })
})
