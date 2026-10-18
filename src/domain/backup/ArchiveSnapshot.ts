import type { ArchivePreference } from './ArchivePreference'
import type { ArchiveSource } from './ArchiveSource'
import type { ArchiveStores } from './ArchiveStores'

export interface ArchiveSnapshot {
  readonly format: 'shunt-archive'
  readonly version: 1
  readonly exportedAt: number
  readonly source: ArchiveSource
  readonly stores: ArchiveStores
  readonly preferences: readonly ArchivePreference[]
}
