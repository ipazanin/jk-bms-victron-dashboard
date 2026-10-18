export interface ArchiveWorkbookFile {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly fileName: string
  readonly mimeType: string
  readonly partCount: number
}
