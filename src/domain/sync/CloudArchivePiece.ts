import type { CloudJsonRevision } from './CloudJsonRevision'

export interface CloudArchivePiece extends CloudJsonRevision {
  readonly part: number
  readonly parts: number
}
