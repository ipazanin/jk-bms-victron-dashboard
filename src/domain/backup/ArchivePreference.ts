import type { ArchivePreferenceKey } from './ArchivePreferenceKey'

export interface ArchivePreference {
  readonly key: ArchivePreferenceKey
  readonly value: string
}
