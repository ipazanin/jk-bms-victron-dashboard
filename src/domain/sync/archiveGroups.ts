import type { ArchiveStores } from '../backup/ArchiveStores'
import { encodeArchiveValue } from '../backup/archiveTransport'

export const CLOUD_ARCHIVE_STORES = ['sessions', 'chunks', 'devices', 'meta', 'warnings', 'ringRecords', 'ringReads'] as const

export function* archiveGroups(stores: ArchiveStores): Generator<{ store: keyof ArchiveStores; key: string; bytes: Uint8Array }> {
  const encoder = new TextEncoder()
  for (const store of CLOUD_ARCHIVE_STORES) {
    const rowsByGroup = new Map<string, unknown[]>()
    for (const row of stores[store]) {
      let key: string
      switch (store) {
        case 'sessions': key = (row as ArchiveStores['sessions'][number]).id; break
        case 'chunks': {
          const chunk = row as ArchiveStores['chunks'][number]
          key = JSON.stringify([chunk.sessionId, chunk.stream, Math.floor(chunk.seq / 64)])
          break
        }
        case 'warnings': key = (row as ArchiveStores['warnings'][number]).sessionId; break
        case 'ringRecords': {
          const ring = row as ArchiveStores['ringRecords'][number]
          key = JSON.stringify([ring.deviceKey, Math.floor(ring.seq / 1024)])
          break
        }
        case 'ringReads': {
          const read = row as ArchiveStores['ringReads'][number]
          key = JSON.stringify([read.deviceKey, Math.floor(read.observedAt / 86_400_000)])
          break
        }
        default: key = store
      }
      const grouped = rowsByGroup.get(key) ?? []
      grouped.push(row)
      rowsByGroup.set(key, grouped)
    }
    for (const [key, rows] of [...rowsByGroup].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      yield { store, key, bytes: encoder.encode(encodeArchiveValue(rows)) }
    }
  }
}
