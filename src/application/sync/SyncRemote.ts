import type { CloudArchiveRevision } from '../../domain/sync/CloudArchiveRevision'
import type { CloudBlock } from '../../domain/sync/CloudBlock'
import type { CloudCatalog } from '../../domain/sync/CloudCatalog'
import type { CloudSettingsRevision } from '../../domain/sync/CloudSettingsRevision'
import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'

export interface SyncRemote {
  readCatalog(workspace: CloudWorkspace, signal: AbortSignal): Promise<CloudCatalog>
  listBlocks(workspace: CloudWorkspace, signal: AbortSignal): Promise<readonly CloudBlock[]>
  uploadBlock(workspace: CloudWorkspace, bytes: Uint8Array, hash: string, signal: AbortSignal): Promise<CloudBlock>
  downloadBlock(fileId: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>
  appendArchive(workspace: CloudWorkspace, revision: CloudArchiveRevision, signal: AbortSignal): Promise<void>
  appendSettings(workspace: CloudWorkspace, revision: CloudSettingsRevision, signal: AbortSignal): Promise<void>
}
