import type { CloudArchiveRevision } from './CloudArchiveRevision'
import type { CloudSettingsRevision } from './CloudSettingsRevision'

export interface CloudCatalog {
  readonly archives: readonly CloudArchiveRevision[]
  readonly settings: readonly CloudSettingsRevision[]
}
