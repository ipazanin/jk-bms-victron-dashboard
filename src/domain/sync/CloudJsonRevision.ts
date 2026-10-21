import type { ArchiveSnapshot } from '../backup/ArchiveSnapshot'
import type { ArchiveSource } from '../backup/ArchiveSource'

export interface CloudJsonRevision {
  readonly storage: 'json'
  readonly id: string
  readonly source: ArchiveSource
  readonly exportedAt: number
  readonly createdAt: number
  readonly contentHash: string
  readonly sessions: number
  readonly samples: 0
  readonly hours: number
  readonly bytes: number
  readonly snapshot: ArchiveSnapshot
}
