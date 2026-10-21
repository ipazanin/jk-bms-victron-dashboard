import { decodeArchiveValue, encodeArchiveValue, validateArchiveSnapshot } from '../../domain/backup/archiveCodec'
import type { ArchiveSnapshot } from '../../domain/backup/ArchiveSnapshot'
import type { ArchiveStores } from '../../domain/backup/ArchiveStores'
import { requireArchive } from '../../domain/backup/validation'
import { CLOUD_ARCHIVE_STORES } from '../../domain/sync/cloudArchiveStores'
import type { CloudArchiveManifest } from '../../domain/sync/CloudArchiveManifest'
import type { CloudArchiveRevision } from '../../domain/sync/CloudArchiveRevision'
import { CLOUD_BLOCK_BYTES } from '../../domain/sync/limits'
import { validateCloudArchiveManifest } from '../../domain/sync/manifestValidation'
import { validateCloudArchiveRevision } from '../../domain/sync/syncValidation'
import type { SyncRemote } from './SyncRemote'
import { decompressArchiveBytes } from '../backup/archiveCompression'
import { hashCloudBytes, verifyJsonRevision } from './cloudWorkspaceJson'

export async function downloadArchive(
  revision: CloudArchiveRevision, remote: SyncRemote, signal: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<ArchiveSnapshot> {
  validateCloudArchiveRevision(revision)
  signal.throwIfAborted()
  if (revision.storage === 'json') {
    await verifyJsonRevision(revision)
    return revision.snapshot
  }
  if (revision.storage === 'snapshot') {
    const compressed = await remote.downloadBlock(revision.snapshotFileId, revision.storedBytes, signal)
    requireArchive(compressed.byteLength === revision.storedBytes && await hashCloudBytes(compressed) === revision.snapshotHash, 'cloud snapshot', 'archive checksum does not match')
    const decoded = decompressArchiveBytes(compressed, revision.bytes)
    requireArchive(decoded.byteLength === revision.bytes, 'cloud snapshot', 'decoded size does not match')
    const snapshot = decodeArchiveValue(new TextDecoder('utf-8', { fatal: true }).decode(decoded))
    validateArchiveSnapshot(snapshot)
    requireArchive(snapshot.version === 2 && snapshot.stores.chunks.length === 0, 'cloud snapshot', 'expected compact history without raw recordings')
    requireArchive(snapshot.source.id === revision.source.id && snapshot.source.label === revision.source.label
      && snapshot.exportedAt === revision.exportedAt, 'cloud snapshot', 'archive source or capture time does not match')
    requireArchive(snapshot.stores.sessions.length === revision.sessions && snapshot.stores.hours!.length === revision.hours,
      'cloud snapshot', 'archive totals do not match')
    requireArchive(await snapshotContentHash(snapshot) === revision.contentHash, 'cloud snapshot', 'archive content checksum does not match')
    return snapshot
  }
  const encoded = await remote.downloadBlock(revision.manifestFileId, CLOUD_BLOCK_BYTES, signal)
  requireArchive(encoded.byteLength <= CLOUD_BLOCK_BYTES && await hashCloudBytes(encoded) === revision.manifestHash, 'cloud manifest', 'manifest checksum does not match')
  const manifest = decodeArchiveValue(new TextDecoder('utf-8', { fatal: true }).decode(encoded))
  validateCloudArchiveManifest(manifest)
  requireArchive(manifest.source.id === revision.source.id && manifest.source.label === revision.source.label, 'cloud manifest', 'archive source does not match')
  requireArchive(await contentHashOf(manifest) === revision.contentHash, 'cloud manifest', 'archive content checksum does not match')
  requireArchive(manifest.groups.reduce((total, group) => total + (manifest.version === 2 ? group.decodedBytes! : group.blocks.reduce((sum, block) => sum + block.size, 0)), 0) === revision.bytes,
    'cloud catalogue', 'archive byte total does not match')
  const stores = Object.fromEntries(CLOUD_ARCHIVE_STORES.map((store) => [store, []])) as unknown as Record<keyof ArchiveStores, unknown[]>
  let bytes = 0
  for (const group of manifest.groups) {
    signal.throwIfAborted()
    onProgress?.(`Downloading ${group.store}…`)
    const combined = new Uint8Array(group.blocks.reduce((total, block) => total + block.size, 0))
    let offset = 0
    for (const block of group.blocks) {
      signal.throwIfAborted()
      const part = await remote.downloadBlock(block.fileId, block.size, signal)
      requireArchive(part.byteLength === block.size && await hashCloudBytes(part) === block.hash, 'cloud block', 'archive checksum does not match')
      combined.set(part, offset)
      offset += part.byteLength
    }
    signal.throwIfAborted()
    const decoded = manifest.version === 2 ? decompressArchiveBytes(combined, group.decodedBytes!) : combined
    requireArchive(manifest.version === 1 || decoded.byteLength === group.decodedBytes, 'cloud group', 'decoded size does not match')
    bytes += decoded.byteLength
    const rows = decodeArchiveValue(new TextDecoder('utf-8', { fatal: true }).decode(decoded))
    requireArchive(Array.isArray(rows), 'cloud block', 'expected archive rows')
    for (const row of rows) stores[group.store].push(row)
  }
  signal.throwIfAborted()
  const snapshot: ArchiveSnapshot = {
    format: 'shunt-archive', version: 1, source: manifest.source, exportedAt: revision.exportedAt,
    stores: stores as unknown as ArchiveStores, preferences: manifest.preferences,
  }
  validateArchiveSnapshot(snapshot)
  requireArchive(bytes === revision.bytes && snapshot.stores.sessions.length === revision.sessions
    && snapshot.stores.chunks.reduce((total, chunk) => total + chunk.length, 0) === revision.samples,
  'cloud catalogue', 'archive totals do not match')
  return snapshot
}

async function contentHashOf(manifest: CloudArchiveManifest): Promise<string> {
  return hashCloudBytes(new TextEncoder().encode(encodeArchiveValue({
    ...manifest,
    groups: manifest.groups.map((group) => ({ ...group, blocks: group.blocks.map((block) => ({ hash: block.hash, size: block.size })) })),
  })))
}

async function snapshotContentHash(snapshot: ArchiveSnapshot): Promise<string> {
  const { exportedAt: _exportedAt, ...content } = snapshot
  return hashCloudBytes(new TextEncoder().encode(encodeArchiveValue(content)))
}
