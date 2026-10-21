import { ref, shallowRef } from 'vue'
import type { ArchiveSnapshot } from '../../domain/backup/ArchiveSnapshot'
import type { ArchivePreference } from '../../domain/backup/ArchivePreference'
import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'
import type { CloudArchiveRevision } from '../../domain/sync/CloudArchiveRevision'
import type { CloudSettingsRevision } from '../../domain/sync/CloudSettingsRevision'
import { createSettingsRevision, settingsHeads, sharedPreferences } from '../../domain/sync/sharedSettings'
import { validateCloudCatalog } from '../../domain/sync/syncValidation'
import { downloadArchive } from './archiveSync'
import { updateCloudWorkspace } from './cloudWorkspaceJson'
import type { GoogleDriveFolder } from './GoogleDriveFolder'
import type { GoogleSyncDependencies } from './GoogleSyncDependencies'

const RECORDING_PUBLISH_INTERVAL_MS = 60 * 60_000

export function createGoogleSyncController(dependencies: GoogleSyncDependencies) {
  const saved = dependencies.load()
  const enabled = ref(saved.enabled)
  const autoSync = ref(saved.autoSync)
  const includeSecret = ref(saved.includeSecret)
  const sourceLabel = ref(saved.sourceLabel)
  const workspace = shallowRef<CloudWorkspace | null>(saved.workspace)
  const destination = shallowRef<GoogleDriveFolder>({ id: 'root', name: 'My Drive' })
  const lastSyncAt = ref(saved.lastSyncAt)
  const configured = ref(dependencies.configured())
  const prepared = ref(false)
  const preparing = ref(false)
  const connected = ref(false)
  const busy = ref(false)
  const progress = ref<string | null>(null)
  const failure = ref<string | null>(null)
  const notice = ref<string | null>(null)
  const workspaces = shallowRef<readonly CloudWorkspace[]>([])
  const revisions = shallowRef<readonly CloudArchiveRevision[]>([])
  const conflicts = shallowRef<readonly CloudSettingsRevision[]>([])
  const conflictReason = ref<string | null>(null)
  let baseline = saved.settingsBaseline
  let downloaded = { ...saved.downloaded }
  let lastPublishedAt: number | null = null
  let pending: AbortController | null = null
  let preparingGeneration = 0
  let unsubscribe: (() => void) | null = null
  let unsubscribeRecording: (() => void) | null = null
  let recordingUploadPending = false
  let interval: ReturnType<typeof setInterval> | undefined
  let active = false

  function persist(): void {
    try {
      dependencies.save({ enabled: enabled.value, autoSync: autoSync.value, includeSecret: includeSecret.value,
        sourceLabel: sourceLabel.value, workspace: workspace.value, lastSyncAt: lastSyncAt.value,
        settingsBaseline: baseline, downloaded })
    } catch {
      failure.value = 'Browser storage could not save the sync preferences. They may be lost after a reload.'
    }
  }

  function start(): void {
    if (active) return
    active = true
    unsubscribe = dependencies.subscribeAccess((authorized) => {
      connected.value = authorized
      if (!authorized) pending?.abort()
    })
    unsubscribeRecording = dependencies.subscribeRecordingEnd(() => {
      if (!canSyncAutomatically()) return
      if (busy.value) recordingUploadPending = true
      else void syncNow(true, true)
    })
    interval = setInterval(() => {
      if (canSyncAutomatically() && !busy.value) void syncNow(true)
    }, 60_000)
    if (enabled.value) void prepare()
  }

  function canSyncAutomatically(): boolean {
    return active && enabled.value && autoSync.value && connected.value && workspace.value?.version === 3
      && navigator.onLine && document.visibilityState === 'visible'
  }

  async function prepare(): Promise<void> {
    if (!enabled.value || !configured.value || preparing.value || prepared.value) return
    const generation = ++preparingGeneration
    preparing.value = true
    failure.value = null
    try {
      await dependencies.prepare()
      if (generation === preparingGeneration && enabled.value) prepared.value = true
    } catch (error) {
      if (generation === preparingGeneration) failure.value = describe(error)
    } finally {
      if (generation === preparingGeneration) preparing.value = false
    }
  }

  function setEnabled(next: boolean): void {
    enabled.value = next
    if (!next) {
      preparingGeneration++
      preparing.value = false
      disconnect()
    } else {
      void prepare()
    }
    persist()
  }

  function setAutoSync(next: boolean): void {
    autoSync.value = next
    if (!next) recordingUploadPending = false
    persist()
  }
  function setIncludeSecret(next: boolean): void {
    includeSecret.value = next
    baseline = null
    persist()
  }
  function setSourceLabel(label: string): void {
    sourceLabel.value = label.trim().slice(0, 100)
    persist()
  }

  async function connect(): Promise<void> {
    await run(async (signal) => {
      if (!prepared.value) throw new Error('Wait for Google sign-in to load, then connect again.')
      progress.value = 'Waiting for Google sign-in…'
      // Google never answers when its popup lands on an error page, so cancelling has to reject the request.
      const forget = () => dependencies.forgetAccess()
      signal.addEventListener('abort', forget)
      try {
        await dependencies.authorize()
      } finally {
        signal.removeEventListener('abort', forget)
      }
      signal.throwIfAborted()
      progress.value = null
      const available = await dependencies.listWorkspaces(signal)
      signal.throwIfAborted()
      workspaces.value = available
      if (workspace.value) {
        const found = workspaces.value.find((candidate) => candidate.id === workspace.value?.id)
        switchWorkspace(found ?? null)
        if (found && found.version !== 3) {
          const catalog = await dependencies.remote.readCatalog(found, signal)
          validateCloudCatalog(catalog)
          signal.throwIfAborted()
          revisions.value = catalog.archives
          if (catalog.unreadableArchives) failure.value = unreadableArchiveMessage(catalog.unreadableArchives)
        }
      }
      notice.value = workspace.value
        ? workspace.value.version === 3 ? 'Connected. Sync now to exchange saved history and settings.' : 'Connected. Open saved history from this read-only workspace.'
        : 'Connected. Create or choose a cloud workspace.'
    }, 'connect')
  }

  function disconnect(): void {
    recordingUploadPending = false
    pending?.abort()
    dependencies.forgetAccess()
    connected.value = false
    conflicts.value = []
    conflictReason.value = null
    notice.value = null
  }

  function switchWorkspace(next: CloudWorkspace | null): void {
    if (workspace.value?.id !== next?.id) {
      baseline = null
      downloaded = {}
      lastSyncAt.value = null
      lastPublishedAt = null
    }
    workspace.value = next
    revisions.value = []
    conflicts.value = []
    conflictReason.value = null
    persist()
  }

  async function chooseDestination(): Promise<void> {
    await run(async (signal) => {
      const selected = await dependencies.chooseFolder(signal)
      signal.throwIfAborted()
      if (selected) destination.value = selected
    })
  }

  async function createWorkspace(name: string): Promise<void> {
    await run(async (signal) => {
      const created = await dependencies.createWorkspace(name, destination.value.id, signal)
      signal.throwIfAborted()
      workspaces.value = [...workspaces.value, created]
      switchWorkspace(created)
      notice.value = 'Cloud workspace created. Sync now to upload this device.'
    })
  }

  async function selectWorkspace(id: string): Promise<void> {
    await run(async (signal) => {
      const selected = workspaces.value.find((candidate) => candidate.id === id)
      if (!selected) throw new Error('Choose a workspace available to this Google account.')
      const catalog = await dependencies.remote.readCatalog(selected, signal)
      validateCloudCatalog(catalog)
      signal.throwIfAborted()
      switchWorkspace(selected)
      revisions.value = catalog.archives
      if (catalog.unreadableArchives) failure.value = unreadableArchiveMessage(catalog.unreadableArchives)
    })
  }

  async function chooseWorkspace(): Promise<void> {
    await run(async (signal) => {
      const selected = await dependencies.chooseWorkspace(signal)
      signal.throwIfAborted()
      if (!selected) return
      const catalog = await dependencies.remote.readCatalog(selected, signal)
      validateCloudCatalog(catalog)
      signal.throwIfAborted()
      workspaces.value = [...workspaces.value.filter((candidate) => candidate.id !== selected.id), selected]
      switchWorkspace(selected)
      revisions.value = catalog.archives
      if (catalog.unreadableArchives) failure.value = unreadableArchiveMessage(catalog.unreadableArchives)
    })
  }

  async function syncNow(automatic = false, recordingEnded = false): Promise<void> {
    await run(async (signal) => {
      const selected = requireWorkspace()
      if (selected.version !== 3) throw new Error('This legacy workspace is read-only. Open its saved history or create a JSON workspace to sync.')
      const sourceId = dependencies.sourceId()
      if (!sourceId) throw new Error('The archive is not ready yet.')
      const existing = await dependencies.remote.readCatalog(selected, signal)
      validateCloudCatalog(existing)
      signal.throwIfAborted()
      const deferred = automatic && !recordingEnded && dependencies.recording() && lastPublishedAt !== null
        && dependencies.now() - lastPublishedAt < RECORDING_PUBLISH_INTERVAL_MS
      let snapshot: ArchiveSnapshot | undefined
      if (!deferred) {
        progress.value = 'Reading this browser archive…'
        const captured = await dependencies.capture(includeSecret.value, 'hourly')
        signal.throwIfAborted()
        snapshot = sourceLabel.value ? { ...captured, source: { ...captured.source, label: sourceLabel.value } } : captured
      }
      const settings = await syncSettings(selected, existing.settings, sourceId, signal)
      const updated = await updateCloudWorkspace(existing, snapshot, settings?.revision)
      signal.throwIfAborted()
      progress.value = 'Saving shared history and settings…'
      const catalog = updated === existing ? existing : await dependencies.remote.writeCatalog(selected, updated, signal)
      signal.throwIfAborted()
      if (!deferred) lastPublishedAt = dependencies.now()
      if (settings) acceptBaseline(selected, settings.localHash, settings.cloudHash)
      revisions.value = catalog.archives
      const latest = new Map(catalog.archives.map((revision) => [revision.source.id, revision]))
      const unreadable: string[] = []
      for (const revision of latest.values()) {
        if (revision.source.id === sourceId) continue
        const imported = dependencies.imported().find((archive) => archive.source.id === revision.source.id)
        if (downloaded[revision.source.id] === revision.id && imported?.exportedAt === revision.exportedAt) continue
        try {
          const remoteArchive = await downloadArchive(revision, dependencies.remote, signal, (message) => { progress.value = message })
          signal.throwIfAborted()
          await dependencies.importArchive(remoteArchive, false)
        } catch (error) {
          if (signal.aborted) throw error
          unreadable.push(revision.source.label)
          continue
        }
        signal.throwIfAborted()
        downloaded[revision.source.id] = revision.id
        persist()
      }
      signal.throwIfAborted()
      lastSyncAt.value = dependencies.now()
      persist()
      if (conflicts.value.length) notice.value = 'History synced. Choose which shared settings to keep.'
      else if (deferred) notice.value = 'Settings and other devices synced. This browser’s recording uploads hourly while it records.'
      else notice.value = 'History and shared settings synced.'
      const problems: string[] = []
      if (catalog.cleanupFailure) problems.push(catalog.cleanupFailure)
      if (catalog.unreadableArchives) problems.push(unreadableArchiveMessage(catalog.unreadableArchives))
      if (unreadable.length) problems.push(`History from ${unreadable.join(', ')} could not be downloaded. The next sync tries again.`)
      if (problems.length) failure.value = problems.join(' ')
    }, automatic ? 'automatic' : 'manual')
  }

  async function syncSettings(selected: CloudWorkspace, versions: readonly CloudSettingsRevision[], sourceId: string, signal: AbortSignal): Promise<{ revision?: CloudSettingsRevision, localHash: string, cloudHash: string } | undefined> {
    const heads = settingsHeads(versions)
    const local = sharedPreferences(dependencies.preferences(includeSecret.value), includeSecret.value)
    const localHash = await preferenceHash(local)
    const cloudHashes = await Promise.all(heads.map((head) => preferenceHash(sharedPreferences(head.preferences, includeSecret.value))))
    signal.throwIfAborted()
    if (heads.length === 0) {
      if (local.length > 0) return prepareSettings(local, sourceId, [], localHash, signal)
      return
    }
    if (heads.length > 1) {
      if (!cloudHashes.every((cloudHash) => cloudHash === localHash)) {
        showConflict(heads, 'Several devices changed shared settings. Choose the version to keep.')
        return
      }
      let preferences: readonly ArchivePreference[]
      try {
        preferences = includeSecret.value ? local : preserveCloudKey(local, heads.flatMap((head) => head.preferences))
      } catch (error) {
        showConflict(heads, describe(error))
        return
      }
      return prepareSettings(preferences, sourceId, heads, localHash, signal)
    }
    const cloud = heads[0]!
    const cloudPreferences = sharedPreferences(cloud.preferences, includeSecret.value)
    const cloudHash = cloudHashes[0]!
    if (cloudHash === localHash || (baseline?.workspaceId === selected.id
      && baseline.localHash === localHash && baseline.cloudHash === cloudHash)) {
      return { localHash, cloudHash }
    }
    if (cloudPreferences.length === 0 && baseline?.workspaceId !== selected.id) {
      return prepareSettings(includeSecret.value ? local : preserveCloudKey(local, cloud.preferences), sourceId, heads, localHash, signal)
    }
    if (baseline?.workspaceId === selected.id && baseline.localHash === localHash) {
      if (dependencies.radiosBusy()) {
        showConflict(heads, 'Disconnect the radios before applying the changed cloud settings.')
        return
      }
      if (!samePreferences(local, sharedPreferences(dependencies.preferences(includeSecret.value), includeSecret.value))) {
        showConflict(heads, 'Settings changed on this device while syncing. Choose the version to keep.')
        return
      }
      dependencies.applyPreferences(cloudPreferences, includeSecret.value)
      const appliedHash = await preferenceHash(sharedPreferences(dependencies.preferences(includeSecret.value), includeSecret.value))
      signal.throwIfAborted()
      return { localHash: appliedHash, cloudHash }
    }
    if (baseline?.workspaceId === selected.id && baseline.cloudHash === cloudHash) {
      return prepareSettings(includeSecret.value ? local : preserveCloudKey(local, cloud.preferences), sourceId, heads, localHash, signal)
    }
    showConflict(heads, baseline ? 'Shared settings changed here and in the cloud. Choose the version to keep.' : 'This workspace has saved settings. Choose cloud settings or this device’s settings.')
  }

  function preserveCloudKey(local: readonly ArchivePreference[], cloud: readonly ArchivePreference[]): readonly ArchivePreference[] {
    if (local.some((preference) => preference.key === 'victron.advertisementKey')) return local
    const keys = new Map(cloud.filter((preference) => preference.key === 'victron.advertisementKey')
      .map((preference) => [preference.value, preference]))
    if (keys.size > 1) throw new Error('Cloud versions contain different Victron keys. Choose a cloud version with the key to keep, or opt in and choose this device’s settings.')
    return [...local, ...keys.values()]
  }

  async function prepareSettings(preferences: readonly ArchivePreference[], sourceId: string,
    parents: readonly CloudSettingsRevision[], localHash: string, signal: AbortSignal): Promise<{ revision: CloudSettingsRevision, localHash: string, cloudHash: string }> {
    signal.throwIfAborted()
    const revision = createSettingsRevision(preferences, sourceId, parents.map((parent) => parent.id), dependencies.now())
    const cloudHash = await preferenceHash(sharedPreferences(preferences, includeSecret.value))
    signal.throwIfAborted()
    return { revision, localHash, cloudHash }
  }

  function acceptBaseline(selected: CloudWorkspace, localHash: string, cloudHash: string): void {
    baseline = { workspaceId: selected.id, localHash, cloudHash }
    conflicts.value = []
    conflictReason.value = null
    persist()
  }

  function showConflict(heads: readonly CloudSettingsRevision[], reason: string): void {
    conflicts.value = heads
    conflictReason.value = reason
  }

  async function resolveSettings(choice: string): Promise<void> {
    await run(async (signal) => {
      const selected = requireWorkspace()
      if (selected.version !== 3) throw new Error('This legacy workspace is read-only. Create a JSON workspace to share settings.')
      if (conflicts.value.length === 0) throw new Error('Sync first to check the current cloud settings.')
      const expected = JSON.stringify(conflicts.value)
      const catalog = await dependencies.remote.readCatalog(selected, signal)
      validateCloudCatalog(catalog)
      signal.throwIfAborted()
      const heads = settingsHeads(catalog.settings)
      if (JSON.stringify(heads) !== expected) {
        showConflict(heads, 'Cloud settings changed again. Review the available versions before choosing.')
        return
      }
      const sourceId = dependencies.sourceId()
      if (!sourceId) throw new Error('The archive is not ready yet.')
      let chosen: readonly ArchivePreference[]
      if (choice === 'local') {
        const local = sharedPreferences(dependencies.preferences(includeSecret.value), includeSecret.value)
        chosen = includeSecret.value ? local : preserveCloudKey(local, heads.flatMap((head) => head.preferences))
      } else {
        const revision = heads.find((head) => head.id === choice)
        if (!revision) throw new Error('Choose one of the current cloud settings versions.')
        if (dependencies.radiosBusy()) throw new Error('Disconnect the radios before applying cloud settings.')
        chosen = preserveCloudKey(revision.preferences, heads.flatMap((head) => head.preferences))
        if (includeSecret.value) chosen = preserveCloudKey(chosen, dependencies.preferences(true))
        dependencies.applyPreferences(sharedPreferences(chosen, includeSecret.value), includeSecret.value)
      }
      const localHash = await preferenceHash(sharedPreferences(dependencies.preferences(includeSecret.value), includeSecret.value))
      const settings = await prepareSettings(chosen, sourceId, heads, localHash, signal)
      const updated = await updateCloudWorkspace(catalog, undefined, settings.revision)
      signal.throwIfAborted()
      const written = await dependencies.remote.writeCatalog(selected, updated, signal)
      signal.throwIfAborted()
      if (written.cleanupFailure) failure.value = written.cleanupFailure
      acceptBaseline(selected, settings.localHash, settings.cloudHash)
      notice.value = 'Shared settings choice saved. Other devices will receive it on their next sync.'
    })
  }

  async function openRevision(id: string): Promise<void> {
    await run(async (signal) => {
      const revision = revisions.value.find((candidate) => candidate.id === id)
      if (!revision) throw new Error('Sync first to refresh the cloud history list.')
      const snapshot = await downloadArchive(revision, dependencies.remote, signal, (message) => { progress.value = message })
      signal.throwIfAborted()
      await dependencies.importArchive(snapshot, true)
      signal.throwIfAborted()
      downloaded[revision.source.id] = revision.id
      autoSync.value = false
      persist()
      notice.value = 'Saved cloud history opened. Automatic sync is paused to keep this revision open. Sync now or enable automatic sync to receive the latest history again.'
    })
  }

  async function trashWorkspace(confirmedName: string): Promise<void> {
    await run(async (signal) => {
      const selected = requireWorkspace()
      if (confirmedName !== selected.name) throw new Error('Type the workspace name to confirm moving its cloud files to trash.')
      await dependencies.trashWorkspace(selected, signal)
      signal.throwIfAborted()
      workspaces.value = workspaces.value.filter((candidate) => candidate.id !== selected.id)
      switchWorkspace(null)
      notice.value = 'Cloud workspace moved to Google Drive trash. Local recordings and imported copies remain available.'
    })
  }

  async function run(operation: (signal: AbortSignal) => Promise<void>, mode: 'connect' | 'manual' | 'automatic' = 'manual'): Promise<void> {
    if (busy.value) return
    failure.value = null
    notice.value = null
    if (!enabled.value) {
      failure.value = 'Enable Google sync first.'
      return
    }
    if (mode !== 'connect' && !connected.value) {
      failure.value = 'Connect to Google to continue.'
      return
    }
    const controller = new AbortController()
    pending = controller
    busy.value = true
    try {
      // Connecting skips the lock so Google's popup still opens within the click.
      const locks = mode === 'connect' ? undefined : navigator.locks
      if (!locks) {
        await operation(controller.signal)
      } else {
        const ran = await locks.request('shunt-google-sync', { ifAvailable: true }, async (lock) => {
          if (lock) await operation(controller.signal)
          return lock !== null
        })
        if (!ran && mode === 'manual') notice.value = 'Another Shunt tab is syncing. Try again when it finishes.'
      }
    } catch (error) {
      if (!controller.signal.aborted) failure.value = describe(error)
      else if (mode === 'connect') failure.value = 'Google sign-in was cancelled.'
      else if (connected.value || !enabled.value) failure.value = 'Sync cancelled. Completed cloud uploads remain saved.'
      else failure.value = 'Google access ended. Connect again to continue syncing.'
    } finally {
      if (pending === controller) {
        pending = null
        busy.value = false
        progress.value = null
        const uploadRecording = recordingUploadPending && !controller.signal.aborted && canSyncAutomatically()
        recordingUploadPending = false
        if (uploadRecording) void syncNow(true, true)
      }
    }
  }

  function requireWorkspace(): CloudWorkspace {
    if (!workspace.value) throw new Error('Create or choose a cloud workspace first.')
    return workspace.value
  }

  function cancel(): void {
    recordingUploadPending = false
    pending?.abort()
  }
  function dispose(): void {
    active = false
    preparingGeneration++
    preparing.value = false
    clearInterval(interval)
    unsubscribe?.()
    unsubscribe = null
    unsubscribeRecording?.()
    unsubscribeRecording = null
    disconnect()
  }

  return { enabled, configured, prepared, preparing, connected, workspace, workspaces, revisions, sourceLabel,
    includeSecret, autoSync, busy, progress, failure, notice, lastSyncAt, conflicts, conflictReason,
    start, dispose, prepare, setEnabled, connect, disconnect, createWorkspace, selectWorkspace, chooseWorkspace, destination, chooseDestination,
    setSourceLabel, setIncludeSecret, setAutoSync, syncNow, cancel, openRevision, resolveSettings, trashWorkspace }
}

async function preferenceHash(preferences: readonly ArchivePreference[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(preferences)))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function samePreferences(left: readonly ArchivePreference[], right: readonly ArchivePreference[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Google sync failed. Try again when the connection is available.'
}

function unreadableArchiveMessage(count: number): string {
  return `${count} cloud archive files could not be read and were left untouched. Other saved copies remain available.`
}
