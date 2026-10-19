import { archivePreference } from '../backup/preferenceValidation'
import { bounded, choice, list, record, requireArchive, shape, text } from '../backup/validation'
import { CLOUD_ARCHIVE_STORES } from './cloudArchiveStores'
import type { CloudArchiveManifest } from './CloudArchiveManifest'
import { CLOUD_ARCHIVE_BYTES, CLOUD_BLOCK_BYTES, CLOUD_MANIFEST_GROUPS } from './limits'
import { cloudHash, cloudIdentity } from './syncValidation'

export function validateCloudArchiveManifest(input: unknown): asserts input is CloudArchiveManifest {
  const version = record(input, 'cloud manifest').version
  requireArchive(version === 1 || version === 2, 'cloud manifest.version', 'update the app to open this cloud archive version')
  shape({
    format: choice('shunt-cloud-archive'), version: choice(1, 2),
    source: shape({ id: cloudIdentity, label: cloudIdentity }, true), preferences: list(archivePreference),
    groups: list(shape({
      store: choice(...CLOUD_ARCHIVE_STORES), key: text,
      blocks: list(shape({ hash: cloudHash, fileId: cloudIdentity, size: bounded(1, CLOUD_BLOCK_BYTES, true) }, true)),
      ...(version === 2 ? { decodedBytes: bounded(1, CLOUD_ARCHIVE_BYTES, true) } : {}),
    }, true)),
  }, true)(input, 'cloud manifest')
  const manifest = input as CloudArchiveManifest
  requireArchive(manifest.groups.length <= CLOUD_MANIFEST_GROUPS, 'cloud manifest.groups', 'too many groups')
  const identities = new Set<string>()
  let bytes = 0
  let decodedBytes = 0
  for (const group of manifest.groups) {
    const key = JSON.stringify([group.store, group.key])
    requireArchive(!identities.has(key), 'cloud manifest.groups', 'duplicate group')
    identities.add(key)
    requireArchive(group.blocks.length > 0, 'cloud manifest.blocks', 'empty group')
    for (const block of group.blocks) bytes += block.size
    if (manifest.version === 2) decodedBytes += group.decodedBytes!
  }
  requireArchive(bytes <= CLOUD_ARCHIVE_BYTES, 'cloud manifest.blocks', 'archive exceeds download limit')
  requireArchive(decodedBytes <= CLOUD_ARCHIVE_BYTES, 'cloud manifest.groups', 'decoded archive exceeds download limit')
}
