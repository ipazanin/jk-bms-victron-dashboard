export interface ArchiveWorkbookProgress {
  readonly phase: 'export' | 'import'
  readonly completedParts: number
  readonly totalParts: number
}
