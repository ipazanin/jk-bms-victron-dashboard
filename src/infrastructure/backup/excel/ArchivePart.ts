import type { TableRecord } from './TableRecord'

export interface ArchivePart {
  readonly manifest: TableRecord
  readonly records: Record<string, TableRecord[]>
  readonly chunks: TableRecord[]
  readonly storedRows: { readonly ringRecords: TableRecord[], readonly ringReads: TableRecord[] }
}
