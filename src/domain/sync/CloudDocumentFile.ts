export interface CloudDocumentFile {
  readonly retired?: true
  readonly id: string
  readonly publicationId: string
  readonly index: number
  readonly count: number
  readonly hash: string
  readonly bytes: number
}
