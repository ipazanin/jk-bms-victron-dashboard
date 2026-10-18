import { archivePreference } from '../backup/preferenceValidation'
import { bounded, choice, list, requireArchive, shape, text } from '../backup/validation'
import { CLOUD_ARCHIVE_STORES } from './archiveGroups'
import type { CloudArchiveManifest } from './CloudArchiveManifest'
import { CLOUD_ARCHIVE_BYTES, CLOUD_BLOCK_BYTES, CLOUD_MANIFEST_GROUPS } from './limits'
import { cloudHash, cloudIdentity } from './syncValidation'

export function validateCloudArchiveManifest(input: unknown): asserts input is CloudArchiveManifest {
  shape({
    format: choice('shunt-cloud-archive'), version: choice(1),
    source: shape({ id: cloudIdentity, label: cloudIdentity }, true), preferences: list(archivePreference),
    groups: list(shape({ store: choice(...CLOUD_ARCHIVE_STORES), key: text, blocks: list(shape({ hash: cloudHash, fileId: cloudIdentity, size: bounded(1, CLOUD_BLOCK_BYTES, true) }, true)) }, true)),
  }, true)(input, 'cloud manifest')
  const manifest = input as CloudArchiveManifest
  requireArchive(manifest.groups.length <= CLOUD_MANIFEST_GROUPS, 'cloud manifest.groups', 'too many groups')
  const identities = new Set<string>()
  let bytes = 0
  for (const group of manifest.groups) {
    const key = JSON.stringify([group.store, group.key])
    requireArchive(!identities.has(key), 'cloud manifest.groups', 'duplicate group')
    identities.add(key)
    requireArchive(group.blocks.length > 0, 'cloud manifest.blocks', 'empty group')
    for (const block of group.blocks) bytes += block.size
  }
  requireArchive(bytes <= CLOUD_ARCHIVE_BYTES, 'cloud manifest.blocks', 'archive exceeds download limit')
}
