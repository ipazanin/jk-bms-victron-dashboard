import { compressArchiveBytes, decompressArchiveBytes } from '../../../application/backup/archiveCompression'
import type { ArchiveSnapshot } from '../../../domain/backup/ArchiveSnapshot'
import { decodeArchiveValue, encodeArchiveValue, validateArchiveSnapshot } from '../../../domain/backup/archiveCodec'
import { MAX_ARCHIVE_FILE_BYTES, MAX_ARCHIVE_JSON_BYTES } from './limits'

export function exportArchiveJson(snapshots: readonly ArchiveSnapshot[]) {
  validateSources(snapshots)
  const serialized = encodeArchiveValue(snapshots.length === 1 ? snapshots[0] : snapshots)
  if (serialized.length > MAX_ARCHIVE_JSON_BYTES) throw new Error('Archive JSON exceeds the supported size')
  const json = new TextEncoder().encode(serialized)
  if (json.byteLength > MAX_ARCHIVE_JSON_BYTES) throw new Error('Archive JSON exceeds the supported size')
  const bytes = compressArchiveBytes(json)
  if (bytes.byteLength > MAX_ARCHIVE_FILE_BYTES) throw new Error('Archive file size is outside the supported limits')
  const stamp = new Date(snapshots[0]!.exportedAt).toISOString().slice(0, 10)
  return { bytes, fileName: `shunt-archive-${stamp}.json.gz`, mimeType: 'application/gzip' }
}

export function importArchiveJson(input: ArrayBuffer | Uint8Array): readonly ArchiveSnapshot[] {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_FILE_BYTES) throw new Error('Archive file size is outside the supported limits')
  const json = bytes[0] === 0x1f && bytes[1] === 0x8b ? decompressArchiveBytes(bytes, MAX_ARCHIVE_JSON_BYTES) : bytes
  const decoded = decodeArchiveValue(new TextDecoder('utf-8', { fatal: true }).decode(json))
  const snapshots: unknown[] = Array.isArray(decoded) ? decoded : [decoded]
  validateSources(snapshots)
  return snapshots
}

function validateSources(snapshots: readonly unknown[]): asserts snapshots is readonly ArchiveSnapshot[] {
  if (snapshots.length === 0 || snapshots.length > 100) throw new Error('Select between 1 and 100 archive sources')
  const sourceIds = new Set<string>()
  let samples = 0
  for (const snapshot of snapshots) {
    validateArchiveSnapshot(snapshot)
    if (sourceIds.has(snapshot.source.id)) throw new Error('Archive sources must have distinct source IDs')
    sourceIds.add(snapshot.source.id)
    for (const chunk of snapshot.stores.chunks) {
      samples += chunk.length
      if (samples > 10_000_000) throw new Error('Archive exceeds the supported sample count')
    }
  }
}
