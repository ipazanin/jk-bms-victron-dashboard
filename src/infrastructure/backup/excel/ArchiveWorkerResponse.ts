import type { ArchiveSnapshot } from '../../../domain/backup/ArchiveSnapshot'
import type { ArchiveWorkbookProgress } from './ArchiveWorkbookProgress'
import type { ArchiveWorkbookFile } from './ArchiveWorkbookFile'

export type ArchiveWorkerResponse =
  | { readonly kind: 'progress', readonly progress: ArchiveWorkbookProgress }
  | { readonly kind: 'exported', readonly file: ArchiveWorkbookFile }
  | { readonly kind: 'imported', readonly snapshots: readonly ArchiveSnapshot[] }
  | { readonly kind: 'error', readonly message: string }
