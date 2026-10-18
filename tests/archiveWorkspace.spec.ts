// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createArchiveWorkspace } from '../src/application/backup/archiveWorkspace'
import type { ArchiveRepository } from '../src/application/backup/ArchiveRepository'
import type { ImportedArchive } from '../src/application/backup/ImportedArchive'
import type { ArchiveWorkspaceDependencies } from '../src/application/backup/ArchiveWorkspaceDependencies'
import type { HistoryStore } from '../src/application/history/port'
import type { ArchiveSnapshot } from '../src/domain/backup/ArchiveSnapshot'
import type { ArchivePreference } from '../src/domain/backup/ArchivePreference'
import { validateArchiveSnapshot } from '../src/domain/backup/archiveCodec'
import { SECRET_PREFERENCE_KEY } from '../src/domain/backup/archivePreferences'
import { restoredPreferencesRevision } from '../src/application/backup/preferences'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { deviceRecord, packChunk, packSamples, SAMPLE_EPOCH, sessionRecord } from './support/samples'

function snapshot(id = 'foreign-source'): ArchiveSnapshot {
  const archived: ArchiveSnapshot = {
    format: 'shunt-archive', version: 1, exportedAt: SAMPLE_EPOCH,
    source: { id, label: id === 'local-source' ? 'This browser' : 'Boat tablet' },
    stores: {
      sessions: [sessionRecord({ packSamples: 2, packChunks: 1, sealedSamples: 2, state: 'closed', endedAt: SAMPLE_EPOCH + 1_000, endReason: 'user-disconnect' })],
      chunks: [packChunk(packSamples(2))], devices: [deviceRecord()],
      meta: [{ key: 'totals', schema: 1, totalSamples: 2, createdAt: SAMPLE_EPOCH, lastPrunedAt: null }],
      warnings: [], ringRecords: [], ringReads: [],
    },
    preferences: [{ key: 'shunt.theme', value: 'light' }, { key: SECRET_PREFERENCE_KEY, value: 'a'.repeat(32) }],
  }
  validateArchiveSnapshot(archived)
  return archived
}

function descriptor(archived: ArchiveSnapshot): ImportedArchive {
  return { source: archived.source, exportedAt: archived.exportedAt, importedAt: SAMPLE_EPOCH, preferences: archived.preferences }
}

function deferred<TResult>() {
  let resolve!: (result: TResult) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<TResult>((fulfill, fail) => { resolve = fulfill; reject = fail })
  return { promise, resolve, reject }
}

function setup(saved: readonly ArchiveSnapshot[] = []) {
  const local = snapshot('local-source')
  const retained = new Map(saved.map((archived) => [archived.source.id, archived]))
  const localStore = new MemoryHistoryStore()
  const foreignStore = new MemoryHistoryStore()
  const repository = {
    source: local.source,
    capture: vi.fn(async (preferences: readonly ArchivePreference[]) => ({ ...local, preferences })),
    listImported: vi.fn(async (): Promise<readonly ImportedArchive[]> => [...retained.values()].map(descriptor)),
    importArchive: vi.fn(async (archived: ArchiveSnapshot) => {
      retained.set(archived.source.id, archived)
      return descriptor(archived)
    }),
    readImported: vi.fn(async (sourceId: string) => {
      const archived = retained.get(sourceId)
      if (archived === undefined) throw new Error('Missing imported source')
      return archived
    }),
    openImported: vi.fn(async (_sourceId: string): Promise<HistoryStore> => foreignStore),
    restoreLocal: vi.fn(async (_archived: ArchiveSnapshot, _confirmation: 'replace') => undefined),
    close: vi.fn(),
  } satisfies ArchiveRepository
  const dependencies = {
    openRepository: vi.fn(async (_databaseName: string, _label: string): Promise<ArchiveRepository> => repository),
    showHistory: vi.fn((_store: HistoryStore, _capturedAt?: number) => undefined),
    radiosBusy: vi.fn(() => false),
    preferencesChanged: vi.fn(() => undefined),
    exportFile: vi.fn(async (_snapshots: readonly ArchiveSnapshot[], _signal: AbortSignal) => undefined),
    importFile: vi.fn(async (_file: File, _signal: AbortSignal): Promise<readonly ArchiveSnapshot[]> => [snapshot()]),
  } satisfies ArchiveWorkspaceDependencies
  return { workspace: createArchiveWorkspace(dependencies), repository, dependencies, localStore, foreignStore, retained }
}

async function initialized(saved: readonly ArchiveSnapshot[] = []) {
  const harness = setup(saved)
  await harness.workspace.initialize('test.archive', harness.localStore, 'This browser')
  return harness
}

beforeEach(() => {
  localStorage.clear()
  restoredPreferencesRevision.value = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('archive workspace transfers', () => {
  it('captures the local source for sync while another source is selected', async () => {
    const { workspace, repository } = await initialized([snapshot()])
    await workspace.selectSource('foreign-source')
    localStorage.setItem('shunt.theme', 'dark')
    localStorage.setItem(SECRET_PREFERENCE_KEY, 'b'.repeat(32))

    const captured = await workspace.captureForSync(false)

    expect(captured.source.id).toBe('local-source')
    expect(captured.preferences).toEqual([{ key: 'shunt.theme', value: 'dark' }])
    expect(repository.readImported).not.toHaveBeenCalled()
    expect(workspace.selectedSourceId.value).toBe('foreign-source')
  })

  it('saves synced sources without changing the active recorder or applying their settings', async () => {
    const { workspace, dependencies, repository } = await initialized()
    dependencies.radiosBusy.mockReturnValue(true)
    localStorage.setItem('shunt.theme', 'dark')

    await workspace.saveSyncedArchive(snapshot())

    expect(workspace.imported.value).toEqual([descriptor(snapshot())])
    expect(workspace.selectedSourceId.value).toBeNull()
    expect(repository.restoreLocal).not.toHaveBeenCalled()
    expect(dependencies.preferencesChanged).not.toHaveBeenCalled()
    expect(localStorage.getItem('shunt.theme')).toBe('dark')
  })

  it('ignores a synced import that finishes after the workspace closes', async () => {
    const { workspace, repository } = await initialized()
    const writing = deferred<ImportedArchive>()
    repository.importArchive.mockReturnValueOnce(writing.promise)
    const saving = workspace.saveSyncedArchive(snapshot(), true)
    workspace.dispose()
    writing.resolve(descriptor(snapshot()))
    await saving
    expect(workspace.imported.value).toEqual([])
    expect(workspace.selectedSourceId.value).toBeNull()
    expect(repository.openImported).not.toHaveBeenCalled()
  })

  it('previews validated imports without writing history or preferences', async () => {
    const { workspace, repository, dependencies } = await initialized()
    localStorage.setItem('shunt.theme', 'dark')
    await workspace.previewImport(new File(['workbook'], 'archive.xlsx'))
    expect(workspace.preview.value).toEqual([snapshot()])
    expect(repository.importArchive).not.toHaveBeenCalled()
    expect(repository.restoreLocal).not.toHaveBeenCalled()
    expect(dependencies.preferencesChanged).not.toHaveBeenCalled()
    expect(localStorage.getItem('shunt.theme')).toBe('dark')
    expect(workspace.selectedSourceId.value).toBeNull()
  })

  it('leaves persistence untouched when the codec rejects any workbook part', async () => {
    const { workspace, repository, dependencies } = await initialized()
    dependencies.importFile.mockRejectedValue(new Error('Archive sample total does not match its manifest'))
    await workspace.previewImport(new File(['damaged'], 'archive.zip'))
    await workspace.applyImport()
    expect(workspace.failure.value).toContain('sample total')
    expect(workspace.preview.value).toEqual([])
    expect(repository.importArchive).not.toHaveBeenCalled()
    expect(repository.restoreLocal).not.toHaveBeenCalled()
  })

  it('imports previewed sources and selects the last source without applying its settings', async () => {
    const { workspace, repository, dependencies } = await initialized()
    localStorage.setItem('shunt.theme', 'dark')
    await workspace.previewImport(new File(['workbook'], 'archive.xlsx'))
    await workspace.applyImport()
    expect(repository.importArchive).toHaveBeenCalledExactlyOnceWith(snapshot())
    expect(workspace.selectedSourceId.value).toBe('foreign-source')
    expect(workspace.readOnly.value).toBe(true)
    expect(workspace.preview.value).toEqual([])
    expect(workspace.imported.value).toEqual([descriptor(snapshot())])
    expect(localStorage.getItem('shunt.theme')).toBe('dark')
    expect(dependencies.preferencesChanged).not.toHaveBeenCalled()
  })

  it('keeps successful sources and the remaining preview when a later source cannot be stored', async () => {
    const { workspace, repository, dependencies } = await initialized()
    const first = snapshot('first-source')
    const second = snapshot('second-source')
    dependencies.importFile.mockResolvedValue([first, second])
    repository.importArchive.mockImplementation(async (archived) => {
      if (archived.source.id === second.source.id) throw new Error('Storage quota reached')
      return descriptor(archived)
    })
    repository.listImported.mockResolvedValue([descriptor(first)])
    await workspace.previewImport(new File(['bundle'], 'archives.zip'))
    await workspace.applyImport()
    expect(repository.importArchive).toHaveBeenCalledTimes(2)
    expect(workspace.imported.value).toEqual([descriptor(first)])
    expect(workspace.preview.value).toEqual([second])
    expect(workspace.notice.value).toContain('1 archive imported')
    expect(workspace.failure.value).toBe('Storage quota reached')
    expect(workspace.selectedSourceId.value).toBeNull()
  })

  it('omits saved secrets from every exported source unless explicitly requested', async () => {
    const foreign = snapshot()
    const { workspace, repository, dependencies } = await initialized([foreign, snapshot('local-source')])
    localStorage.setItem(SECRET_PREFERENCE_KEY, 'b'.repeat(32))
    await workspace.exportArchives(false, true)
    const withoutSecret = dependencies.exportFile.mock.calls[0]![0]
    expect(withoutSecret.map((archived) => archived.source.id)).toEqual(['local-source', 'foreign-source'])
    expect(withoutSecret.every((archived) => archived.preferences.every((preference) => preference.key !== SECRET_PREFERENCE_KEY))).toBe(true)
    expect(repository.readImported).toHaveBeenCalledExactlyOnceWith('foreign-source')

    await workspace.exportArchives(true, true)
    const withSecret = dependencies.exportFile.mock.calls[1]![0]
    expect(withSecret.every((archived) => archived.preferences.some((preference) => preference.key === SECRET_PREFERENCE_KEY))).toBe(true)
    expect(foreign.preferences).toHaveLength(2)
  })

  it('exports only the selected foreign archive without capturing live recording state', async () => {
    const { workspace, repository, dependencies } = await initialized([snapshot()])
    await workspace.selectSource('foreign-source')
    await workspace.exportArchives(false, false)
    expect(repository.capture).not.toHaveBeenCalled()
    expect(dependencies.exportFile.mock.calls[0]![0]).toEqual([{ ...snapshot(), preferences: [{ key: 'shunt.theme', value: 'light' }] }])
  })

  it('rejects overlapping transfers and ignores a completed preview after cancellation', async () => {
    const { workspace, dependencies, repository } = await initialized()
    const parsing = deferred<readonly ArchiveSnapshot[]>()
    dependencies.importFile.mockReturnValue(parsing.promise)
    const operation = workspace.previewImport(new File(['workbook'], 'archive.xlsx'))
    expect(workspace.busy.value).toBe(true)
    await workspace.exportArchives(false, true)
    expect(repository.capture).not.toHaveBeenCalled()
    workspace.cancel()
    expect(dependencies.importFile.mock.calls[0]![1].aborted).toBe(true)
    parsing.resolve([snapshot()])
    await operation
    expect(workspace.preview.value).toEqual([])
    expect(workspace.busy.value).toBe(false)
    expect(workspace.failure.value).toBe('Transfer cancelled.')
  })

  it('keeps a committed source but stops before the next source after cancellation', async () => {
    const { workspace, repository, dependencies } = await initialized()
    const first = snapshot('first-source')
    const second = snapshot('second-source')
    dependencies.importFile.mockResolvedValue([first, second])
    const committing = deferred<ImportedArchive>()
    repository.importArchive.mockReturnValueOnce(committing.promise)
    repository.listImported.mockResolvedValue([descriptor(first)])
    await workspace.previewImport(new File(['bundle'], 'archives.zip'))
    const importing = workspace.applyImport()
    workspace.cancel()
    committing.resolve(descriptor(first))
    await importing
    expect(repository.importArchive).toHaveBeenCalledTimes(1)
    expect(workspace.imported.value).toEqual([descriptor(first)])
    expect(workspace.preview.value).toEqual([second])
    expect(workspace.notice.value).toContain('1 archive imported')
    expect(workspace.failure.value).toBe('Transfer cancelled.')
  })

  it.each(['success', 'failure'])('ignores a pending import listing after disposal on %s without removing committed sources', async (outcome) => {
    const { workspace, repository, dependencies, retained } = await initialized()
    const listing = deferred<readonly ImportedArchive[]>()
    const listingStarted = deferred<void>()
    repository.listImported.mockImplementationOnce(() => {
      listingStarted.resolve()
      return listing.promise
    })
    await workspace.previewImport(new File(['workbook'], 'archive.xlsx'))
    const importing = workspace.applyImport()
    await listingStarted.promise
    workspace.dispose()

    if (outcome === 'success') listing.resolve([descriptor(snapshot())])
    else listing.reject(new Error('Archive closed'))
    await importing

    expect(retained.get('foreign-source')).toEqual(snapshot())
    expect(workspace.imported.value).toEqual([])
    expect(workspace.preview.value).toEqual([])
    expect(workspace.notice.value).toBeNull()
    expect(workspace.failure.value).toBeNull()
    expect(workspace.ready.value).toBe(false)
    expect(workspace.busy.value).toBe(false)
    expect(dependencies.showHistory).not.toHaveBeenCalled()
  })

  it('ignores an export completion after disposal', async () => {
    const { workspace, dependencies } = await initialized()
    const exporting = deferred<undefined>()
    const exportStarted = deferred<void>()
    dependencies.exportFile.mockImplementationOnce(() => {
      exportStarted.resolve()
      return exporting.promise
    })
    const operation = workspace.exportArchives(false, false)
    await exportStarted.promise
    workspace.dispose()
    exporting.resolve(undefined)
    await operation
    expect(workspace.notice.value).toBeNull()
    expect(workspace.failure.value).toBeNull()
  })
})

describe('archive workspace source selection', () => {
  it('switches browsing stores while the local recording remains open and untouched', async () => {
    const { workspace, localStore, foreignStore, dependencies } = await initialized([snapshot()])
    await localStore.openSession(sessionRecord())
    const before = await localStore.readSession(sessionRecord().id)
    const closeLocal = vi.spyOn(localStore, 'close')
    const closeForeign = vi.spyOn(foreignStore, 'close')
    await workspace.selectSource('foreign-source')
    expect(dependencies.showHistory).toHaveBeenLastCalledWith(foreignStore, SAMPLE_EPOCH)
    expect(await localStore.readSession(sessionRecord().id)).toEqual(before)
    expect(closeLocal).not.toHaveBeenCalled()
    await workspace.selectSource(null)
    expect(dependencies.showHistory).toHaveBeenLastCalledWith(localStore, undefined)
    expect(closeForeign).toHaveBeenCalledTimes(1)
    expect(workspace.readOnly.value).toBe(false)
  })

  it('closes a stale source response after the owner returns to local history', async () => {
    const { workspace, repository, foreignStore, localStore, dependencies } = await initialized([snapshot()])
    const opening = deferred<HistoryStore>()
    repository.openImported.mockReturnValue(opening.promise)
    const close = vi.spyOn(foreignStore, 'close')
    const selecting = workspace.selectSource('foreign-source')
    await workspace.selectSource(null)
    opening.resolve(foreignStore)
    await selecting
    expect(close).toHaveBeenCalledTimes(1)
    expect(workspace.selectedSourceId.value).toBeNull()
    expect(dependencies.showHistory).toHaveBeenCalledExactlyOnceWith(localStore, undefined)
  })

  it('closes a source connection that arrives after disposal', async () => {
    const { workspace, repository, foreignStore, dependencies } = await initialized([snapshot()])
    const opening = deferred<HistoryStore>()
    repository.openImported.mockReturnValue(opening.promise)
    const close = vi.spyOn(foreignStore, 'close')
    const selecting = workspace.selectSource('foreign-source')
    workspace.dispose()
    opening.resolve(foreignStore)
    await selecting
    expect(close).toHaveBeenCalledTimes(1)
    expect(repository.close).toHaveBeenCalledTimes(1)
    expect(dependencies.showHistory).not.toHaveBeenCalled()
    expect(workspace.ready.value).toBe(false)
  })

  it('does not publish imported sources from initialization completed after disposal', async () => {
    const { workspace, repository, localStore } = setup([snapshot()])
    const listing = deferred<readonly ImportedArchive[]>()
    repository.listImported.mockReturnValue(listing.promise)
    const initializing = workspace.initialize('test.archive', localStore, 'This browser')
    await Promise.resolve()
    workspace.dispose()
    listing.resolve([descriptor(snapshot())])
    await initializing
    expect(workspace.imported.value).toEqual([])
    expect(workspace.ready.value).toBe(false)
  })

  it('does not replace the current imported source list with an older initialization response', async () => {
    const { workspace, repository, localStore } = setup()
    const earlier = deferred<readonly ImportedArchive[]>()
    repository.listImported.mockReturnValueOnce(earlier.promise).mockResolvedValueOnce([descriptor(snapshot('current-source'))])
    const initializing = workspace.initialize('older.archive', localStore, 'Older browser')
    await Promise.resolve()
    await workspace.initialize('current.archive', localStore, 'Current browser')
    earlier.resolve([descriptor(snapshot('older-source'))])
    await initializing
    expect(workspace.imported.value).toEqual([descriptor(snapshot('current-source'))])
  })
})

describe('archive workspace settings and restore', () => {
  it('applies settings separately and refreshes the remembered display after storage succeeds', async () => {
    const { workspace, dependencies } = await initialized([snapshot()])
    localStorage.setItem(SECRET_PREFERENCE_KEY, 'existing local secret')
    await workspace.selectSource('foreign-source')
    await workspace.applySelectedPreferences(false)
    expect(localStorage.getItem('shunt.theme')).toBe('light')
    expect(localStorage.getItem(SECRET_PREFERENCE_KEY)).toBe('existing local secret')
    expect(dependencies.preferencesChanged).toHaveBeenCalledTimes(1)
    expect(restoredPreferencesRevision.value).toBe(1)
  })

  it('blocks settings and local replacement while radios or the recorder are active', async () => {
    const { workspace, repository, dependencies } = await initialized([snapshot()])
    await workspace.selectSource('foreign-source')
    dependencies.radiosBusy.mockReturnValue(true)
    await workspace.applySelectedPreferences(true)
    expect(dependencies.preferencesChanged).not.toHaveBeenCalled()
    expect(restoredPreferencesRevision.value).toBe(0)
    await workspace.restoreSelectedArchive()
    expect(repository.restoreLocal).not.toHaveBeenCalled()
    expect(workspace.failure.value).toContain('Disconnect the radios')
  })

  it('does not refresh instruments when saved settings could not be applied', async () => {
    const { workspace, dependencies } = await initialized([snapshot()])
    await workspace.selectSource('foreign-source')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage quota reached') })
    await workspace.applySelectedPreferences(false)
    expect(dependencies.preferencesChanged).not.toHaveBeenCalled()
    expect(restoredPreferencesRevision.value).toBe(0)
    expect(workspace.failure.value).toContain('Storage quota reached')
    expect(workspace.notice.value).toBeNull()
  })

  it('does not apply settings when cancelled while the saved archive is loading', async () => {
    const { workspace, repository, dependencies } = await initialized([snapshot()])
    await workspace.selectSource('foreign-source')
    const reading = deferred<ArchiveSnapshot>()
    repository.readImported.mockReturnValue(reading.promise)
    const applying = workspace.applySelectedPreferences(false)
    workspace.cancel()
    reading.resolve(snapshot())
    await applying
    expect(localStorage.getItem('shunt.theme')).toBeNull()
    expect(dependencies.preferencesChanged).not.toHaveBeenCalled()
    expect(workspace.failure.value).toBe('Transfer cancelled.')
  })

  it('does not replace history when cancelled while the saved archive is loading', async () => {
    const { workspace, repository } = await initialized([snapshot('local-source')])
    await workspace.selectSource('local-source')
    const reading = deferred<ArchiveSnapshot>()
    repository.readImported.mockReturnValue(reading.promise)
    const restoring = workspace.restoreSelectedArchive()
    workspace.cancel()
    reading.resolve(snapshot('local-source'))
    await restoring
    expect(repository.restoreLocal).not.toHaveBeenCalled()
    expect(workspace.failure.value).toBe('Transfer cancelled.')
  })

  it('rechecks recording activity after loading the archive before local replacement', async () => {
    const { workspace, repository, dependencies } = await initialized([snapshot('local-source')])
    await workspace.selectSource('local-source')
    const reading = deferred<ArchiveSnapshot>()
    repository.readImported.mockReturnValue(reading.promise)
    const restoring = workspace.restoreSelectedArchive()
    dependencies.radiosBusy.mockReturnValue(true)
    reading.resolve(snapshot('local-source'))
    await restoring
    expect(repository.restoreLocal).not.toHaveBeenCalled()
    expect(workspace.failure.value).toContain('Disconnect the radios')
  })

  it('returns to local history after successful replacement without applying saved settings', async () => {
    const { workspace, repository, localStore, dependencies } = await initialized([snapshot('local-source')])
    await workspace.selectSource('local-source')
    await workspace.restoreSelectedArchive()
    expect(repository.restoreLocal).toHaveBeenCalledExactlyOnceWith(snapshot('local-source'), 'replace')
    expect(workspace.selectedSourceId.value).toBeNull()
    expect(dependencies.showHistory).toHaveBeenLastCalledWith(localStore, undefined)
    expect(dependencies.preferencesChanged).not.toHaveBeenCalled()
  })

  it('ignores a committed restore completion after disposal', async () => {
    const { workspace, repository, dependencies } = await initialized([snapshot('local-source')])
    await workspace.selectSource('local-source')
    dependencies.showHistory.mockClear()
    const restoring = deferred<undefined>()
    const restoreStarted = deferred<void>()
    repository.restoreLocal.mockImplementationOnce(() => {
      restoreStarted.resolve()
      return restoring.promise
    })
    const operation = workspace.restoreSelectedArchive()
    await restoreStarted.promise
    workspace.dispose()
    restoring.resolve(undefined)
    await operation
    expect(repository.restoreLocal).toHaveBeenCalledExactlyOnceWith(snapshot('local-source'), 'replace')
    expect(workspace.notice.value).toBeNull()
    expect(workspace.failure.value).toBeNull()
    expect(dependencies.showHistory).not.toHaveBeenCalled()
  })
})
