import type { ArchiveSnapshot } from '../../domain/backup/ArchiveSnapshot'
import type { ArchiveStores } from '../../domain/backup/ArchiveStores'
import { decodeArchiveValue, encodeArchiveValue } from '../../domain/backup/archiveCodec'
import { requireArchive } from '../../domain/backup/validation'
import type { CloudArchivePiece } from '../../domain/sync/CloudArchivePiece'
import type { CloudCatalog } from '../../domain/sync/CloudCatalog'
import type { CloudJsonDocument } from '../../domain/sync/CloudJsonDocument'
import type { CloudJsonRevision } from '../../domain/sync/CloudJsonRevision'
import type { CloudSettingsRevision } from '../../domain/sync/CloudSettingsRevision'
import { CLOUD_ARCHIVE_BYTES, CLOUD_DOCUMENT_BYTES, CLOUD_PUBLICATION_FILES, CLOUD_SOURCE_COPIES } from '../../domain/sync/limits'
import { validateCloudArchiveRevision, validateCloudCatalog } from '../../domain/sync/syncValidation'
import { compactCloudArchive } from './compactCloudArchive'

export async function hashCloudBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function encode(input: unknown): Uint8Array {
  return new TextEncoder().encode(encodeArchiveValue(input))
}

async function contentHash(snapshot: ArchiveSnapshot): Promise<string> {
  const { exportedAt: _exportedAt, ...content } = snapshot
  return hashCloudBytes(encode(content))
}

export async function verifyJsonRevision(revision: CloudJsonRevision): Promise<void> {
  validateCloudArchiveRevision(revision)
  requireArchive(encode(revision.snapshot).byteLength === revision.bytes, 'cloud JSON archive', 'byte count does not match')
  requireArchive(await contentHash(revision.snapshot) === revision.contentHash, 'cloud JSON archive', 'content checksum does not match')
}

export function mergeCloudCatalogs(catalogs: readonly CloudCatalog[]): CloudCatalog {
  const archives = new Map<string, CloudJsonRevision>()
  const settings = new Map<string, CloudSettingsRevision>()
  for (const catalog of catalogs) {
    validateCloudCatalog(catalog)
    for (const revision of catalog.archives) {
      requireArchive(revision.storage === 'json', 'cloud workspace', 'expected JSON history')
      const previous = archives.get(revision.id)
      requireArchive(!previous || encodeArchiveValue(previous) === encodeArchiveValue(revision), 'cloud workspace', 'conflicting archive revision identity')
      archives.set(revision.id, revision)
    }
    for (const revision of catalog.settings) {
      const previous = settings.get(revision.id)
      requireArchive(!previous || encodeArchiveValue(previous) === encodeArchiveValue(revision), 'cloud workspace', 'conflicting settings revision identity')
      settings.set(revision.id, revision)
    }
  }
  const catalog: CloudCatalog = {
    archives: [...archives.values()].sort(compareArchives),
    settings: [...settings.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    documents: catalogs.flatMap((catalog) => catalog.documents ?? []),
  }
  validateCloudCatalog(catalog)
  requireArchive(encode({ archives: catalog.archives, settings: catalog.settings }).byteLength <= CLOUD_ARCHIVE_BYTES,
    'cloud workspace', 'merged workspace exceeds the supported size')
  return catalog
}

export async function updateCloudWorkspace(
  catalog: CloudCatalog, snapshot?: ArchiveSnapshot, settings?: CloudSettingsRevision,
): Promise<CloudCatalog> {
  validateCloudCatalog(catalog)
  let archives = catalog.archives.map((revision) => {
    requireArchive(revision.storage === 'json', 'cloud workspace', 'legacy history cannot be changed')
    return revision
  })
  let changed = new Set(catalog.documents?.map((document) => document.publicationId)).size > 1
  if (snapshot) {
    const compact = compactCloudArchive(snapshot)
    const hash = await contentHash(compact)
    const previous = archives.filter((revision) => revision.source.id === compact.source.id).at(-1)
    if (previous?.contentHash !== hash) {
      const bytes = encode(compact).byteLength
      requireArchive(bytes <= CLOUD_ARCHIVE_BYTES, 'cloud workspace', 'source archive exceeds the supported size')
      archives.push({
        storage: 'json', id: crypto.randomUUID(), source: compact.source, exportedAt: compact.exportedAt,
        createdAt: Math.max(Date.now(), previous ? previous.createdAt + 1 : 0), contentHash: hash, sessions: compact.stores.sessions.length, samples: 0,
        hours: compact.stores.hours!.length, bytes, snapshot: compact,
      })
      changed = true
    }
  }
  const counts = new Map<string, number>()
  archives = [...archives].reverse().filter((revision) => {
    const count = (counts.get(revision.source.id) ?? 0) + 1
    counts.set(revision.source.id, count)
    if (count > CLOUD_SOURCE_COPIES) changed = true
    return count <= CLOUD_SOURCE_COPIES
  }).reverse()
  const revisions = settings ? [...catalog.settings, settings] : catalog.settings
  if (settings) changed = true
  if (!changed) return catalog
  const { cleanupFailure: _cleanupFailure, ...loaded } = catalog
  archives.sort(compareArchives)
  const updated = { ...loaded, archives, settings: revisions }
  validateCloudCatalog(updated)
  return updated
}

export function encodeCloudWorkspace(
  catalog: CloudCatalog, publicationId: string, maximumBytes = CLOUD_DOCUMENT_BYTES,
): readonly Uint8Array[] {
  validateCloudCatalog(catalog)
  requireArchive(maximumBytes > 2048 && maximumBytes <= CLOUD_DOCUMENT_BYTES, 'cloud workspace', 'invalid document size limit')
  const whole = encode({
    format: 'shunt-cloud-workspace', version: 3, publicationId, index: 0, count: 1,
    archives: catalog.archives.map((revision) => {
      requireArchive(revision.storage === 'json', 'cloud workspace', 'legacy history cannot be written into a JSON workspace')
      return { ...revision, part: 0, parts: 1 }
    }),
    settings: catalog.settings,
  } satisfies CloudJsonDocument)
  if (whole.byteLength <= maximumBytes) return [whole]
  requireArchive(whole.byteLength <= CLOUD_ARCHIVE_BYTES, 'cloud workspace', 'workspace exceeds the supported size')
  const budget = maximumBytes - 1024
  const parts: { archives: CloudArchivePiece[], settings: CloudSettingsRevision[] }[] = [{ archives: [], settings: [] }]
  const emptyBytes = encode(parts[0]).byteLength
  let currentBytes = emptyBytes
  const append = (kind: 'archives' | 'settings', revision: CloudArchivePiece | CloudSettingsRevision): void => {
    const revisionBytes = encode(revision).byteLength + 1
    requireArchive(emptyBytes + revisionBytes <= budget, 'cloud workspace', 'one record exceeds the document size limit')
    let current = parts.at(-1)!
    if (currentBytes + revisionBytes > budget) {
      current = { archives: [], settings: [] }
      parts.push(current)
      currentBytes = emptyBytes
    }
    if (kind === 'archives') current.archives.push(revision as CloudArchivePiece)
    else current.settings.push(revision as CloudSettingsRevision)
    currentBytes += revisionBytes
  }
  for (const revision of catalog.archives) {
    requireArchive(revision.storage === 'json', 'cloud workspace', 'legacy history cannot be written into a JSON workspace')
    for (const piece of splitArchive(revision, budget - 64)) append('archives', piece)
  }
  for (const revision of catalog.settings) append('settings', revision)
  requireArchive(parts.length <= CLOUD_PUBLICATION_FILES, 'cloud workspace', 'too many archive files')
  const encoded = parts.map((part, index) => encode({
    format: 'shunt-cloud-workspace', version: 3, publicationId, index, count: parts.length, ...part,
  } satisfies CloudJsonDocument))
  requireArchive(encoded.every((bytes) => bytes.byteLength <= maximumBytes), 'cloud workspace', 'document exceeds the size limit')
  requireArchive(encoded.reduce((sum, bytes) => sum + bytes.byteLength, 0) <= CLOUD_ARCHIVE_BYTES,
    'cloud workspace', 'workspace exceeds the supported size')
  return encoded
}

function splitArchive(revision: CloudJsonRevision, maximumBytes: number): readonly CloudArchivePiece[] {
  const whole: CloudArchivePiece = { ...revision, part: 0, parts: 1 }
  if (encode(whole).byteLength <= maximumBytes) return [whole]
  const emptyStores = Object.fromEntries(Object.keys(revision.snapshot.stores).map((key) => [key, []])) as unknown as ArchiveStores
  const blank = (): CloudArchivePiece => ({
    ...revision, part: 0, parts: CLOUD_PUBLICATION_FILES,
    snapshot: { ...revision.snapshot, stores: structuredClone(emptyStores), preferences: [] },
  })
  const pieces: CloudArchivePiece[] = []
  let current = blank()
  let size = encode(current).byteLength
  let rows = 0
  const append = (key: keyof ArchiveStores | 'preferences', row: unknown): void => {
    const rowBytes = encode(row).byteLength + 1
    if (size + rowBytes > maximumBytes && rows > 0) {
      pieces.push(current)
      current = blank()
      size = encode(current).byteLength
      rows = 0
    }
    requireArchive(size + rowBytes <= maximumBytes, 'cloud workspace', 'one archive record exceeds the document size limit')
    const target = (key === 'preferences' ? current.snapshot.preferences : current.snapshot.stores[key]) as unknown[]
    target.push(row)
    size += rowBytes
    rows++
  }
  for (const [key, records] of Object.entries(revision.snapshot.stores)) {
    for (const row of records) append(key as keyof ArchiveStores, row)
  }
  for (const preference of revision.snapshot.preferences) append('preferences', preference)
  pieces.push(current)
  return pieces.map((piece, part) => ({ ...piece, part, parts: pieces.length }))
}

export async function decodeCloudWorkspace(encoded: readonly Uint8Array[], expectedPublicationId?: string): Promise<CloudCatalog> {
  requireArchive(encoded.length > 0 && encoded.length <= CLOUD_PUBLICATION_FILES, 'cloud workspace', 'invalid publication size')
  requireArchive(encoded.reduce((sum, bytes) => sum + bytes.byteLength, 0) <= CLOUD_ARCHIVE_BYTES,
    'cloud workspace', 'workspace exceeds the supported size')
  const documents = encoded.map((bytes) => {
    requireArchive(bytes.byteLength > 0 && bytes.byteLength <= CLOUD_DOCUMENT_BYTES, 'cloud workspace', 'invalid document size')
    return decodeArchiveValue(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as CloudJsonDocument
  })
  const pieces = new Map<string, CloudArchivePiece[]>()
  const settings: CloudSettingsRevision[] = []
  for (const [index, document] of documents.entries()) {
    requireArchive(document !== null && typeof document === 'object'
      && Object.keys(document).sort().join(',') === 'archives,count,format,index,publicationId,settings,version'
      && document.format === 'shunt-cloud-workspace' && document.version === 3
      && typeof document.publicationId === 'string' && document.publicationId.length > 0 && document.publicationId.length <= 1024
      && (expectedPublicationId === undefined || document.publicationId === expectedPublicationId)
      && document.publicationId === documents[0]!.publicationId && document.index === index && document.count === documents.length
      && Array.isArray(document.archives) && Array.isArray(document.settings), 'cloud workspace', 'incomplete or invalid publication')
    for (const piece of document.archives) {
      requireArchive(piece !== null && typeof piece === 'object' && typeof piece.id === 'string'
        && Number.isSafeInteger(piece.part) && Number.isSafeInteger(piece.parts) && piece.part >= 0
        && piece.parts > 0 && piece.part < piece.parts && piece.parts <= CLOUD_PUBLICATION_FILES,
      'cloud workspace', 'invalid archive part')
      const existing = pieces.get(piece.id) ?? []
      existing.push(piece)
      pieces.set(piece.id, existing)
    }
    settings.push(...document.settings)
  }
  const archives: CloudJsonRevision[] = []
  for (const fragments of pieces.values()) {
    fragments.sort((left, right) => left.part - right.part)
    const first = fragments[0]!
    requireArchive(fragments.length === first.parts, 'cloud workspace', 'missing archive part')
    const { part: _part, parts: _parts, snapshot, ...metadata } = first
    const stores = Object.fromEntries(Object.keys(snapshot.stores).map((key) => [key, []])) as unknown as Record<keyof ArchiveStores, unknown[]>
    const preferences: ArchiveSnapshot['preferences'][number][] = []
    for (const [index, fragment] of fragments.entries()) {
      const { part, parts, snapshot: captured, ...header } = fragment
      requireArchive(part === index && parts === first.parts && encodeArchiveValue(header) === encodeArchiveValue(metadata)
        && encodeArchiveValue({ ...captured, stores: {}, preferences: [] }) === encodeArchiveValue({ ...snapshot, stores: {}, preferences: [] })
        && Object.keys(captured.stores).sort().join(',') === Object.keys(stores).sort().join(','),
      'cloud workspace', 'archive parts do not agree')
      for (const [key, rows] of Object.entries(captured.stores)) {
        requireArchive(Array.isArray(rows), 'cloud workspace', 'invalid archive rows')
        for (const row of rows) stores[key as keyof ArchiveStores].push(row)
      }
      requireArchive(Array.isArray(captured.preferences), 'cloud workspace', 'invalid archive preferences')
      preferences.push(...captured.preferences)
    }
    const revision = { ...metadata, snapshot: { ...snapshot, stores: stores as unknown as ArchiveStores, preferences } }
    await verifyJsonRevision(revision)
    archives.push(revision)
  }
  const catalog = { archives, settings }
  validateCloudCatalog(catalog)
  return catalog
}

function compareArchives(left: CloudJsonRevision, right: CloudJsonRevision): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}
