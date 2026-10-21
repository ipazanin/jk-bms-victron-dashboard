export interface CloudWorkspace {
  readonly id: string
  readonly name: string
  readonly folderId: string
  readonly version?: 1 | 2 | 3
}
