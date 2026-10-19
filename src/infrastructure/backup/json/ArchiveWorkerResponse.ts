import type { ArchiveSnapshot } from '../../../domain/backup/ArchiveSnapshot'
import type { exportArchiveJson } from './archiveJson'

export type ArchiveWorkerResponse =
  | { readonly kind: 'exported', readonly file: ReturnType<typeof exportArchiveJson> }
  | { readonly kind: 'imported', readonly snapshots: readonly ArchiveSnapshot[] }
  | { readonly kind: 'error', readonly message: string }
