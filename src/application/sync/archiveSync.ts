import { decodeArchiveValue, encodeArchiveValue, validateArchiveSnapshot } from '../../domain/backup/archiveCodec'
import type { ArchiveSnapshot } from '../../domain/backup/ArchiveSnapshot'
import type { ArchiveStores } from '../../domain/backup/ArchiveStores'
import { requireArchive } from '../../domain/backup/validation'
import { CLOUD_ARCHIVE_STORES } from '../../domain/sync/cloudArchiveStores'
import type { CloudArchiveManifest } from '../../domain/sync/CloudArchiveManifest'
import type { CloudArchiveRevision } from '../../domain/sync/CloudArchiveRevision'
import type { CloudSnapshotRevision } from '../../domain/sync/CloudSnapshotRevision'
import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'
import { CLOUD_ARCHIVE_BYTES, CLOUD_BLOCK_BYTES, CLOUD_SNAPSHOT_BYTES, CLOUD_SOURCE_COPIES } from '../../domain/sync/limits'
import { validateCloudArchiveManifest } from '../../domain/sync/manifestValidation'
import { validateCloudArchiveRevision, validateCloudCatalog } from '../../domain/sync/syncValidation'
import type { SyncRemote } from './SyncRemote'
import { compressArchiveBytes, decompressArchiveBytes } from '../backup/archiveCompression'
import { compactCloudArchive } from './compactCloudArchive'

export async function publishArchive(
  snapshot: ArchiveSnapshot, workspace: CloudWorkspace, remote: SyncRemote, signal: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<CloudSnapshotRevision> {
  signal.throwIfAborted()
  if (workspace.version !== 2) throw new Error('This legacy workspace is read-only. Create a compact workspace to upload new history.')
  requireArchive(snapshot.version === 2, 'cloud snapshot', 'prepare hourly history before uploading a legacy archive')
  const compact = compactCloudArchive(snapshot)
  const contentHash = await snapshotContentHash(compact)
  const catalog = await remote.readCatalog(workspace, signal)
  validateCloudCatalog(catalog)
  const latest = catalog.archives.filter((revision) => revision.source.id === compact.source.id).at(-1)
  if (latest?.storage === 'snapshot' && latest.contentHash === contentHash) return latest
  const pending = (await remote.listPendingSnapshots(workspace, compact.source.id, signal))
    .filter((revision) => revision.contentHash === contentHash).at(-1)
  if (pending && (latest?.storage !== 'snapshot' || pending.createdAt > latest.createdAt)) {
    let verified = false
    try {
      await downloadArchive(pending, remote, signal, onProgress)
      verified = true
    } catch (error) {
      if (signal.aborted) throw error
    }
    if (verified) {
      signal.throwIfAborted()
      await remote.completeSnapshot(workspace, pending, signal)
      return pending
    }
  }
  const encoded = new TextEncoder().encode(encodeArchiveValue(compact))
  requireArchive(encoded.byteLength <= CLOUD_ARCHIVE_BYTES, 'cloud snapshot', 'archive exceeds upload limit')
  const compressed = compressArchiveBytes(encoded)
  requireArchive(compressed.byteLength <= CLOUD_SNAPSHOT_BYTES, 'cloud snapshot', 'compressed archive exceeds upload limit')
  const snapshotHash = await hashBytes(compressed)
  signal.throwIfAborted()
  onProgress?.(`Uploading ${Math.ceil(compressed.byteLength / 1024)} KiB of compact history…`)
  signal.throwIfAborted()
  const revision = await remote.uploadSnapshot(workspace, compressed, {
    storage: 'snapshot', id: crypto.randomUUID(), source: compact.source, exportedAt: compact.exportedAt,
    snapshotHash, contentHash, sessions: compact.stores.sessions.length,
    samples: 0, hours: compact.stores.hours!.length, bytes: encoded.byteLength, storedBytes: compressed.byteLength,
  }, signal)
  requireArchive(revision.contentHash === contentHash && revision.snapshotHash === snapshotHash && revision.storedBytes === compressed.byteLength,
    'cloud snapshot', 'upload receipt does not match the archive')
  onProgress?.('Verifying the saved compact history…')
  await downloadArchive(revision, remote, signal, onProgress)
  signal.throwIfAborted()
  await remote.completeSnapshot(workspace, revision, signal)
  return revision
}

export async function retireSourceCopies(
  sourceId: string, workspace: CloudWorkspace, remote: SyncRemote, signal: AbortSignal,
): Promise<void> {
  if (workspace.version !== 2) return
  const catalog = await remote.readCatalog(workspace, signal)
  validateCloudCatalog(catalog)
  const copies = catalog.archives.filter((revision): revision is CloudSnapshotRevision => {
    return revision.storage === 'snapshot' && revision.source.id === sourceId
  })
  for (const revision of copies.slice(0, Math.max(0, copies.length - CLOUD_SOURCE_COPIES))) {
    signal.throwIfAborted()
    await remote.deleteSnapshot(workspace, revision, sourceId, signal)
  }
  const latest = copies.at(-1)
  if (!latest) return
  const pending = await remote.listPendingSnapshots(workspace, sourceId, signal)
  for (const revision of pending) {
    if (revision.source.id !== sourceId || revision.createdAt >= latest.createdAt) continue
    signal.throwIfAborted()
    await remote.deleteSnapshot(workspace, revision, sourceId, signal, 'pending')
  }
}

export async function downloadArchive(
  revision: CloudArchiveRevision, remote: SyncRemote, signal: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<ArchiveSnapshot> {
  validateCloudArchiveRevision(revision)
  signal.throwIfAborted()
  if (revision.storage === 'snapshot') {
    const compressed = await remote.downloadBlock(revision.snapshotFileId, revision.storedBytes, signal)
    requireArchive(compressed.byteLength === revision.storedBytes && await hashBytes(compressed) === revision.snapshotHash, 'cloud snapshot', 'archive checksum does not match')
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
  requireArchive(encoded.byteLength <= CLOUD_BLOCK_BYTES && await hashBytes(encoded) === revision.manifestHash, 'cloud manifest', 'manifest checksum does not match')
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
      requireArchive(part.byteLength === block.size && await hashBytes(part) === block.hash, 'cloud block', 'archive checksum does not match')
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
  return hashBytes(new TextEncoder().encode(encodeArchiveValue({
    ...manifest,
    groups: manifest.groups.map((group) => ({ ...group, blocks: group.blocks.map((block) => ({ hash: block.hash, size: block.size })) })),
  })))
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function snapshotContentHash(snapshot: ArchiveSnapshot): Promise<string> {
  const { exportedAt: _exportedAt, ...content } = snapshot
  return hashBytes(new TextEncoder().encode(encodeArchiveValue(content)))
}
