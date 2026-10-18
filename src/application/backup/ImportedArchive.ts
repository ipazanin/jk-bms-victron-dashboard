import type { ArchivePreference } from '../../domain/backup/ArchivePreference'
import type { ArchiveSource } from '../../domain/backup/ArchiveSource'

export interface ImportedArchive {
  readonly source: ArchiveSource
  readonly exportedAt: number
  readonly importedAt: number
  readonly preferences: readonly ArchivePreference[]
}
