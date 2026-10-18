import type { ArchivePreference } from '../backup/ArchivePreference'
import type { CloudSettingsRevision } from './CloudSettingsRevision'

export const SHARED_PREFERENCE_KEYS = ['shunt.theme', 'shunt.sidebar', 'shunt.statsPreferences', 'victron.advertisementKey'] as const

export function sharedPreferences(preferences: readonly ArchivePreference[], includeSecret: boolean): readonly ArchivePreference[] {
  return preferences.filter((preference) => {
    return SHARED_PREFERENCE_KEYS.some((key) => key === preference.key)
      && (includeSecret || preference.key !== 'victron.advertisementKey')
  }).sort((left, right) => left.key.localeCompare(right.key))
}

export function settingsHeads(revisions: readonly CloudSettingsRevision[]): readonly CloudSettingsRevision[] {
  const parents = new Set(revisions.flatMap((revision) => revision.parents))
  return revisions.filter((revision) => !parents.has(revision.id))
}

export function createSettingsRevision(
  preferences: readonly ArchivePreference[], sourceId: string, parents: readonly string[], createdAt = Date.now(),
): CloudSettingsRevision {
  return { id: crypto.randomUUID(), sourceId, parents: [...new Set(parents)], createdAt, preferences }
}
