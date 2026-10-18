import type { ArchiveSource } from '../backup/ArchiveSource'

export interface CloudArchiveRevision {
  readonly id: string
  readonly source: ArchiveSource
  readonly exportedAt: number
  readonly manifestFileId: string
  readonly manifestHash: string
  readonly contentHash: string
  readonly sessions: number
  readonly samples: number
  readonly bytes: number
}
