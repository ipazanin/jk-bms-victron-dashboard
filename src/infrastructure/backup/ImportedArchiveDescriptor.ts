import type { ImportedArchive } from '../../application/backup/ImportedArchive'

export interface ImportedArchiveDescriptor extends ImportedArchive {
  readonly key: 'snapshot'
  readonly version?: 1 | 2
}
