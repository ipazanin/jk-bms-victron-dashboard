import type { ArchiveSnapshot } from '../../../domain/backup/ArchiveSnapshot'

export type ArchiveWorkerRequest =
  | { readonly operation: 'export', readonly snapshots: readonly ArchiveSnapshot[] }
  | { readonly operation: 'import', readonly bytes: ArrayBuffer }
