import type { ArchivePreference } from '../../domain/backup/ArchivePreference'
import type { ArchiveSnapshot } from '../../domain/backup/ArchiveSnapshot'
import type { ArchiveSource } from '../../domain/backup/ArchiveSource'
import type { HistoryStore } from '../history/port'
import type { ImportedArchive } from './ImportedArchive'

export interface ArchiveRepository {
  readonly source: ArchiveSource
  capture(preferences: readonly ArchivePreference[]): Promise<ArchiveSnapshot>
  listImported(): Promise<readonly ImportedArchive[]>
  importArchive(snapshot: ArchiveSnapshot): Promise<ImportedArchive>
  readImported(sourceId: string): Promise<ArchiveSnapshot>
  openImported(sourceId: string): Promise<HistoryStore>
  restoreLocal(snapshot: ArchiveSnapshot, confirmation: 'replace'): Promise<void>
  close(): void
}
