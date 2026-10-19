import type { ArchivePreference } from '../backup/ArchivePreference'
import type { ArchiveSource } from '../backup/ArchiveSource'
import type { CloudArchiveGroup } from './CloudArchiveGroup'

export interface CloudArchiveManifest {
  readonly format: 'shunt-cloud-archive'
  readonly version: 1 | 2
  readonly source: ArchiveSource
  readonly preferences: readonly ArchivePreference[]
  readonly groups: readonly CloudArchiveGroup[]
}
