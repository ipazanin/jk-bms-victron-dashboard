import type { CloudCatalog } from '../../domain/sync/CloudCatalog'
import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'

export interface SyncRemote {
  readCatalog(workspace: CloudWorkspace, signal: AbortSignal): Promise<CloudCatalog>
  writeCatalog(workspace: CloudWorkspace, catalog: CloudCatalog, signal: AbortSignal): Promise<CloudCatalog>
  downloadBlock(fileId: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>
}
