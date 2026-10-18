import { decodeArchiveValue, encodeArchiveValue, validateArchiveSnapshot } from '../../domain/backup/archiveCodec'
import type { ArchiveSnapshot } from '../../domain/backup/ArchiveSnapshot'
import type { ArchiveStores } from '../../domain/backup/ArchiveStores'
import { requireArchive } from '../../domain/backup/validation'
import { archiveGroups, CLOUD_ARCHIVE_STORES } from '../../domain/sync/archiveGroups'
import type { CloudArchiveGroup } from '../../domain/sync/CloudArchiveGroup'
import type { CloudArchiveManifest } from '../../domain/sync/CloudArchiveManifest'
import type { CloudArchiveRevision } from '../../domain/sync/CloudArchiveRevision'
import type { CloudBlock } from '../../domain/sync/CloudBlock'
import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'
import { CLOUD_ARCHIVE_BYTES, CLOUD_BLOCK_BYTES } from '../../domain/sync/limits'
import { validateCloudArchiveManifest } from '../../domain/sync/manifestValidation'
import { validateCloudArchiveRevision, validateCloudCatalog } from '../../domain/sync/syncValidation'
import type { SyncRemote } from './SyncRemote'

export async function publishArchive(
  snapshot: ArchiveSnapshot, workspace: CloudWorkspace, remote: SyncRemote, signal: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<CloudArchiveRevision> {
  signal.throwIfAborted()
  validateArchiveSnapshot(snapshot)
  const catalog = await remote.readCatalog(workspace, signal)
  validateCloudCatalog(catalog)
  const listedBlocks = await remote.listBlocks(workspace, signal)
  const available = new Map<string, CloudBlock>()
  for (const block of listedBlocks) {
    const key = `${block.hash}:${block.size}`
    const existing = available.get(key)
    if (!existing || block.fileId < existing.fileId) available.set(key, block)
  }
  const availableFileIds = new Set(listedBlocks.map((block) => block.fileId))
  const groups: CloudArchiveGroup[] = []
  let bytes = 0
  for (const group of archiveGroups(snapshot.stores)) {
    signal.throwIfAborted()
    bytes += group.bytes.byteLength
    requireArchive(bytes <= CLOUD_ARCHIVE_BYTES, 'cloud archive', 'archive exceeds upload limit')
    const blocks: CloudBlock[] = []
    for (let offset = 0; offset < group.bytes.byteLength; offset += CLOUD_BLOCK_BYTES) {
      signal.throwIfAborted()
      const part = group.bytes.subarray(offset, offset + CLOUD_BLOCK_BYTES)
      blocks.push(await upload(part))
    }
    groups.push({ store: group.store, key: group.key, blocks })
  }
  const manifest: CloudArchiveManifest = {
    format: 'shunt-cloud-archive', version: 1, source: snapshot.source, preferences: snapshot.preferences, groups,
  }
  validateCloudArchiveManifest(manifest)
  const contentHash = await contentHashOf(manifest)
  const latest = catalog.archives.filter((revision) => revision.source.id === snapshot.source.id).at(-1)
  const encoded = new TextEncoder().encode(encodeArchiveValue(manifest))
  requireArchive(encoded.byteLength <= CLOUD_BLOCK_BYTES, 'cloud manifest', 'manifest exceeds 1 MiB')
  if (latest?.contentHash === contentHash && latest.manifestHash === await hashBytes(encoded)
    && availableFileIds.has(latest.manifestFileId)) return latest
  const manifestBlock = await upload(encoded)
  const revision: CloudArchiveRevision = {
    id: crypto.randomUUID(), source: snapshot.source, exportedAt: snapshot.exportedAt,
    manifestFileId: manifestBlock.fileId, manifestHash: manifestBlock.hash, contentHash,
    sessions: snapshot.stores.sessions.length,
    samples: snapshot.stores.chunks.reduce((total, chunk) => total + chunk.length, 0), bytes,
  }
  validateCloudArchiveRevision(revision)
  signal.throwIfAborted()
  onProgress?.('Publishing the archive catalogue entry…')
  await remote.appendArchive(workspace, revision, signal)
  return revision

  async function upload(part: Uint8Array): Promise<CloudBlock> {
    const hash = await hashBytes(part)
    const existing = available.get(`${hash}:${part.byteLength}`)
    if (existing !== undefined) return existing
    signal.throwIfAborted()
    onProgress?.(`Uploading ${Math.ceil(part.byteLength / 1024)} KiB of archive data…`)
    signal.throwIfAborted()
    const uploaded = await remote.uploadBlock(workspace, part, hash, signal)
    requireArchive(uploaded.hash === hash && uploaded.size === part.byteLength && uploaded.fileId.length > 0, 'cloud block', 'upload receipt does not match the content')
    available.set(`${hash}:${part.byteLength}`, uploaded)
    return uploaded
  }
}

export async function downloadArchive(
  revision: CloudArchiveRevision, remote: SyncRemote, signal: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<ArchiveSnapshot> {
  validateCloudArchiveRevision(revision)
  signal.throwIfAborted()
  const encoded = await remote.downloadBlock(revision.manifestFileId, CLOUD_BLOCK_BYTES, signal)
  requireArchive(encoded.byteLength <= CLOUD_BLOCK_BYTES && await hashBytes(encoded) === revision.manifestHash, 'cloud manifest', 'manifest checksum does not match')
  const manifest = decodeArchiveValue(new TextDecoder('utf-8', { fatal: true }).decode(encoded))
  validateCloudArchiveManifest(manifest)
  requireArchive(manifest.source.id === revision.source.id && manifest.source.label === revision.source.label, 'cloud manifest', 'archive source does not match')
  requireArchive(await contentHashOf(manifest) === revision.contentHash, 'cloud manifest', 'archive content checksum does not match')
  requireArchive(manifest.groups.reduce((total, group) => total + group.blocks.reduce((sum, block) => sum + block.size, 0), 0) === revision.bytes,
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
    bytes += combined.byteLength
    const rows = decodeArchiveValue(new TextDecoder('utf-8', { fatal: true }).decode(combined))
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
