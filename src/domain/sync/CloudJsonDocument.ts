import type { CloudArchivePiece } from './CloudArchivePiece'
import type { CloudSettingsRevision } from './CloudSettingsRevision'

export interface CloudJsonDocument {
  readonly format: 'shunt-cloud-workspace'
  readonly version: 3
  readonly publicationId: string
  readonly index: number
  readonly count: number
  readonly archives: readonly CloudArchivePiece[]
  readonly settings: readonly CloudSettingsRevision[]
}
