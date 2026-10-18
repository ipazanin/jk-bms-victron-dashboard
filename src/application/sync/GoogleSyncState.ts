import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'

export interface GoogleSyncState {
  readonly enabled: boolean
  readonly autoSync: boolean
  readonly includeSecret: boolean
  readonly sourceLabel: string
  readonly workspace: CloudWorkspace | null
  readonly lastSyncAt: number | null
  readonly settingsBaseline: { readonly workspaceId: string, readonly localHash: string, readonly cloudHash: string } | null
  readonly downloaded: Readonly<Record<string, string>>
}
