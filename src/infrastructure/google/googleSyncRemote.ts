import type { SyncRemote } from '../../application/sync/SyncRemote'
import type { ArchivePreference } from '../../domain/backup/ArchivePreference'
import type { CloudSnapshotRevision } from '../../domain/sync/CloudSnapshotRevision'
import type { CloudSettingsRevision } from '../../domain/sync/CloudSettingsRevision'
import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'
import { CLOUD_CATALOG_REVISIONS, CLOUD_SNAPSHOT_BYTES } from '../../domain/sync/limits'
import { SHARED_PREFERENCE_KEYS } from '../../domain/sync/sharedSettings'
import { validateCloudArchiveRevision, validateCloudCatalog, validateCloudSettingsRevision } from '../../domain/sync/syncValidation'
import type { DriveFile } from './DriveFile'
import { checkGoogleId, checkWorkspace, DRIVE_FIELDS, DRIVE_FILES, driveLiteral, getDriveFile, isShuntFile, listDriveFiles } from './googleDrive'
import { googleRequest, jsonRequest } from './googleRequest'
import { appendSheetRow, ARCHIVE_HEADER, readSheetRanges, SETTINGS_HEADER, tableBody } from './googleSheets'
import { validateGoogleWorkspace } from './googleWorkspaces'

export const remote: SyncRemote = {
  async readCatalog(workspace, signal) {
    const version = await validateGoogleWorkspace(workspace, signal)
    const tables = await readSheetRanges(workspace.id, version === 1
      ? [`'Archives'!A1:K${CLOUD_CATALOG_REVISIONS + 2}`, `'Settings'!A1:I${CLOUD_CATALOG_REVISIONS + 2}`]
      : [`'Settings'!A1:I${CLOUD_CATALOG_REVISIONS + 2}`], signal)
    let unreadableArchives = 0
    const snapshots: CloudSnapshotRevision[] = []
    if (version === 2) {
      const files = await listDriveFiles(`'${driveLiteral(workspace.folderId)}' in parents and trashed = false and appProperties has { key='shuntCloud' and value='1' } and (appProperties has { key='shuntRole' and value='snapshot' } or appProperties has { key='shuntRole' and value='pending-snapshot' })`, signal)
      for (const file of files) {
        const role = file.appProperties?.shuntRole === 'pending-snapshot' ? 'pending-snapshot' : 'snapshot'
        if (role === 'pending-snapshot' && (file.size === undefined || Number(file.size) < 1)) continue
        try {
          const revision = snapshotRevision(file, workspace, role)
          if (role === 'snapshot') snapshots.push(revision)
        } catch {
          unreadableArchives += 1
        }
      }
    }
    const revisionCounts = new Map<string, number>()
    for (const revision of snapshots) revisionCounts.set(revision.id, (revisionCounts.get(revision.id) ?? 0) + 1)
    const distinctSnapshots = snapshots.filter((revision) => {
      if (revisionCounts.get(revision.id) === 1) return true
      unreadableArchives += 1
      return false
    })
    const archives = version === 1
      ? tableBody(tables[0]!, ARCHIVE_HEADER).map((row) => ({
        id: row[0], source: { id: row[1], label: row[2] }, exportedAt: row[3], manifestFileId: row[4], manifestHash: row[5],
        contentHash: row[6], sessions: row[7], samples: row[8], bytes: row[9],
      }))
      : distinctSnapshots.sort(compareSnapshots)
    const settings = tableBody(tables[version === 1 ? 1 : 0]!, SETTINGS_HEADER).map((row) => {
      if (typeof row[2] !== 'string') throw new Error('The Google archive has invalid settings ancestry.')
      return {
        id: row[0], sourceId: row[1], parents: JSON.parse(row[2]) as unknown, createdAt: row[3],
        preferences: SHARED_PREFERENCE_KEYS.flatMap((key, index) => {
          const preference = row[index + 4]
          return preference === '' || preference === undefined ? [] : [{ key, value: preference }]
        }),
      }
    })
    const catalog = { archives, settings, ...(unreadableArchives > 0 ? { unreadableArchives } : {}) }
    validateCloudCatalog(catalog)
    return catalog
  },

  async listPendingSnapshots(workspace, sourceId, signal) {
    requireCompactWorkspace(workspace)
    const files = await listDriveFiles(`'${driveLiteral(workspace.folderId)}' in parents and trashed = false and appProperties has { key='shuntCloud' and value='1' } and appProperties has { key='shuntRole' and value='pending-snapshot' }`, signal)
    const pending: CloudSnapshotRevision[] = []
    for (const file of files) {
      if (Number(file.size) < 1 || file.size === undefined) continue
      try {
        const revision = snapshotRevision(file, workspace, 'pending-snapshot')
        if (revision.source.id === sourceId) pending.push(revision)
      } catch {
        continue
      }
    }
    return pending.sort(compareSnapshots)
  },

  async uploadSnapshot(workspace, bytes, revision, signal) {
    requireCompactWorkspace(workspace)
    if (bytes.byteLength < 1 || bytes.byteLength > CLOUD_SNAPSHOT_BYTES || bytes.byteLength !== revision.storedBytes) {
      throw new Error('The compact archive exceeds the Google upload limit or its declared size.')
    }
    validateCloudArchiveRevision({ ...revision, snapshotFileId: 'pending', createdAt: 0 })
    const metadata = {
      name: `shunt-${revision.id}.json.gz`, mimeType: 'application/gzip', parents: [workspace.folderId],
      description: JSON.stringify(revision),
      appProperties: { shuntCloud: '1', shuntRole: 'pending-snapshot', shuntWorkspace: workspace.folderId,
        shuntHash: revision.snapshotHash, shuntContentHash: revision.contentHash },
    }
    let response: Response
    const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files?fields=${DRIVE_FIELDS}`
    if (bytes.byteLength > 5 * 1024 * 1024) {
      const started = await googleRequest(`${uploadUrl}&uploadType=resumable`, signal, {
        ...jsonRequest('POST', metadata),
        headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/gzip', 'X-Upload-Content-Length': String(bytes.byteLength) },
      })
      const location = started.headers.get('Location')
      const destination = location ? new URL(location) : null
      if (!destination || destination.origin !== 'https://www.googleapis.com' || destination.pathname !== '/upload/drive/v3/files') {
        throw new Error('Google returned an invalid upload destination.')
      }
      response = await googleRequest(destination.href, signal, { method: 'PUT', headers: { 'Content-Type': 'application/gzip' }, body: bytes.slice().buffer })
    } else {
      const boundary = `shunt_${crypto.randomUUID()}`
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
        `--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`, bytes.slice().buffer,
        `\r\n--${boundary}--`,
      ])
      response = await googleRequest(`${uploadUrl}&uploadType=multipart`, signal, {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
      })
    }
    return snapshotRevision(await response.json() as DriveFile, workspace, 'pending-snapshot')
  },

  async downloadBlock(fileId, maxBytes, signal) {
    checkGoogleId(fileId)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CLOUD_SNAPSHOT_BYTES) throw new Error('The archive download limit is invalid.')
    const response = await googleRequest(`${DRIVE_FILES}/${encodeURIComponent(fileId)}?alt=media`, signal)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Google returned an empty archive file.')
    const bytes = new Uint8Array(maxBytes)
    let received = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        received += chunk.value.byteLength
        if (received > maxBytes) throw new Error('The downloaded archive exceeds its declared size.')
        bytes.set(chunk.value, received - chunk.value.byteLength)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    return bytes.slice(0, received)
  },

  async completeSnapshot(workspace, revision, signal) {
    requireCompactWorkspace(workspace)
    const file = await getDriveFile(revision.snapshotFileId, signal)
    const role = file.appProperties?.shuntRole === 'snapshot' ? 'snapshot' : 'pending-snapshot'
    const uploaded = snapshotRevision(file, workspace, role)
    if (uploaded.id !== revision.id || uploaded.source.id !== revision.source.id || uploaded.snapshotHash !== revision.snapshotHash) {
      throw new Error('The pending cloud snapshot no longer matches the verified upload.')
    }
    if (role === 'snapshot') return
    await googleRequest(`${DRIVE_FILES}/${encodeURIComponent(revision.snapshotFileId)}`, signal,
      jsonRequest('PATCH', { appProperties: { shuntRole: 'snapshot' } }))
  },

  async deleteSnapshot(workspace, revision, sourceId, signal, state = 'complete') {
    requireCompactWorkspace(workspace)
    validateCloudArchiveRevision(revision)
    checkGoogleId(revision.snapshotFileId)
    if (revision.source.id !== sourceId) throw new Error('Only this browser’s own cloud copies can be retired.')
    const response = await googleRequest(`${DRIVE_FILES}/${encodeURIComponent(revision.snapshotFileId)}?fields=${DRIVE_FIELDS}`, signal, undefined, [404])
    if (response.status === 404) return
    const saved = snapshotRevision(await response.json() as DriveFile, workspace, state === 'complete' ? 'snapshot' : 'pending-snapshot')
    if (saved.source.id !== sourceId || saved.id !== revision.id || saved.snapshotHash !== revision.snapshotHash
      || saved.contentHash !== revision.contentHash || saved.createdAt !== revision.createdAt) {
      throw new Error('The cloud copy changed before it could be retired. Nothing was deleted.')
    }
    await googleRequest(`${DRIVE_FILES}/${encodeURIComponent(revision.snapshotFileId)}`, signal, { method: 'DELETE' }, [404])
  },

  async appendSettings(workspace: CloudWorkspace, revision: CloudSettingsRevision, signal: AbortSignal) {
    requireCompactWorkspace(workspace)
    validateCloudSettingsRevision(revision)
    const preferences = new Map(revision.preferences.map((preference: ArchivePreference) => [preference.key, preference.value]))
    await appendSheetRow(workspace.id, 'Settings', [revision.id, revision.sourceId, JSON.stringify(revision.parents), revision.createdAt,
      ...SHARED_PREFERENCE_KEYS.map((key) => preferences.get(key) ?? '')], signal)
  },
}

function requireCompactWorkspace(workspace: CloudWorkspace): void {
  checkWorkspace(workspace)
  if (workspace.version !== 2) throw new Error('This legacy workspace is read-only. Create a compact workspace to sync.')
}

function snapshotRevision(file: DriveFile, workspace: CloudWorkspace, role: 'snapshot' | 'pending-snapshot'): CloudSnapshotRevision {
  checkGoogleId(file.id)
  if (!isShuntFile(file, role, 'application/gzip') || file.appProperties?.shuntWorkspace !== workspace.folderId
    || !file.parents?.includes(workspace.folderId) || typeof file.description !== 'string') {
    throw new Error('The Google archive contains invalid snapshot ownership or metadata.')
  }
  const revision: unknown = { ...JSON.parse(file.description), snapshotFileId: file.id, createdAt: Date.parse(file.createdTime ?? '') }
  validateCloudArchiveRevision(revision)
  if (revision.storage !== 'snapshot' || revision.storedBytes !== Number(file.size)
    || revision.snapshotHash !== file.appProperties.shuntHash || revision.contentHash !== file.appProperties.shuntContentHash) {
    throw new Error('The Google archive contains invalid snapshot size or checksums.')
  }
  return revision
}

function compareSnapshots(left: CloudSnapshotRevision, right: CloudSnapshotRevision): number {
  return left.createdAt - right.createdAt || (left.snapshotFileId < right.snapshotFileId ? -1 : left.snapshotFileId > right.snapshotFileId ? 1 : 0)
}
