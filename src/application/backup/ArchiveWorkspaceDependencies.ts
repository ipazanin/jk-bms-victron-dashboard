import type { ArchiveSnapshot } from '../../domain/backup/ArchiveSnapshot'
import type { ArchiveRepository } from './ArchiveRepository'
import type { HistoryStore } from '../history/port'

export interface ArchiveWorkspaceDependencies {
  readonly openRepository: (databaseName: string, label: string) => Promise<ArchiveRepository>
  readonly showHistory: (store: HistoryStore, capturedAt?: number) => void
  readonly radiosBusy: () => boolean
  readonly preferencesChanged: () => void
  readonly exportFile: (snapshots: readonly ArchiveSnapshot[], signal: AbortSignal) => Promise<void>
  readonly importFile: (file: File, signal: AbortSignal) => Promise<readonly ArchiveSnapshot[]>
}
