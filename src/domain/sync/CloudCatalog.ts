import type { CloudDocumentFile } from './CloudDocumentFile'
import type { CloudArchiveRevision } from './CloudArchiveRevision'
import type { CloudSettingsRevision } from './CloudSettingsRevision'

export interface CloudCatalog {
  readonly archives: readonly CloudArchiveRevision[]
  readonly settings: readonly CloudSettingsRevision[]
  readonly cleanupFailure?: string
  readonly documents?: readonly CloudDocumentFile[]
  readonly unreadableArchives?: number
}
