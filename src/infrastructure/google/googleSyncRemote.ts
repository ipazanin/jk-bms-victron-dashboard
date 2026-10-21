import type { SyncRemote } from '../../application/sync/SyncRemote'
import type { CloudSnapshotRevision } from '../../domain/sync/CloudSnapshotRevision'
import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'
import { CLOUD_CATALOG_REVISIONS } from '../../domain/sync/limits'
import { SHARED_PREFERENCE_KEYS } from '../../domain/sync/sharedSettings'
import { validateCloudArchiveRevision, validateCloudCatalog } from '../../domain/sync/syncValidation'
import type { DriveFile } from './DriveFile'
import { checkGoogleId, driveLiteral, isShuntFile, listDriveFiles } from './googleDrive'
import { ARCHIVE_HEADER, readSheetRanges, SETTINGS_HEADER, tableBody } from './googleSheets'
import { validateGoogleWorkspace } from './googleWorkspaces'
import { downloadGoogleArchive } from './googleDriveBytes'
import { readJsonWorkspace, writeJsonWorkspace } from './googleWorkspaceDocuments'

export const remote: SyncRemote = {
  async readCatalog(workspace, signal) {
    const version = await validateGoogleWorkspace(workspace, signal)
    if (version === 3) return readJsonWorkspace(workspace, signal)
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

  downloadBlock: downloadGoogleArchive,
  writeCatalog: writeJsonWorkspace,
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
