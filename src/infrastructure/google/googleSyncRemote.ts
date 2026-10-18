import type { SyncRemote } from '../../application/sync/SyncRemote'
import type { ArchivePreference } from '../../domain/backup/ArchivePreference'
import type { CloudArchiveRevision } from '../../domain/sync/CloudArchiveRevision'
import type { CloudBlock } from '../../domain/sync/CloudBlock'
import type { CloudSettingsRevision } from '../../domain/sync/CloudSettingsRevision'
import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'
import { CLOUD_BLOCK_BYTES, CLOUD_CATALOG_REVISIONS } from '../../domain/sync/limits'
import { SHARED_PREFERENCE_KEYS } from '../../domain/sync/sharedSettings'
import { cloudHash, validateCloudArchiveRevision, validateCloudCatalog, validateCloudSettingsRevision } from '../../domain/sync/syncValidation'
import { checkGoogleId, checkWorkspace, DRIVE_FIELDS, driveLiteral, isShuntFile, listDriveFiles } from './googleDrive'
import { googleRequest } from './googleRequest'
import { appendSheetRow, ARCHIVE_HEADER, readSheetRanges, SETTINGS_HEADER, tableBody } from './googleSheets'
import { validateGoogleWorkspace } from './googleWorkspaces'

export const remote: SyncRemote = {
  async readCatalog(workspace, signal) {
    await validateGoogleWorkspace(workspace, signal)
    const tables = await readSheetRanges(workspace.id, [
      `'Archives'!A1:K${CLOUD_CATALOG_REVISIONS + 2}`, `'Settings'!A1:I${CLOUD_CATALOG_REVISIONS + 2}`,
    ], signal)
    const archives = tableBody(tables[0]!, ARCHIVE_HEADER).map((row) => ({
      id: row[0], source: { id: row[1], label: row[2] }, exportedAt: row[3], manifestFileId: row[4], manifestHash: row[5],
      contentHash: row[6], sessions: row[7], samples: row[8], bytes: row[9],
    }))
    const settings = tableBody(tables[1]!, SETTINGS_HEADER).map((row) => {
      if (typeof row[2] !== 'string') throw new Error('The Google archive has invalid settings ancestry.')
      return {
        id: row[0], sourceId: row[1], parents: JSON.parse(row[2]) as unknown, createdAt: row[3],
        preferences: SHARED_PREFERENCE_KEYS.flatMap((key, index) => {
          const preference = row[index + 4]
          return preference === '' || preference === undefined ? [] : [{ key, value: preference }]
        }),
      }
    })
    const catalog = { archives, settings }
    validateCloudCatalog(catalog)
    return catalog
  },

  async listBlocks(workspace, signal) {
    checkWorkspace(workspace)
    const files = await listDriveFiles(`'${driveLiteral(workspace.folderId)}' in parents and trashed = false and appProperties has { key='shuntCloud' and value='1' } and appProperties has { key='shuntRole' and value='block' }`, signal)
    return files.map((file) => {
      const hash = file.appProperties?.shuntHash
      cloudHash(hash, 'cloud block.hash')
      const size = Number(file.size)
      if (!isShuntFile(file, 'block', 'application/octet-stream') || file.appProperties?.shuntWorkspace !== workspace.folderId
        || !file.parents?.includes(workspace.folderId) || !Number.isSafeInteger(size) || size < 1 || size > CLOUD_BLOCK_BYTES) {
        throw new Error('The Google archive contains an invalid archive block.')
      }
      checkGoogleId(file.id)
      return { hash: hash as string, fileId: file.id, size }
    })
  },

  async uploadBlock(workspace, bytes, hash, signal): Promise<CloudBlock> {
    checkWorkspace(workspace)
    cloudHash(hash, 'cloud block.hash')
    if (bytes.byteLength < 1 || bytes.byteLength > CLOUD_BLOCK_BYTES) throw new Error('The archive block exceeds the Google upload limit.')
    const boundary = `shunt_${crypto.randomUUID()}`
    const metadata = {
      name: `${hash}.bin`, mimeType: 'application/octet-stream', parents: [workspace.folderId],
      appProperties: { shuntCloud: '1', shuntRole: 'block', shuntWorkspace: workspace.folderId, shuntHash: hash },
    }
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`, bytes.slice().buffer,
      `\r\n--${boundary}--`,
    ])
    const response = await googleRequest(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${DRIVE_FIELDS}`, signal, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    })
    const file = await response.json() as { id: string }
    checkGoogleId(file.id)
    return { hash, fileId: file.id, size: bytes.byteLength }
  },

  async downloadBlock(fileId, maxBytes, signal) {
    checkGoogleId(fileId)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CLOUD_BLOCK_BYTES) throw new Error('The archive block download limit is invalid.')
    const response = await googleRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, signal)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Google returned an empty archive block.')
    const bytes = new Uint8Array(maxBytes)
    let received = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        received += chunk.value.byteLength
        if (received > maxBytes) throw new Error('The downloaded archive block exceeds its declared size.')
        bytes.set(chunk.value, received - chunk.value.byteLength)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    return bytes.slice(0, received)
  },

  async appendArchive(workspace: CloudWorkspace, revision: CloudArchiveRevision, signal: AbortSignal) {
    checkWorkspace(workspace)
    validateCloudArchiveRevision(revision)
    await appendSheetRow(workspace.id, 'Archives', [revision.id, revision.source.id, revision.source.label, revision.exportedAt,
      revision.manifestFileId, revision.manifestHash, revision.contentHash, revision.sessions, revision.samples, revision.bytes], signal)
  },

  async appendSettings(workspace: CloudWorkspace, revision: CloudSettingsRevision, signal: AbortSignal) {
    checkWorkspace(workspace)
    validateCloudSettingsRevision(revision)
    const preferences = new Map(revision.preferences.map((preference: ArchivePreference) => [preference.key, preference.value]))
    await appendSheetRow(workspace.id, 'Settings', [revision.id, revision.sourceId, JSON.stringify(revision.parents), revision.createdAt,
      ...SHARED_PREFERENCE_KEYS.map((key) => preferences.get(key) ?? '')], signal)
  },
}
