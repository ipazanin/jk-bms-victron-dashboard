import type { ArchivePreference } from '../backup/ArchivePreference'

export interface CloudSettingsRevision {
  readonly id: string
  readonly sourceId: string
  readonly parents: readonly string[]
  readonly createdAt: number
  readonly preferences: readonly ArchivePreference[]
}
