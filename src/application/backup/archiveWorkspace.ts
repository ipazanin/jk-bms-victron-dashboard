import { computed, ref, shallowRef } from 'vue'

import type { ArchiveSnapshot } from '../../domain/backup/ArchiveSnapshot'
import { SECRET_PREFERENCE_KEY } from '../../domain/backup/archivePreferences'
import type { ArchiveSource } from '../../domain/backup/ArchiveSource'
import type { HistoryStore } from '../history/port'
import type { ArchiveRepository } from './ArchiveRepository'
import type { ArchiveWorkspaceDependencies } from './ArchiveWorkspaceDependencies'
import type { ImportedArchive } from './ImportedArchive'
import { applyArchivePreferences, captureArchivePreferences } from './preferences'

export function createArchiveWorkspace(dependencies: ArchiveWorkspaceDependencies) {
  const source = shallowRef<ArchiveSource | null>(null)
  const imported = shallowRef<readonly ImportedArchive[]>([])
  const selectedSourceId = ref<string | null>(null)
  const preview = shallowRef<readonly ArchiveSnapshot[]>([])
  const busy = ref(false)
  const failure = ref<string | null>(null)
  const notice = ref<string | null>(null)
  let repository: ArchiveRepository | null = null
  let localStore: HistoryStore | null = null
  let importedStore: HistoryStore | null = null
  let pending: AbortController | null = null
  let selectionToken = 0
  let initializationToken = 0

  const selected = computed(() => imported.value.find((archive) => archive.source.id === selectedSourceId.value) ?? null)
  const readOnly = computed(() => selectedSourceId.value !== null)
  const ready = computed(() => source.value !== null)

  async function initialize(databaseName: string, store: HistoryStore, label: string): Promise<void> {
    const token = ++initializationToken
    localStore = store
    try {
      const opened = await dependencies.openRepository(databaseName, label)
      if (token !== initializationToken) {
        opened.close()
        return
      }
      repository?.close()
      repository = opened
      source.value = opened.source
      const available = await opened.listImported()
      if (token === initializationToken) imported.value = available
    } catch (error) {
      if (token === initializationToken) failure.value = messageOf(error)
    }
  }

  function attachLocalStore(store: HistoryStore): void {
    localStore = store
    if (selectedSourceId.value === null) dependencies.showHistory(store)
  }

  async function selectSource(sourceId: string | null): Promise<void> {
    if (localStore === null || repository === null) return
    const token = ++selectionToken
    failure.value = null
    try {
      const opened = sourceId === null ? localStore : await repository.openImported(sourceId)
      if (token !== selectionToken) {
        if (opened !== localStore) opened.close()
        return
      }
      const previous = importedStore
      importedStore = sourceId === null ? null : opened
      selectedSourceId.value = sourceId
      dependencies.showHistory(opened, selected.value?.exportedAt)
      previous?.close()
    } catch (error) {
      if (token === selectionToken) failure.value = messageOf(error)
    }
  }

  async function exportArchives(includeSecret: boolean, allSources: boolean): Promise<void> {
    await run(async (signal) => {
      const token = initializationToken
      const archives = requireRepository()
      const snapshots: ArchiveSnapshot[] = []
      if (allSources || selectedSourceId.value === null) {
        snapshots.push(await archives.capture(captureArchivePreferences(includeSecret)))
      }
      if (allSources) {
        for (const archive of imported.value) {
          if (archive.source.id === source.value?.id) continue
          snapshots.push(await archives.readImported(archive.source.id))
        }
      } else if (selectedSourceId.value !== null) {
        snapshots.push(await archives.readImported(selectedSourceId.value))
      }
      const transferable = snapshots.map((snapshot) => ({
        ...snapshot,
        preferences: snapshot.preferences.filter((preference) => includeSecret || preference.key !== SECRET_PREFERENCE_KEY),
      }))
      signal.throwIfAborted()
      await dependencies.exportFile(transferable, signal)
      if (token !== initializationToken) return
      notice.value = 'Archive exported. Keep the file somewhere outside this browser.'
    })
  }

  async function previewImport(file: File): Promise<void> {
    if (busy.value) return
    preview.value = []
    await run(async (signal) => {
      const snapshots = await dependencies.importFile(file, signal)
      signal.throwIfAborted()
      preview.value = snapshots
    })
  }

  async function applyImport(): Promise<void> {
    const snapshots = preview.value
    if (snapshots.length === 0) return
    await run(async (signal) => {
      const token = initializationToken
      const archives = requireRepository()
      let completed = 0
      try {
        for (const snapshot of snapshots) {
          signal.throwIfAborted()
          await archives.importArchive(snapshot)
          completed += 1
        }
      } finally {
        if (token === initializationToken) {
          const available = await archives.listImported()
          if (token === initializationToken) {
            imported.value = available
            if (completed > 0) {
              preview.value = snapshots.slice(completed)
              notice.value = `${completed} ${completed === 1 ? 'archive imported' : 'archives imported'}. Your current recording is unchanged.`
            }
          }
        }
      }
      if (token !== initializationToken) return
      await selectSource(snapshots[snapshots.length - 1]!.source.id)
      if (token !== initializationToken) return
      preview.value = []
    })
  }

  async function applySelectedPreferences(includeSecret: boolean): Promise<void> {
    await run(async (signal) => {
      if (selectedSourceId.value === null) return
      const snapshot = await requireRepository().readImported(selectedSourceId.value)
      signal.throwIfAborted()
      if (dependencies.radiosBusy()) throw new Error('Disconnect the radios before applying saved settings.')
      applyArchivePreferences(snapshot.preferences, includeSecret)
      dependencies.preferencesChanged()
      notice.value = 'Saved settings applied. Pair the radios in this browser before reconnecting.'
    })
  }

  async function restoreSelectedArchive(): Promise<void> {
    await run(async (signal) => {
      const token = initializationToken
      if (selectedSourceId.value === null) return
      if (dependencies.radiosBusy()) throw new Error('Disconnect the radios before restoring this browser archive.')
      const archives = requireRepository()
      const snapshot = await archives.readImported(selectedSourceId.value)
      signal.throwIfAborted()
      if (dependencies.radiosBusy()) throw new Error('Disconnect the radios before restoring this browser archive.')
      await archives.restoreLocal(snapshot, 'replace')
      if (token !== initializationToken) return
      await selectSource(null)
      if (token !== initializationToken) return
      notice.value = 'This browser archive was restored. Saved settings can be applied separately.'
    })
  }

  async function captureForSync(includeSecret: boolean, detail: 'complete' | 'hourly' = 'hourly'): Promise<ArchiveSnapshot> {
    if (busy.value) throw new Error('Finish the current archive operation before syncing.')
    return requireRepository().capture(captureArchivePreferences(includeSecret), detail)
  }

  async function saveSyncedArchive(snapshot: ArchiveSnapshot, select = false): Promise<void> {
    if (busy.value) throw new Error('Finish the current archive operation before opening cloud history.')
    const token = initializationToken
    busy.value = true
    try {
      const archives = requireRepository()
      await archives.importArchive(snapshot)
      if (token !== initializationToken) return
      const available = await archives.listImported()
      if (token !== initializationToken) return
      imported.value = available
      if (select || selectedSourceId.value === snapshot.source.id) await selectSource(snapshot.source.id)
    } finally {
      busy.value = false
    }
  }

  function clearPreview(): void {
    if (!busy.value) preview.value = []
  }

  function cancel(): void {
    pending?.abort()
  }

  function dispose(): void {
    initializationToken += 1
    selectionToken += 1
    pending?.abort()
    importedStore?.close()
    importedStore = null
    repository?.close()
    repository = null
    localStore = null
    source.value = null
    imported.value = []
    selectedSourceId.value = null
    preview.value = []
  }

  async function run(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (busy.value) return
    const token = initializationToken
    busy.value = true
    failure.value = null
    notice.value = null
    const controller = new AbortController()
    pending = controller
    try {
      await operation(controller.signal)
    } catch (error) {
      if (token === initializationToken) {
        failure.value = controller.signal.aborted ? 'Transfer cancelled.' : messageOf(error)
      }
    } finally {
      pending = null
      busy.value = false
    }
  }

  function requireRepository(): ArchiveRepository {
    if (repository === null) throw new Error('The archive is not ready yet.')
    return repository
  }

  return {
    source, imported, selectedSourceId, selected, readOnly, ready, preview, busy, failure, notice,
    initialize, attachLocalStore, selectSource, exportArchives, previewImport, applyImport,
    applySelectedPreferences, restoreSelectedArchive, clearPreview, cancel, dispose,
    captureForSync, saveSyncedArchive,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The archive operation failed.'
}
