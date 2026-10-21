import { describe, expect, it, vi } from 'vitest'
import { downloadArchive } from '../src/application/sync/archiveSync'
import { compactCloudArchive } from '../src/application/sync/compactCloudArchive'
import { compressArchiveBytes } from '../src/application/backup/archiveCompression'
import type { SyncRemote } from '../src/application/sync/SyncRemote'
import { hexToBytes } from '../src/domain/bytes'
import type { RingReadRow } from '../src/domain/history/RingReadRow'
import ring from './fixtures/ringLedger.json'
import type { ArchiveSnapshot } from '../src/domain/backup/ArchiveSnapshot'
import type { CloudSnapshotRevision } from '../src/domain/sync/CloudSnapshotRevision'
import type { LegacyCloudArchiveRevision } from '../src/domain/sync/LegacyCloudArchiveRevision'
import type { CloudCatalog } from '../src/domain/sync/CloudCatalog'
import { decodeCloudWorkspace, encodeCloudWorkspace, mergeCloudCatalogs, updateCloudWorkspace } from '../src/application/sync/cloudWorkspaceJson'
import { encodeArchiveValue } from '../src/domain/backup/archiveCodec'
import { summarizeSessionHours } from '../src/domain/history/summarizeSessionHours'
import { deviceRecord, packChunk, packSamples, SAMPLE_EPOCH, sessionRecord, warningRecord } from './support/samples'

function snapshot(): ArchiveSnapshot {
  return {
    format: 'shunt-archive', version: 2, exportedAt: SAMPLE_EPOCH,
    source: { id: 'tablet', label: 'Boat tablet' },
    stores: {
      sessions: [sessionRecord({ packSamples: 2, packChunks: 1, sealedSamples: 2, state: 'closed', endedAt: SAMPLE_EPOCH + 1_000, endReason: 'user-disconnect' })],
      chunks: [packChunk(packSamples(2))], hours: summarizeSessionHours('session-0001', packSamples(2), []), devices: [deviceRecord()],
      meta: [{ key: 'totals', schema: 1, totalSamples: 2, createdAt: SAMPLE_EPOCH, lastPrunedAt: null }],
      warnings: [warningRecord()], ringRecords: ring.records.map((record) => ({ ...record, bytes: hexToBytes(record.bytes) })), ringReads: ring.reads as RingReadRow[],
    },
    preferences: [{ key: 'shunt.theme', value: 'light' }],
  }
}

function setup() {
  const files = new Map<string, Uint8Array>()
  const remote = {
    readCatalog: vi.fn(async () => ({ archives: [], settings: [], documents: [] })),
    writeCatalog: vi.fn(async (_workspace, catalog) => catalog),
    downloadBlock: vi.fn(async (id: string) => {
      const bytes = files.get(id)
      if (!bytes) throw new Error('Missing archive file')
      return bytes
    }),
  } satisfies SyncRemote
  return { remote, files, signal: new AbortController().signal }
}

const empty: CloudCatalog = { archives: [], settings: [], documents: [] }

describe('plain JSON cloud history', () => {
  it('stores compact history and shared settings together in one ordinary JSON file', async () => {
    const settings = { id: 'settings', sourceId: 'tablet', createdAt: SAMPLE_EPOCH, parents: [], preferences: [{ key: 'shunt.theme' as const, value: 'light' }] }
    const catalog = await updateCloudWorkspace(empty, snapshot(), settings)
    const encoded = encodeCloudWorkspace(catalog, 'publication')
    expect(encoded).toHaveLength(1)
    expect(JSON.parse(new TextDecoder().decode(encoded[0])).format).toBe('shunt-cloud-workspace')
    const restored = await decodeCloudWorkspace(encoded)
    expect(restored.settings).toEqual([settings])
    const { remote, signal } = setup()
    expect(await downloadArchive(restored.archives[0]!, remote, signal)).toEqual(compactCloudArchive(snapshot()))
    expect(remote.downloadBlock).not.toHaveBeenCalled()
  })

  it('returns the loaded catalog unchanged when capture time is the only change', async () => {
    const catalog = await updateCloudWorkspace(empty, snapshot())
    expect(await updateCloudWorkspace(catalog, { ...snapshot(), exportedAt: SAMPLE_EPOCH + 1000 })).toBe(catalog)
  })

  it('keeps three source revisions inside the document and preserves another source', async () => {
    const original = snapshot()
    let catalog = await updateCloudWorkspace(empty, { ...original, source: { id: 'phone', label: 'Phone' } })
    for (let index = 0; index < 5; index++) {
      catalog = await updateCloudWorkspace(catalog, { ...original, source: { ...original.source, label: `Tablet ${index}` } })
    }
    expect(catalog.archives.map((revision) => revision.source.label)).toEqual(['Phone', 'Tablet 2', 'Tablet 3', 'Tablet 4'])
    expect(await decodeCloudWorkspace(encodeCloudWorkspace(catalog, 'retained'))).toMatchObject({ archives: catalog.archives })
  })

  it('splits only when needed and reassembles complete records across files', async () => {
    const catalog = await updateCloudWorkspace(empty, snapshot())
    const encoded = encodeCloudWorkspace(catalog, 'split', 8192)
    expect(encoded.length).toBeGreaterThan(1)
    expect(encoded.every((bytes) => bytes.byteLength <= 8192)).toBe(true)
    expect(await decodeCloudWorkspace(encoded)).toMatchObject({ archives: catalog.archives })
    await expect(decodeCloudWorkspace(encoded.slice(1))).rejects.toThrow()
    await expect(decodeCloudWorkspace([encoded[0]!, ...encoded])).rejects.toThrow()
  })

  it('does not split a document that fits the exact file budget', async () => {
    const catalog = await updateCloudWorkspace(empty, snapshot())
    const encoded = encodeCloudWorkspace(catalog, 'exact')
    expect(encodeCloudWorkspace(catalog, 'exact', encoded[0]!.byteLength)).toHaveLength(1)
  })

  it('refuses a single record that cannot fit instead of splitting its bytes', async () => {
    const catalog = await updateCloudWorkspace(empty, snapshot())
    expect(() => encodeCloudWorkspace(catalog, 'oversized-record', 4096)).toThrow('one archive record exceeds')
  })

  it('rejects a changed embedded archive even if its structure remains valid', async () => {
    const catalog = await updateCloudWorkspace(empty, snapshot())
    const encoded = encodeCloudWorkspace(catalog, 'publication')
    const edited = JSON.parse(new TextDecoder().decode(encoded[0]))
    edited.archives[0].snapshot.preferences[0].value = 'dark'
    await expect(decodeCloudWorkspace([new TextEncoder().encode(JSON.stringify(edited))])).rejects.toThrow()
  })

  it('merges concurrent publications without dropping either source or settings branch', async () => {
    const left = await updateCloudWorkspace(empty, snapshot(), { id: 'left-settings', sourceId: 'tablet', parents: [], createdAt: SAMPLE_EPOCH, preferences: [] })
    const right = await updateCloudWorkspace(empty, { ...snapshot(), source: { id: 'phone', label: 'Phone' } }, { id: 'right-settings', sourceId: 'phone', parents: [], createdAt: SAMPLE_EPOCH, preferences: [] })
    const merged = mergeCloudCatalogs([left, right, left])
    expect(merged.archives).toHaveLength(2)
    expect(merged.settings).toHaveLength(2)
    expect(() => mergeCloudCatalogs([left, { ...left, settings: [{ ...left.settings[0]!, sourceId: 'changed' }] }])).toThrow('conflicting settings')
  })

  it('reads an existing gzip snapshot without writing', async () => {
    const { remote, files, signal } = setup()
    const compact = compactCloudArchive(snapshot())
    const json = new TextEncoder().encode(encodeArchiveValue(compact))
    const bytes = compressArchiveBytes(json)
    files.set('gzip', bytes)
    const { exportedAt: _exportedAt, ...content } = compact
    const revision: CloudSnapshotRevision = {
      storage: 'snapshot', id: 'legacy-snapshot', source: compact.source, exportedAt: compact.exportedAt, createdAt: compact.exportedAt,
      snapshotFileId: 'gzip', snapshotHash: await sha256(bytes), contentHash: await sha256(new TextEncoder().encode(encodeArchiveValue(content))),
      sessions: compact.stores.sessions.length, samples: 0, hours: compact.stores.hours!.length, bytes: json.byteLength, storedBytes: bytes.byteLength,
    }
    expect(await downloadArchive(revision, remote, signal)).toEqual(compact)
    expect(remote.writeCatalog).not.toHaveBeenCalled()
  })

  it.each([1, 2] as const)('reads an independently assembled legacy version %i without writing', async (version) => {
    const { remote, files, signal } = setup()
    const { hours: _hours, ...stores } = snapshot().stores
    const original: ArchiveSnapshot = { ...snapshot(), version: 1, stores }
    const groups = []
    let totalBytes = 0
    for (const [store, rows] of Object.entries(original.stores)) {
      const decoded = new TextEncoder().encode(encodeArchiveValue(rows))
      const bytes = version === 2 ? compressArchiveBytes(decoded) : decoded
      totalBytes += decoded.byteLength
      const hash = await sha256(bytes)
      files.set(store, bytes)
      groups.push({ store, key: store, blocks: [{ hash, fileId: store, size: bytes.byteLength }], ...(version === 2 ? { decodedBytes: decoded.byteLength } : {}) })
    }
    const manifest = { format: 'shunt-cloud-archive', version, source: original.source, preferences: original.preferences, groups }
    const encoded = new TextEncoder().encode(encodeArchiveValue(manifest))
    files.set('legacy-manifest', encoded)
    const identity = { ...manifest, groups: groups.map((group) => ({ ...group, blocks: group.blocks.map(({ hash, size }) => ({ hash, size })) })) }
    const revision: LegacyCloudArchiveRevision = {
      id: 'legacy', source: original.source, exportedAt: original.exportedAt, manifestFileId: 'legacy-manifest',
      manifestHash: await sha256(encoded), contentHash: await sha256(new TextEncoder().encode(encodeArchiveValue(identity))),
      sessions: 1, samples: 2, bytes: totalBytes,
    }
    expect(await downloadArchive(revision, remote, signal)).toEqual(original)
    expect(remote.writeCatalog).not.toHaveBeenCalled()
  })
})

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
