import type { ArchiveSource } from '../backup/ArchiveSource'

export interface CloudSnapshotRevision {
  readonly storage: 'snapshot'
  readonly id: string
  readonly source: ArchiveSource
  readonly exportedAt: number
  readonly createdAt: number
  readonly snapshotFileId: string
  readonly snapshotHash: string
  readonly contentHash: string
  readonly sessions: number
  readonly samples: number
  readonly hours: number
  readonly bytes: number
  readonly storedBytes: number
}
