import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGoogleSyncController } from '../src/application/sync/googleSyncController'
import type { GoogleSyncDependencies } from '../src/application/sync/GoogleSyncDependencies'
import type { GoogleSyncState } from '../src/application/sync/GoogleSyncState'
import type { SyncRemote } from '../src/application/sync/SyncRemote'
import { compactCloudArchive } from '../src/application/sync/compactCloudArchive'
import { publishArchive } from '../src/application/sync/archiveSync'
import type { ArchiveSnapshot } from '../src/domain/backup/ArchiveSnapshot'
import type { ArchivePreference } from '../src/domain/backup/ArchivePreference'
import type { ImportedArchive } from '../src/application/backup/ImportedArchive'
import type { CloudArchiveRevision } from '../src/domain/sync/CloudArchiveRevision'
import type { CloudCatalog } from '../src/domain/sync/CloudCatalog'
import type { CloudSnapshotRevision } from '../src/domain/sync/CloudSnapshotRevision'
import type { CloudSettingsRevision } from '../src/domain/sync/CloudSettingsRevision'
import type { CloudWorkspace } from '../src/domain/sync/CloudWorkspace'
import { settingsHeads } from '../src/domain/sync/sharedSettings'
import { summarizeSessionHours } from '../src/domain/history/summarizeSessionHours'
import { deviceRecord, packChunk, packSamples, SAMPLE_EPOCH, sessionRecord } from './support/samples'

const workspace: CloudWorkspace = { id: 'sheet', name: 'Boat', folderId: 'folder', version: 2 }
const controllers: ReturnType<typeof createGoogleSyncController>[] = []

function snapshot(sourceId = 'browser', exportedAt = SAMPLE_EPOCH): ArchiveSnapshot {
  return {
    format: 'shunt-archive', version: 2, exportedAt, source: { id: sourceId, label: sourceId },
    stores: {
      sessions: [sessionRecord({ packSamples: 2, packChunks: 1, sealedSamples: 2, state: 'closed', endedAt: SAMPLE_EPOCH + 1000, endReason: 'user-disconnect' })],
      chunks: [packChunk(packSamples(2))], hours: summarizeSessionHours('session-0001', packSamples(2), []), devices: [deviceRecord()],
      meta: [{ key: 'totals', schema: 1, totalSamples: 2, createdAt: SAMPLE_EPOCH, lastPrunedAt: null }],
      warnings: [], ringRecords: [], ringReads: [],
    }, preferences: [{ key: 'shunt.theme', value: 'dark' }],
  }
}

function theme(value: string): ArchivePreference[] {
  return [{ key: 'shunt.theme', value }]
}

function deferred<TResult>() {
  let resolve!: (result: TResult) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<TResult>((fulfill, fail) => { resolve = fulfill; reject = fail })
  return { promise, resolve, reject }
}

function setup(initial: Partial<GoogleSyncState> = {}) {
  const archives: CloudArchiveRevision[] = []
  const settings: CloudSettingsRevision[] = []
  const pending: CloudSnapshotRevision[] = []
  const files = new Map<string, Uint8Array>()
  const imports = new Map<string, ArchiveSnapshot>()
  let fileCount = 0
  let preferences: readonly ArchivePreference[] = theme('dark')
  let recordingEndListener: (() => void) | null = null
  let accessListener: ((connected: boolean) => void) | null = null
  const remote = {
    readCatalog: vi.fn(async (_workspace: CloudWorkspace, _signal: AbortSignal): Promise<CloudCatalog> => ({ archives: [...archives], settings: [...settings] })),
    listPendingSnapshots: vi.fn(async (_workspace: CloudWorkspace, sourceId: string) => {
      return pending.filter((revision) => revision.source.id === sourceId)
    }),
    uploadSnapshot: vi.fn(async (_workspace: CloudWorkspace, bytes: Uint8Array, description: Omit<CloudSnapshotRevision, 'snapshotFileId' | 'createdAt'>, signal: AbortSignal) => {
      signal.throwIfAborted()
      const revision = { ...description, snapshotFileId: `file-${fileCount}`, createdAt: SAMPLE_EPOCH + fileCount++ }
      files.set(revision.snapshotFileId, bytes.slice())
      pending.push(revision)
      return revision
    }),
    downloadBlock: vi.fn(async (fileId: string, maximum: number, signal: AbortSignal) => {
      signal.throwIfAborted()
      const bytes = files.get(fileId)
      if (!bytes) throw new Error('Missing archive file')
      if (bytes.byteLength > maximum) throw new Error('Archive too large')
      return bytes
    }),
    completeSnapshot: vi.fn(async (_workspace: CloudWorkspace, revision: CloudSnapshotRevision, signal: AbortSignal) => {
      signal.throwIfAborted()
      archives.push(revision)
      const index = pending.findIndex((copy) => copy.id === revision.id)
      if (index !== -1) pending.splice(index, 1)
    }),
    deleteSnapshot: vi.fn(async (_workspace: CloudWorkspace, revision: CloudSnapshotRevision, _sourceId: string, signal: AbortSignal) => {
      signal.throwIfAborted()
      const index = archives.findIndex((copy) => copy.id === revision.id)
      if (index !== -1) archives.splice(index, 1)
      files.delete(revision.snapshotFileId)
    }),
    appendSettings: vi.fn(async (_workspace: CloudWorkspace, revision: CloudSettingsRevision, signal: AbortSignal) => {
      signal.throwIfAborted()
      settings.push(revision)
    }),
  } satisfies SyncRemote
  const unsubscribe = vi.fn(() => { accessListener = null })
  const unsubscribeRecording = vi.fn(() => { recordingEndListener = null })
  const dependencies = {
    remote,
    configured: vi.fn(() => true),
    load: vi.fn((): GoogleSyncState => ({ enabled: true, autoSync: false, includeSecret: false, sourceLabel: '', workspace,
      lastSyncAt: null, settingsBaseline: null, downloaded: {}, ...initial })),
    save: vi.fn((_state: GoogleSyncState) => undefined),
    prepare: vi.fn(async (): Promise<void> => undefined),
    authorize: vi.fn(async () => { accessListener?.(true) }),
    forgetAccess: vi.fn(() => { accessListener?.(false) }),
    subscribeAccess: vi.fn((listener: (connected: boolean) => void) => { accessListener = listener; return unsubscribe }),
    listWorkspaces: vi.fn(async (_signal: AbortSignal): Promise<readonly CloudWorkspace[]> => [workspace]),
    createWorkspace: vi.fn(async (name: string, _signal: AbortSignal) => ({ ...workspace, name })),
    chooseWorkspace: vi.fn(async (_signal: AbortSignal): Promise<CloudWorkspace | null> => workspace),
    trashWorkspace: vi.fn(async (_workspace: CloudWorkspace, _signal: AbortSignal) => undefined),
    capture: vi.fn(async (includeSecret: boolean): Promise<ArchiveSnapshot> => ({ ...snapshot(), preferences: preferences.filter((preference) => includeSecret || preference.key !== 'victron.advertisementKey') })),
    sourceId: vi.fn((): string | null => 'browser'),
    importArchive: vi.fn(async (archive: ArchiveSnapshot, _select: boolean) => { imports.set(archive.source.id, archive) }),
    imported: vi.fn((): readonly ImportedArchive[] => [...imports.values()].map((archive) => ({ source: archive.source, exportedAt: archive.exportedAt, importedAt: SAMPLE_EPOCH, preferences: archive.preferences }))),
    preferences: vi.fn((includeSecret: boolean) => preferences.filter((preference) => includeSecret || preference.key !== 'victron.advertisementKey')),
    applyPreferences: vi.fn((incoming: readonly ArchivePreference[], includeSecret: boolean) => {
      const retained = preferences.filter((preference) => !['shunt.theme', 'shunt.sidebar', 'shunt.statsPreferences'].includes(preference.key)
        && (!includeSecret || !incoming.some((candidate) => candidate.key === 'victron.advertisementKey') || preference.key !== 'victron.advertisementKey'))
      preferences = [...retained, ...incoming]
    }),
    radiosBusy: vi.fn(() => false),
    recording: vi.fn(() => false),
    subscribeRecordingEnd: vi.fn((listener: () => void) => { recordingEndListener = listener; return unsubscribeRecording }),
    now: vi.fn(() => SAMPLE_EPOCH + 5000),
  } satisfies GoogleSyncDependencies
  const controller = createGoogleSyncController(dependencies)
  controllers.push(controller)
  async function connect() {
    controller.start()
    await vi.waitFor(() => expect(controller.prepared.value).toBe(true))
    await controller.connect()
    expect(controller.connected.value).toBe(true)
  }
  async function seed(archive: ArchiveSnapshot) {
    return publishArchive(archive, workspace, remote, new AbortController().signal)
  }
  function cloudSettings(id: string, changed: readonly ArchivePreference[], parents: readonly string[] = []) {
    const revision = { id, sourceId: 'phone', parents, createdAt: SAMPLE_EPOCH + settings.length, preferences: changed }
    settings.push(revision)
    return revision
  }
  return { controller, dependencies, remote, archives, settings, imports, files, connect, seed, cloudSettings, unsubscribe, unsubscribeRecording,
    endRecording() { dependencies.recording.mockReturnValue(false); recordingEndListener?.() },
    setPreferences(next: readonly ArchivePreference[]) { preferences = next }, readPreferences: () => preferences }
}

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('document', { visibilityState: 'visible' })
})

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Google sync controller history', () => {
  it('reports failed retirement without losing the successful upload and retries cleanup later', async () => {
    const harness = setup()
    for (let index = 0; index < 4; index++) {
      await harness.seed({ ...snapshot(), source: { id: 'browser', label: `Boat ${index}` } })
    }
    await harness.connect()
    harness.remote.deleteSnapshot.mockRejectedValueOnce(new Error('Google could not be reached.'))
    await harness.controller.syncNow()
    expect(harness.controller.lastSyncAt.value).toBe(SAMPLE_EPOCH + 5000)
    expect(harness.controller.failure.value).toContain('History was uploaded, but old cloud copies could not be removed')
    expect(harness.settings).toHaveLength(1)
    expect(harness.archives).toHaveLength(5)
    harness.remote.uploadSnapshot.mockClear()
    await harness.controller.syncNow()
    expect(harness.controller.failure.value).toBeNull()
    expect(harness.archives).toHaveLength(3)
    expect(harness.remote.uploadSnapshot).not.toHaveBeenCalled()
  })

  it('shows a skipped-file warning while listing valid saved copies', async () => {
    const harness = setup()
    await harness.seed(snapshot('phone'))
    await harness.connect()
    harness.remote.readCatalog.mockResolvedValueOnce({ archives: harness.archives, settings: [], unreadableArchives: 2 })
    await harness.controller.selectWorkspace(workspace.id)
    expect(harness.controller.revisions.value).toHaveLength(1)
    expect(harness.controller.failure.value).toContain('2 cloud archive files could not be read and were left untouched')
  })

  it('keeps legacy workspaces readable without capturing or uploading new history', async () => {
    const harness = setup({ workspace: { ...workspace, version: 1 } })
    harness.dependencies.listWorkspaces.mockResolvedValue([{ ...workspace, version: 1 }])
    const revision = await harness.seed(snapshot('phone'))
    await harness.connect()
    harness.remote.uploadSnapshot.mockClear()
    await harness.controller.selectWorkspace(workspace.id)
    expect(harness.controller.revisions.value).toHaveLength(1)
    await harness.controller.syncNow()
    expect(harness.controller.failure.value).toContain('legacy workspace is read-only')
    expect(harness.dependencies.capture).not.toHaveBeenCalled()
    expect(harness.remote.uploadSnapshot).not.toHaveBeenCalled()
    await harness.controller.openRevision(revision.id)
    expect(harness.imports.has('phone')).toBe(true)
  })

  it('publishes the first snapshot and shared settings, then skips unchanged revisions', async () => {
    const harness = setup()
    await harness.connect()
    await harness.controller.syncNow()
    expect(harness.controller.failure.value).toBeNull()
    expect(harness.archives).toHaveLength(1)
    expect(harness.settings).toHaveLength(1)
    expect(harness.controller.lastSyncAt.value).toBe(SAMPLE_EPOCH + 5000)
    harness.remote.uploadSnapshot.mockClear()
    await harness.controller.syncNow()
    expect(harness.archives).toHaveLength(1)
    expect(harness.settings).toHaveLength(1)
    expect(harness.remote.uploadSnapshot).not.toHaveBeenCalled()
    expect(harness.dependencies.importArchive).not.toHaveBeenCalled()
  })

  it('reports a network failure without claiming a successful sync or changing local settings', async () => {
    const harness = setup()
    await harness.connect()
    harness.remote.readCatalog.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await harness.controller.syncNow()
    expect(harness.controller.failure.value).toBe('Failed to fetch')
    expect(harness.controller.lastSyncAt.value).toBeNull()
    expect(harness.controller.busy.value).toBe(false)
    expect(harness.archives).toHaveLength(0)
    expect(harness.dependencies.applyPreferences).not.toHaveBeenCalled()
  })

  it('imports only the newest foreign source revision and skips already imported revisions', async () => {
    const harness = setup()
    await harness.seed(snapshot('phone'))
    const newer = { ...snapshot('phone', SAMPLE_EPOCH + 1000), preferences: theme('light') }
    await harness.seed(newer)
    await harness.seed(snapshot('browser'))
    await harness.connect()
    await harness.controller.syncNow()
    expect(harness.dependencies.importArchive).toHaveBeenCalledExactlyOnceWith(compactCloudArchive(newer), false)
    harness.dependencies.importArchive.mockClear()
    await harness.controller.syncNow()
    expect(harness.dependencies.importArchive).not.toHaveBeenCalled()
  })

  it('imports the last catalogue row of a source even when its device clock moved backwards', async () => {
    const harness = setup()
    await harness.seed({ ...snapshot('phone', SAMPLE_EPOCH + 3_600_000), preferences: theme('light') })
    const corrected = snapshot('phone')
    await harness.seed(corrected)
    await harness.connect()
    await harness.controller.syncNow()
    expect(harness.dependencies.importArchive).toHaveBeenCalledExactlyOnceWith(compactCloudArchive(corrected), false)
  })

  it('imports the other sources and syncs settings when one source cannot be downloaded', async () => {
    const harness = setup()
    await harness.seed(snapshot('phone'))
    await harness.seed(snapshot('tablet'))
    await harness.connect()
    harness.dependencies.importArchive.mockImplementationOnce(async () => { throw new Error('Quota exceeded') })
    await harness.controller.syncNow()
    expect(harness.imports.has('phone')).toBe(false)
    expect(harness.imports.has('tablet')).toBe(true)
    expect(harness.settings).toHaveLength(1)
    expect(harness.controller.lastSyncAt.value).toBe(SAMPLE_EPOCH + 5000)
    expect(harness.controller.failure.value).toBe('History from phone could not be downloaded. The next sync tries again.')
    await harness.controller.syncNow()
    expect(harness.imports.has('phone')).toBe(true)
    expect(harness.controller.failure.value).toBeNull()
  })

  it('opens an earlier revision explicitly and restores the newest one on the next sync', async () => {
    const harness = setup()
    const earlier = await harness.seed(snapshot('phone'))
    const newer = { ...snapshot('phone', SAMPLE_EPOCH + 1000), preferences: theme('light') }
    await harness.seed(newer)
    await harness.connect()
    await harness.controller.syncNow()
    harness.dependencies.importArchive.mockClear()
    harness.controller.setAutoSync(true)
    await harness.controller.openRevision(earlier.id)
    expect(harness.controller.autoSync.value).toBe(false)
    expect(harness.controller.notice.value).toContain('paused')
    expect(harness.dependencies.importArchive).toHaveBeenLastCalledWith(compactCloudArchive(snapshot('phone')), true)
    await harness.controller.syncNow()
    expect(harness.dependencies.importArchive).toHaveBeenLastCalledWith(compactCloudArchive(newer), false)
  })

  it('does not import a remote snapshot if cancelled while its download is pending', async () => {
    const harness = setup()
    await harness.seed(snapshot('phone'))
    await harness.connect()
    const blocked = deferred<Uint8Array>()
    const reached = deferred<void>()
    harness.remote.downloadBlock.mockImplementationOnce(async () => { reached.resolve(); return blocked.promise })
    const syncing = harness.controller.syncNow()
    await reached.promise
    harness.controller.cancel()
    blocked.resolve(new Uint8Array([1]))
    await syncing
    expect(harness.dependencies.importArchive).not.toHaveBeenCalled()
    expect(harness.controller.lastSyncAt.value).toBeNull()
    expect(harness.controller.failure.value).toContain('cancelled')
  })
})

describe('Google sync controller settings', () => {
  it('asks before applying a different first cloud version and resolves the selected version', async () => {
    const harness = setup()
    const cloud = harness.cloudSettings('phone-settings', theme('light'))
    await harness.connect()
    await harness.controller.syncNow()
    expect(harness.controller.conflicts.value).toEqual([cloud])
    expect(harness.dependencies.applyPreferences).not.toHaveBeenCalled()
    await harness.controller.resolveSettings(cloud.id)
    expect(harness.readPreferences()).toEqual(theme('light'))
    expect(harness.settings.at(-1)?.parents).toEqual([cloud.id])
    expect(harness.controller.conflicts.value).toEqual([])
  })

  it('publishes a local edit after an unchanged baseline and automatically applies a later cloud edit', async () => {
    const harness = setup()
    await harness.connect()
    await harness.controller.syncNow()
    const first = harness.settings[0]!
    harness.setPreferences(theme('light'))
    await harness.controller.syncNow()
    expect(harness.settings.at(-1)?.preferences).toEqual(theme('light'))
    expect(harness.settings.at(-1)?.parents).toEqual([first.id])
    harness.cloudSettings('new-cloud', theme('dark'), [harness.settings.at(-1)!.id])
    await harness.controller.syncNow()
    expect(harness.readPreferences()).toEqual(theme('dark'))
    expect(harness.controller.conflicts.value).toEqual([])
  })

  it('keeps concurrent cloud branches until a choice names every observed head', async () => {
    const harness = setup()
    await harness.connect()
    await harness.controller.syncNow()
    const initial = harness.settings[0]!.id
    const phone = harness.cloudSettings('phone', theme('light'), [initial])
    const tablet = harness.cloudSettings('tablet', [{ key: 'shunt.sidebar', value: 'collapsed' }], [initial])
    await harness.controller.syncNow()
    expect(harness.controller.conflicts.value).toEqual([phone, tablet])
    await harness.controller.resolveSettings('local')
    expect(harness.settings.at(-1)?.parents).toEqual(['phone', 'tablet'])
    expect(settingsHeads(harness.settings)).toEqual([harness.settings.at(-1)])
    expect(harness.dependencies.applyPreferences).not.toHaveBeenCalled()
  })

  it('does not overwrite changed cloud heads while resolving an older conflict', async () => {
    const harness = setup()
    harness.cloudSettings('old-cloud', theme('light'))
    await harness.connect()
    await harness.controller.syncNow()
    const latest = harness.cloudSettings('new-cloud', [{ key: 'shunt.sidebar', value: 'collapsed' }], ['old-cloud'])
    await harness.controller.resolveSettings('local')
    expect(harness.controller.conflicts.value).toEqual([latest])
    expect(harness.settings).toHaveLength(2)
    expect(harness.dependencies.applyPreferences).not.toHaveBeenCalled()
  })

  it('treats a manually edited cloud row and dirty local preferences as a conflict even when the revision ID is unchanged', async () => {
    const harness = setup()
    await harness.connect()
    await harness.controller.syncNow()
    harness.setPreferences(theme('light'))
    const edited: CloudSettingsRevision = { ...harness.settings[0]!, preferences: [{ key: 'shunt.sidebar', value: 'collapsed' }] }
    harness.settings[0] = edited
    await harness.controller.syncNow()
    expect(harness.controller.conflicts.value).toEqual([edited])
    expect(harness.controller.conflictReason.value).toContain('here and in the cloud')
    expect(harness.dependencies.applyPreferences).not.toHaveBeenCalled()
    expect(harness.settings).toHaveLength(1)
  })

  it('rejects a conflict choice when somebody edits that cloud row without changing its revision ID', async () => {
    const harness = setup()
    harness.cloudSettings('cloud-row', theme('light'))
    await harness.connect()
    await harness.controller.syncNow()
    const edited: CloudSettingsRevision = { ...harness.settings[0]!, preferences: [{ key: 'shunt.sidebar', value: 'collapsed' }] }
    harness.settings[0] = edited
    await harness.controller.resolveSettings('local')
    expect(harness.controller.conflicts.value).toEqual([edited])
    expect(harness.controller.conflictReason.value).toContain('changed again')
    expect(harness.dependencies.applyPreferences).not.toHaveBeenCalled()
    expect(harness.settings).toHaveLength(1)
  })

  it('does not apply cloud preferences while the radios are connected', async () => {
    const harness = setup()
    await harness.connect()
    await harness.controller.syncNow()
    harness.cloudSettings('cloud-edit', theme('light'), [harness.settings[0]!.id])
    harness.dependencies.radiosBusy.mockReturnValue(true)
    await harness.controller.syncNow()
    expect(harness.dependencies.applyPreferences).not.toHaveBeenCalled()
    expect(harness.controller.conflictReason.value).toContain('Disconnect the radios')
    await harness.controller.resolveSettings('cloud-edit')
    expect(harness.controller.failure.value).toContain('Disconnect the radios')
    expect(harness.settings).toHaveLength(2)
  })

  it('preserves an existing cloud key while opted out and leaves the local key unchanged', async () => {
    const harness = setup()
    const cloudKey: ArchivePreference = { key: 'victron.advertisementKey', value: 'a'.repeat(32) }
    const localKey: ArchivePreference = { key: 'victron.advertisementKey', value: 'b'.repeat(32) }
    harness.setPreferences([...theme('dark'), localKey])
    harness.cloudSettings('cloud-key', [...theme('dark'), cloudKey])
    await harness.connect()
    await harness.controller.syncNow()
    harness.setPreferences([...theme('light'), localKey])
    await harness.controller.syncNow()
    expect(harness.settings.at(-1)?.preferences).toEqual([...theme('light'), cloudKey])
    expect(harness.readPreferences()).toEqual([...theme('light'), localKey])
    expect(harness.dependencies.capture).toHaveBeenCalledWith(false, 'hourly')
    expect(harness.dependencies.applyPreferences).not.toHaveBeenCalled()
  })

  it.each([false, true])('keeps unchanged missing-key settings idle after applying them with radios busy: %s', async (radiosBusy) => {
    const harness = setup({ includeSecret: true })
    const key: ArchivePreference = { key: 'victron.advertisementKey', value: 'b'.repeat(32) }
    harness.setPreferences([...theme('dark'), key])
    await harness.connect()
    await harness.controller.syncNow()
    harness.cloudSettings('without-key', theme('light'), [harness.settings[0]!.id])
    await harness.controller.syncNow()
    expect(harness.readPreferences()).toEqual(expect.arrayContaining([...theme('light'), key]))
    harness.dependencies.applyPreferences.mockClear()
    harness.dependencies.radiosBusy.mockReturnValue(radiosBusy)
    await harness.controller.syncNow()
    expect(harness.dependencies.applyPreferences).not.toHaveBeenCalled()
    expect(harness.controller.conflicts.value).toEqual([])
    expect(harness.settings).toHaveLength(2)
    expect(harness.readPreferences()).toEqual(expect.arrayContaining([...theme('light'), key]))
  })

  it('reports a conflict when local and cloud settings both changed since the baseline', async () => {
    const harness = setup()
    await harness.connect()
    await harness.controller.syncNow()
    harness.setPreferences(theme('light'))
    const cloud = harness.cloudSettings('cloud-edit', [{ key: 'shunt.sidebar', value: 'collapsed' }], [harness.settings[0]!.id])
    await harness.controller.syncNow()
    expect(harness.controller.conflicts.value).toEqual([cloud])
    expect(harness.controller.conflictReason.value).toContain('here and in the cloud')
    expect(harness.dependencies.applyPreferences).not.toHaveBeenCalled()
    expect(harness.settings).toHaveLength(2)
  })

  it('publishes a local edit when another device appended identical cloud settings', async () => {
    const harness = setup()
    await harness.connect()
    await harness.controller.syncNow()
    const repeated = harness.cloudSettings('repeated', theme('dark'), [harness.settings[0]!.id])
    harness.setPreferences(theme('light'))
    await harness.controller.syncNow()
    expect(harness.controller.conflicts.value).toEqual([])
    expect(harness.settings.at(-1)?.preferences).toEqual(theme('light'))
    expect(harness.settings.at(-1)?.parents).toEqual([repeated.id])
  })

  it('merges several heads automatically when they all match this browser', async () => {
    const harness = setup()
    const first = harness.cloudSettings('first', theme('dark'))
    const second = harness.cloudSettings('second', theme('dark'))
    await harness.connect()
    await harness.controller.syncNow()
    expect(harness.controller.conflicts.value).toEqual([])
    expect(harness.settings.at(-1)?.parents).toEqual([first.id, second.id])
    expect(settingsHeads(harness.settings)).toEqual([harness.settings.at(-1)])
    expect(harness.dependencies.applyPreferences).not.toHaveBeenCalled()
  })

  it.each([false, true])('keeps the cloud key when merging matching heads with key first: %s', async (keyFirst) => {
    const harness = setup()
    const cloudKey: ArchivePreference = { key: 'victron.advertisementKey', value: 'a'.repeat(32) }
    harness.cloudSettings('first', keyFirst ? [...theme('dark'), cloudKey] : theme('dark'))
    harness.cloudSettings('second', keyFirst ? theme('dark') : [...theme('dark'), cloudKey])
    await harness.connect()
    await harness.controller.syncNow()
    expect(harness.settings.at(-1)?.parents).toEqual(['first', 'second'])
    expect(harness.settings.at(-1)?.preferences).toEqual([...theme('dark'), cloudKey])
  })

  it('keeps different cloud keys in conflict while opted out and refuses a local choice', async () => {
    const harness = setup()
    const firstKey: ArchivePreference = { key: 'victron.advertisementKey', value: 'a'.repeat(32) }
    const secondKey: ArchivePreference = { key: 'victron.advertisementKey', value: 'b'.repeat(32) }
    const first = harness.cloudSettings('first', [...theme('dark'), firstKey])
    const second = harness.cloudSettings('second', [...theme('dark'), secondKey])
    await harness.connect()
    await harness.controller.syncNow()
    expect(harness.controller.conflicts.value).toEqual([first, second])
    expect(harness.settings).toHaveLength(2)
    await harness.controller.resolveSettings('local')
    expect(harness.controller.failure.value).toContain('Choose a cloud version with the key to keep, or opt in')
    expect(harness.controller.conflicts.value).toEqual([first, second])
    expect(harness.settings).toHaveLength(2)
    await harness.controller.resolveSettings(first.id)
    expect(harness.settings.at(-1)?.preferences).toEqual([...theme('dark'), firstKey])
    expect(harness.settings.at(-1)?.parents).toEqual([first.id, second.id])
    expect(harness.controller.conflicts.value).toEqual([])
    expect(harness.readPreferences()).toEqual(theme('dark'))
  })

  it.each(['local', 'without-key'])('preserves the sole cloud key when resolving %s while opted out', async (choice) => {
    const harness = setup()
    const cloudKey: ArchivePreference = { key: 'victron.advertisementKey', value: 'a'.repeat(32) }
    harness.cloudSettings('with-key', [...theme('light'), cloudKey])
    harness.cloudSettings('without-key', theme('dark'))
    await harness.connect()
    await harness.controller.syncNow()
    await harness.controller.resolveSettings(choice)
    expect(harness.settings.at(-1)?.preferences).toEqual([...theme('dark'), cloudKey])
    expect(harness.settings.at(-1)?.parents).toEqual(['with-key', 'without-key'])
    expect(harness.readPreferences()).toEqual(theme('dark'))
  })

  it('applies the sole existing cloud key when an opted-in browser chooses a head without one', async () => {
    const harness = setup({ includeSecret: true })
    const cloudKey: ArchivePreference = { key: 'victron.advertisementKey', value: 'a'.repeat(32) }
    const localKey: ArchivePreference = { key: 'victron.advertisementKey', value: 'b'.repeat(32) }
    harness.setPreferences([...theme('dark'), localKey])
    harness.cloudSettings('with-key', [...theme('light'), cloudKey])
    harness.cloudSettings('without-key', theme('dark'))
    await harness.connect()
    await harness.controller.syncNow()
    await harness.controller.resolveSettings('without-key')
    expect(harness.settings.at(-1)?.preferences).toEqual([...theme('dark'), cloudKey])
    expect(harness.readPreferences()).toEqual([...theme('dark'), cloudKey])
    expect(harness.controller.conflicts.value).toEqual([])
  })

  it('lets an opted-in local choice replace different cloud keys', async () => {
    const harness = setup({ includeSecret: true })
    const localKey: ArchivePreference = { key: 'victron.advertisementKey', value: 'c'.repeat(32) }
    harness.setPreferences([...theme('dark'), localKey])
    harness.cloudSettings('first', [...theme('dark'), { key: 'victron.advertisementKey', value: 'a'.repeat(32) }])
    harness.cloudSettings('second', [...theme('dark'), { key: 'victron.advertisementKey', value: 'b'.repeat(32) }])
    await harness.connect()
    await harness.controller.syncNow()
    await harness.controller.resolveSettings('local')
    expect(harness.settings.at(-1)?.preferences).toEqual([...theme('dark'), localKey])
    expect(harness.controller.conflicts.value).toEqual([])
  })

  it('publishes local settings over an empty cloud head without asking', async () => {
    const harness = setup()
    const empty = harness.cloudSettings('empty', [])
    await harness.connect()
    await harness.controller.syncNow()
    expect(harness.controller.conflicts.value).toEqual([])
    expect(harness.settings.at(-1)?.preferences).toEqual(theme('dark'))
    expect(harness.settings.at(-1)?.parents).toEqual([empty.id])
  })

  it('does not publish an empty first settings revision', async () => {
    const harness = setup()
    harness.setPreferences([])
    await harness.connect()
    await harness.controller.syncNow()
    expect(harness.settings).toHaveLength(0)
    expect(harness.controller.failure.value).toBeNull()
  })

  it('publishes the opted-in local key with a chosen cloud version that has none', async () => {
    const harness = setup({ includeSecret: true })
    const key: ArchivePreference = { key: 'victron.advertisementKey', value: 'b'.repeat(32) }
    harness.setPreferences([...theme('dark'), key])
    const cloud = harness.cloudSettings('cloud', theme('light'))
    await harness.connect()
    await harness.controller.syncNow()
    expect(harness.controller.conflicts.value).toEqual([cloud])
    await harness.controller.resolveSettings(cloud.id)
    expect(harness.settings.at(-1)?.preferences).toEqual([...theme('light'), key])
    const published = harness.settings.length
    harness.dependencies.radiosBusy.mockReturnValue(true)
    await harness.controller.syncNow()
    expect(harness.controller.conflicts.value).toEqual([])
    expect(harness.controller.conflictReason.value).toBeNull()
    expect(harness.settings).toHaveLength(published)
  })

  it('resolves a conflict without reading the whole archive', async () => {
    const harness = setup()
    const cloud = harness.cloudSettings('cloud', theme('light'))
    await harness.connect()
    await harness.controller.syncNow()
    harness.dependencies.capture.mockClear()
    await harness.controller.resolveSettings(cloud.id)
    expect(harness.dependencies.capture).not.toHaveBeenCalled()
    expect(harness.settings.at(-1)?.sourceId).toBe('browser')
  })

  it('publishes a saved key only after explicit opt-in', async () => {
    const harness = setup()
    const key: ArchivePreference = { key: 'victron.advertisementKey', value: 'c'.repeat(32) }
    harness.setPreferences([...theme('dark'), key])
    await harness.connect()
    harness.controller.setIncludeSecret(true)
    await harness.controller.syncNow()
    expect(harness.settings[0]?.preferences).toEqual([...theme('dark'), key])
    expect(harness.dependencies.capture).toHaveBeenCalledWith(true, 'hourly')
  })
})

describe('Google sync controller recording cadence', () => {
  async function recordingAfterFirstSync() {
    vi.useFakeTimers()
    const harness = setup({ autoSync: true })
    await harness.connect()
    await harness.controller.syncNow()
    harness.dependencies.recording.mockReturnValue(true)
    harness.dependencies.capture.mockClear()
    harness.setPreferences(theme('light'))
    return harness
  }

  async function tick(harness: ReturnType<typeof setup>) {
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(harness.controller.busy.value).toBe(false))
  }

  it('downloads and syncs settings on a tick within the hour without capturing this browser', async () => {
    const harness = await recordingAfterFirstSync()
    await harness.seed(snapshot('phone'))
    const published = harness.archives.length
    await tick(harness)
    expect(harness.dependencies.capture).not.toHaveBeenCalled()
    expect(harness.archives).toHaveLength(published)
    expect(harness.imports.has('phone')).toBe(true)
    expect(harness.settings.at(-1)?.preferences).toEqual(theme('light'))
    expect(harness.controller.notice.value).toBe('Settings and other devices synced. This browser’s recording uploads hourly while it records.')
  })

  it('publishes on the first tick an hour after the last upload', async () => {
    const harness = await recordingAfterFirstSync()
    harness.dependencies.now.mockReturnValue(SAMPLE_EPOCH + 5000 + 60 * 60_000)
    await tick(harness)
    expect(harness.dependencies.capture).toHaveBeenCalledOnce()
    expect(harness.archives).toHaveLength(2)
    expect(harness.controller.notice.value).toBe('History and shared settings synced.')
  })

  it('publishes immediately when recording ends without waiting for the minute tick', async () => {
    const harness = await recordingAfterFirstSync()
    harness.endRecording()
    await vi.waitFor(() => expect(harness.dependencies.capture).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(harness.controller.busy.value).toBe(false))
    expect(harness.archives).toHaveLength(2)
  })

  it('uploads once after a busy operation finishes even if another recording already started', async () => {
    const harness = await recordingAfterFirstSync()
    const captured = deferred<ArchiveSnapshot>()
    harness.dependencies.capture.mockReturnValueOnce(captured.promise)
    const syncing = harness.controller.syncNow()
    harness.endRecording()
    harness.endRecording()
    harness.dependencies.recording.mockReturnValue(true)
    expect(harness.dependencies.capture).toHaveBeenCalledOnce()
    captured.resolve(snapshot())
    await syncing
    await vi.waitFor(() => expect(harness.controller.busy.value).toBe(false))
    expect(harness.dependencies.capture).toHaveBeenCalledTimes(2)
  })

  it.each(['cancel', 'disconnect', 'disable', 'dispose', 'disable-auto'] as const)('drops a queued recording upload after %s', async (action) => {
    const harness = await recordingAfterFirstSync()
    const captured = deferred<ArchiveSnapshot>()
    harness.dependencies.capture.mockReturnValueOnce(captured.promise)
    const syncing = harness.controller.syncNow()
    harness.endRecording()
    if (action === 'disable') harness.controller.setEnabled(false)
    else if (action === 'disable-auto') harness.controller.setAutoSync(false)
    else harness.controller[action]()
    captured.resolve(snapshot())
    await syncing
    expect(harness.controller.busy.value).toBe(false)
    expect(harness.dependencies.capture).toHaveBeenCalledOnce()
  })

  it('does not retry a failed queued recording upload until a later timer tick', async () => {
    const harness = await recordingAfterFirstSync()
    const captured = deferred<ArchiveSnapshot>()
    harness.dependencies.capture.mockReturnValueOnce(captured.promise)
    harness.dependencies.capture.mockRejectedValueOnce(new Error('Archive unavailable'))
    const syncing = harness.controller.syncNow()
    harness.endRecording()
    captured.resolve(snapshot())
    await syncing
    await vi.waitFor(() => expect(harness.controller.busy.value).toBe(false))
    expect(harness.dependencies.capture).toHaveBeenCalledTimes(2)
    expect(harness.controller.failure.value).toBe('Archive unavailable')
  })

  it.each(['offline', 'hidden', 'disabled', 'disconnected', 'manual'] as const)('skips the recording-end upload while %s', async (condition) => {
    const harness = await recordingAfterFirstSync()
    if (condition === 'offline') vi.stubGlobal('navigator', { onLine: false })
    else if (condition === 'hidden') vi.stubGlobal('document', { visibilityState: 'hidden' })
    else if (condition === 'disabled') harness.controller.setEnabled(false)
    else if (condition === 'disconnected') harness.controller.disconnect()
    else harness.controller.setAutoSync(false)
    harness.endRecording()
    await Promise.resolve()
    expect(harness.dependencies.capture).not.toHaveBeenCalled()
  })

  it('publishes on the first tick after recording stops', async () => {
    const harness = await recordingAfterFirstSync()
    harness.dependencies.recording.mockReturnValue(false)
    await tick(harness)
    expect(harness.dependencies.capture).toHaveBeenCalledOnce()
    expect(harness.archives).toHaveLength(2)
  })

  it('publishes a manual sync during recording', async () => {
    const harness = await recordingAfterFirstSync()
    await harness.controller.syncNow()
    expect(harness.dependencies.capture).toHaveBeenCalledOnce()
    expect(harness.archives).toHaveLength(2)
  })
})

describe('Google sync controller lifecycle', () => {
  it('starts once, prepares without authorization, and requests authorization synchronously from connect', async () => {
    const harness = setup()
    harness.controller.start()
    harness.controller.start()
    await vi.waitFor(() => expect(harness.controller.prepared.value).toBe(true))
    expect(harness.dependencies.subscribeAccess).toHaveBeenCalledOnce()
    expect(harness.dependencies.subscribeRecordingEnd).toHaveBeenCalledOnce()
    expect(harness.dependencies.prepare).toHaveBeenCalledOnce()
    expect(harness.dependencies.authorize).not.toHaveBeenCalled()
    const connecting = harness.controller.connect()
    expect(harness.dependencies.authorize).toHaveBeenCalledOnce()
    await connecting
    harness.controller.dispose()
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
    expect(harness.unsubscribeRecording).toHaveBeenCalledOnce()
    expect(harness.controller.connected.value).toBe(false)
  })

  it('keeps disabled sync inactive and ignores a late preparation result after disposal', async () => {
    const disabled = setup({ enabled: false })
    disabled.controller.start()
    await disabled.controller.connect()
    expect(disabled.dependencies.prepare).not.toHaveBeenCalled()
    expect(disabled.dependencies.authorize).not.toHaveBeenCalled()
    const harness = setup()
    const preparation = deferred<void>()
    harness.dependencies.prepare.mockReturnValue(preparation.promise)
    harness.controller.start()
    harness.controller.dispose()
    preparation.resolve()
    await preparation.promise
    expect(harness.controller.prepared.value).toBe(false)
    expect(harness.controller.preparing.value).toBe(false)
  })

  it.each(['cancel', 'disconnect', 'disable', 'dispose'] as const)('blocks late archive effects after %s', async (action) => {
    const harness = setup()
    await harness.connect()
    const captured = deferred<ArchiveSnapshot>()
    harness.dependencies.capture.mockReturnValueOnce(captured.promise)
    const syncing = harness.controller.syncNow()
    if (action === 'disable') harness.controller.setEnabled(false)
    else harness.controller[action]()
    captured.resolve(snapshot())
    await syncing
    expect(harness.archives).toHaveLength(0)
    expect(harness.settings).toHaveLength(0)
    expect(harness.dependencies.importArchive).not.toHaveBeenCalled()
    expect(harness.controller.lastSyncAt.value).toBeNull()
    expect(harness.controller.failure.value).toContain(action === 'disconnect' || action === 'dispose' ? 'Connect again' : 'cancelled')
  })

  it('runs automatic sync only while enabled, authorized, online and visible', async () => {
    vi.useFakeTimers()
    const harness = setup({ autoSync: true })
    harness.controller.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.dependencies.capture).not.toHaveBeenCalled()
    await harness.controller.connect()
    vi.stubGlobal('navigator', { onLine: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.dependencies.capture).not.toHaveBeenCalled()
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.dependencies.capture).not.toHaveBeenCalled()
    vi.stubGlobal('document', { visibilityState: 'visible' })
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(harness.controller.lastSyncAt.value).toBe(SAMPLE_EPOCH + 5000))
    expect(harness.dependencies.capture).toHaveBeenCalledOnce()
    harness.controller.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.dependencies.capture).toHaveBeenCalledOnce()
  })

  it('does not overlap a second sync with a pending capture', async () => {
    const harness = setup()
    await harness.connect()
    const captured = deferred<ArchiveSnapshot>()
    harness.dependencies.capture.mockReturnValueOnce(captured.promise)
    const first = harness.controller.syncNow()
    await harness.controller.syncNow()
    expect(harness.dependencies.capture).toHaveBeenCalledOnce()
    captured.resolve(snapshot())
    await first
    expect(harness.archives).toHaveLength(1)
  })

  it('cancels a Google sign-in that never answers', async () => {
    const harness = setup()
    harness.controller.start()
    await vi.waitFor(() => expect(harness.controller.prepared.value).toBe(true))
    const signIn = deferred<void>()
    harness.dependencies.authorize.mockReturnValueOnce(signIn.promise)
    harness.dependencies.forgetAccess.mockImplementation(() => signIn.reject(new Error('Google sign-in was cancelled.')))
    const connecting = harness.controller.connect()
    expect(harness.controller.progress.value).toBe('Waiting for Google sign-in…')
    harness.controller.cancel()
    await connecting
    expect(harness.dependencies.forgetAccess).toHaveBeenCalledOnce()
    expect(harness.dependencies.listWorkspaces).not.toHaveBeenCalled()
    expect(harness.controller.busy.value).toBe(false)
    expect(harness.controller.connected.value).toBe(false)
    expect(harness.controller.failure.value).toBe('Google sign-in was cancelled.')
  })

  it('stops listening for cancellation once Google sign-in finished', async () => {
    const harness = setup()
    harness.controller.start()
    await vi.waitFor(() => expect(harness.controller.prepared.value).toBe(true))
    const listing = deferred<readonly CloudWorkspace[]>()
    harness.dependencies.listWorkspaces.mockReturnValueOnce(listing.promise)
    const connecting = harness.controller.connect()
    await vi.waitFor(() => expect(harness.dependencies.listWorkspaces).toHaveBeenCalledOnce())
    harness.controller.cancel()
    listing.resolve([workspace])
    await connecting
    expect(harness.dependencies.forgetAccess).not.toHaveBeenCalled()
    expect(harness.controller.connected.value).toBe(true)
  })

  it('tells a manual sync that another tab holds the sync lock and skips the timer quietly', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async (_name: string, _options: LockOptions, callback: (lock: Lock | null) => Promise<boolean>) => callback(null))
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })
    const harness = setup({ autoSync: true })
    await harness.connect()
    expect(request).not.toHaveBeenCalled()
    await harness.controller.syncNow()
    expect(request).toHaveBeenCalledWith('shunt-google-sync', { ifAvailable: true }, expect.any(Function))
    expect(harness.controller.notice.value).toBe('Another Shunt tab is syncing. Try again when it finishes.')
    expect(harness.dependencies.capture).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(harness.controller.notice.value).toBeNull()
    expect(harness.controller.failure.value).toBeNull()
    request.mockImplementation(async (name, _options, callback) => callback({ name, mode: 'exclusive' }))
    await harness.controller.syncNow()
    expect(harness.archives).toHaveLength(1)
    expect(harness.controller.lastSyncAt.value).toBe(SAMPLE_EPOCH + 5000)
  })

  it('requires the exact workspace name before deleting cloud files', async () => {
    const harness = setup()
    await harness.connect()
    await harness.controller.trashWorkspace('wrong')
    expect(harness.dependencies.trashWorkspace).not.toHaveBeenCalled()
    expect(harness.controller.workspace.value).toEqual(workspace)
    await harness.controller.trashWorkspace(workspace.name)
    expect(harness.dependencies.trashWorkspace).toHaveBeenCalledOnce()
    expect(harness.controller.workspace.value).toBeNull()
    expect(harness.dependencies.importArchive).not.toHaveBeenCalled()
  })

  it('does not refresh the workspace list from a connection cancelled during listing', async () => {
    const harness = setup()
    harness.controller.start()
    await vi.waitFor(() => expect(harness.controller.prepared.value).toBe(true))
    const listing = deferred<readonly CloudWorkspace[]>()
    harness.dependencies.listWorkspaces.mockReturnValueOnce(listing.promise)
    const connecting = harness.controller.connect()
    await vi.waitFor(() => expect(harness.dependencies.listWorkspaces).toHaveBeenCalledOnce())
    harness.controller.disconnect()
    listing.resolve([workspace])
    await connecting
    expect(harness.controller.workspaces.value).toEqual([])
  })

  it('does not replace displayed conflicts after resolution was cancelled during catalogue loading', async () => {
    const harness = setup()
    const initial = harness.cloudSettings('initial', theme('light'))
    await harness.connect()
    await harness.controller.syncNow()
    const loading = deferred<{ archives: CloudArchiveRevision[]; settings: CloudSettingsRevision[] }>()
    harness.remote.readCatalog.mockReturnValueOnce(loading.promise)
    const resolving = harness.controller.resolveSettings('local')
    harness.controller.cancel()
    const newer: CloudSettingsRevision = { ...initial, id: 'newer', parents: ['initial'] }
    loading.resolve({ archives: harness.archives, settings: [initial, newer] })
    await resolving
    expect(harness.controller.conflicts.value).toEqual([initial])
    expect(harness.dependencies.applyPreferences).not.toHaveBeenCalled()
    expect(harness.settings).toHaveLength(1)
  })
})
