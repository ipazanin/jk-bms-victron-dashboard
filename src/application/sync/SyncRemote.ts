import type { CloudSnapshotRevision } from '../../domain/sync/CloudSnapshotRevision'
import type { CloudCatalog } from '../../domain/sync/CloudCatalog'
import type { CloudSettingsRevision } from '../../domain/sync/CloudSettingsRevision'
import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'

export interface SyncRemote {
  readCatalog(workspace: CloudWorkspace, signal: AbortSignal): Promise<CloudCatalog>
  downloadBlock(fileId: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>
  listPendingSnapshots(workspace: CloudWorkspace, sourceId: string, signal: AbortSignal): Promise<readonly CloudSnapshotRevision[]>
  uploadSnapshot(workspace: CloudWorkspace, bytes: Uint8Array, revision: Omit<CloudSnapshotRevision, 'snapshotFileId' | 'createdAt'>, signal: AbortSignal): Promise<CloudSnapshotRevision>
  completeSnapshot(workspace: CloudWorkspace, revision: CloudSnapshotRevision, signal: AbortSignal): Promise<void>
  deleteSnapshot(workspace: CloudWorkspace, revision: CloudSnapshotRevision, sourceId: string, signal: AbortSignal, state?: 'complete' | 'pending'): Promise<void>
  appendSettings(workspace: CloudWorkspace, revision: CloudSettingsRevision, signal: AbortSignal): Promise<void>
}
