export interface DriveFile {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly parents?: readonly string[]
  readonly appProperties?: Readonly<Record<string, string>>
  readonly size?: string
  readonly trashed?: boolean
}
