import type { ArchiveWorkbookProgress } from './ArchiveWorkbookProgress'

export interface ArchiveWorkbookJobOptions {
  readonly onProgress?: (progress: ArchiveWorkbookProgress) => void
  readonly signal?: AbortSignal
}
