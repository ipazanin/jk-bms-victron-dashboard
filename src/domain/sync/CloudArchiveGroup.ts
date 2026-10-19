import type { ArchiveStores } from '../backup/ArchiveStores'
import type { CloudBlock } from './CloudBlock'

export interface CloudArchiveGroup {
  readonly store: keyof ArchiveStores
  readonly key: string
  readonly blocks: readonly CloudBlock[]
  readonly decodedBytes?: number
}
