import type { ArchivePreference } from '../../domain/backup/ArchivePreference'
import type { ArchiveSnapshot } from '../../domain/backup/ArchiveSnapshot'
import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'
import type { ImportedArchive } from '../backup/ImportedArchive'
import type { GoogleSyncState } from './GoogleSyncState'
import type { SyncRemote } from './SyncRemote'

export interface GoogleSyncDependencies {
  readonly remote: SyncRemote
  configured(): boolean
  load(): GoogleSyncState
  save(state: GoogleSyncState): void
  prepare(): Promise<void>
  authorize(): Promise<void>
  forgetAccess(): void
  subscribeAccess(listener: (connected: boolean) => void): () => void
  listWorkspaces(signal: AbortSignal): Promise<readonly CloudWorkspace[]>
  createWorkspace(name: string, signal: AbortSignal): Promise<CloudWorkspace>
  chooseWorkspace(signal: AbortSignal): Promise<CloudWorkspace | null>
  trashWorkspace(workspace: CloudWorkspace, signal: AbortSignal): Promise<void>
  capture(includeSecret: boolean): Promise<ArchiveSnapshot>
  sourceId(): string | null
  importArchive(snapshot: ArchiveSnapshot, select: boolean): Promise<void>
  imported(): readonly ImportedArchive[]
  preferences(includeSecret: boolean): readonly ArchivePreference[]
  applyPreferences(preferences: readonly ArchivePreference[], includeSecret: boolean): void
  radiosBusy(): boolean
  subscribeRecordingEnd(listener: () => void): () => void
  recording(): boolean
  now(): number
}
