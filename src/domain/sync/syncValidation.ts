import { archivePreference } from '../backup/preferenceValidation'
import { bounded, choice, count, identity, list, optional, record, requireArchive, shape, timestamp } from '../backup/validation'
import type { CloudArchiveRevision } from './CloudArchiveRevision'
import type { CloudCatalog } from './CloudCatalog'
import type { CloudSettingsRevision } from './CloudSettingsRevision'
import { CLOUD_ARCHIVE_BYTES, CLOUD_CATALOG_REVISIONS, CLOUD_SNAPSHOT_BYTES } from './limits'
import { sharedPreferences } from './sharedSettings'

export function cloudIdentity(input: unknown, path: string): void {
  identity(input, path)
  requireArchive((input as string).length <= 1024, path, 'identity exceeds 1024 characters')
}

export function cloudHash(input: unknown, path: string): void {
  requireArchive(typeof input === 'string' && /^[a-f0-9]{64}$/.test(input), path, 'expected a SHA-256 hash')
}

export function validateCloudArchiveRevision(input: unknown): asserts input is CloudArchiveRevision {
  if (record(input, 'cloud archive').storage === 'snapshot') {
    shape({
      storage: choice('snapshot'), id: cloudIdentity, source: shape({ id: cloudIdentity, label: cloudIdentity }, true),
      exportedAt: timestamp, createdAt: timestamp, snapshotFileId: cloudIdentity, snapshotHash: cloudHash, contentHash: cloudHash,
      sessions: count, samples: choice(0), hours: count, bytes: bounded(1, CLOUD_ARCHIVE_BYTES, true),
      storedBytes: bounded(1, CLOUD_SNAPSHOT_BYTES, true),
    }, true)(input, 'cloud snapshot')
    return
  }
  shape({
    storage: optional(choice('blocks')),
    id: cloudIdentity, source: shape({ id: cloudIdentity, label: cloudIdentity }, true), exportedAt: timestamp,
    manifestFileId: cloudIdentity, manifestHash: cloudHash, contentHash: cloudHash,
    sessions: count, samples: count, bytes: bounded(0, CLOUD_ARCHIVE_BYTES, true),
  }, true)(input, 'cloud archive')
}

export function validateCloudSettingsRevision(input: unknown): asserts input is CloudSettingsRevision {
  shape({ id: cloudIdentity, sourceId: cloudIdentity, parents: list(cloudIdentity), createdAt: timestamp, preferences: list(archivePreference) }, true)(input, 'cloud settings')
  const revision = input as CloudSettingsRevision
  requireArchive(revision.parents.length <= CLOUD_CATALOG_REVISIONS, 'cloud settings.parents', 'too many parents')
  requireArchive(new Set(revision.parents).size === revision.parents.length && !revision.parents.includes(revision.id), 'cloud settings.parents', 'invalid ancestry')
  requireArchive(revision.preferences.length <= 4 && sharedPreferences(revision.preferences, true).length === revision.preferences.length, 'cloud settings.preferences', 'settings are not shared')
  requireArchive(new Set(revision.preferences.map((preference) => preference.key)).size === revision.preferences.length, 'cloud settings.preferences', 'duplicate preference')
}

export function validateCloudCatalog(input: unknown): asserts input is CloudCatalog {
  const catalog = record(input, 'cloud catalogue')
  for (const key of ['archives', 'settings'] as const) {
    requireArchive(Array.isArray(catalog[key]) && catalog[key].length <= CLOUD_CATALOG_REVISIONS, `cloud catalogue.${key}`, 'too many revisions or invalid list')
  }
  shape({ archives: list(validateCloudArchiveRevision), settings: list(validateCloudSettingsRevision), unreadableArchives: optional(count) }, true)(input, 'cloud catalogue')
  const valid = input as CloudCatalog
  for (const revisions of [valid.archives, valid.settings]) {
    requireArchive(new Set(revisions.map((revision) => revision.id)).size === revisions.length, 'cloud catalogue', 'duplicate revision')
  }
  const settingsIds = new Set(valid.settings.map((revision) => revision.id))
  for (const revision of valid.settings) {
    requireArchive(revision.parents.every((parent) => settingsIds.has(parent)), 'cloud settings.parents', 'missing parent revision')
  }
  const remainingParents = new Map(valid.settings.map((revision) => [revision.id, revision.parents.length]))
  const children = new Map<string, string[]>()
  for (const revision of valid.settings) {
    for (const parent of revision.parents) {
      const descendants = children.get(parent) ?? []
      descendants.push(revision.id)
      children.set(parent, descendants)
    }
  }
  const ready = valid.settings.filter((revision) => revision.parents.length === 0).map((revision) => revision.id)
  for (let index = 0; index < ready.length; index += 1) {
    for (const child of children.get(ready[index]!) ?? []) {
      const remaining = remainingParents.get(child)! - 1
      remainingParents.set(child, remaining)
      if (remaining === 0) ready.push(child)
    }
  }
  requireArchive(ready.length === valid.settings.length, 'cloud settings.parents', 'cyclic ancestry')
}
