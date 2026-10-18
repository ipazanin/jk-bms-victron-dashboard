import type { ArchiveWorkbookProgress } from './ArchiveWorkbookProgress'

export interface ArchiveWorkbookOptions {
  readonly sampleRowsPerPart?: number
  readonly metadataRowsPerPart?: number
  readonly archiveId?: string
  readonly onProgress?: (progress: ArchiveWorkbookProgress) => void
}
