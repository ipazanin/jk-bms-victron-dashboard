import { describe, expect, it, vi } from 'vitest'
import { publishArchive, downloadArchive, retireSourceCopies } from '../src/application/sync/archiveSync'
import { compactCloudArchive } from '../src/application/sync/compactCloudArchive'
import { compressArchiveBytes } from '../src/application/backup/archiveCompression'
import type { SyncRemote } from '../src/application/sync/SyncRemote'
import { hexToBytes } from '../src/domain/bytes'
import type { RingReadRow } from '../src/domain/history/RingReadRow'
import ring from './fixtures/ringLedger.json'
import type { ArchiveSnapshot } from '../src/domain/backup/ArchiveSnapshot'
import type { CloudSnapshotRevision } from '../src/domain/sync/CloudSnapshotRevision'
import type { LegacyCloudArchiveRevision } from '../src/domain/sync/LegacyCloudArchiveRevision'
import type { CloudSettingsRevision } from '../src/domain/sync/CloudSettingsRevision'
import { encodeArchiveValue } from '../src/domain/backup/archiveCodec'
import { summarizeSessionHours } from '../src/domain/history/summarizeSessionHours'
import { deviceRecord, packChunk, packSamples, SAMPLE_EPOCH, sessionRecord, warningRecord } from './support/samples'

const workspace = { id: 'sheet', name: 'Boat', folderId: 'folder', version: 2 as const }

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
  const archives: CloudSnapshotRevision[] = []
  const settings: CloudSettingsRevision[] = []
  const pending: CloudSnapshotRevision[] = []
  const files = new Map<string, Uint8Array>()
  const calls: string[] = []
  const controller = new AbortController()
  let sequence = 0
  const remote = {
    readCatalog: vi.fn(async () => ({ archives: [...archives].sort((left, right) => left.createdAt - right.createdAt), settings })),
    listPendingSnapshots: vi.fn(async (_workspace, sourceId) => pending.filter((revision) => revision.source.id === sourceId)),
    uploadSnapshot: vi.fn(async (_workspace, bytes, description) => {
      const revision = { ...description, snapshotFileId: `file-${sequence}`, createdAt: SAMPLE_EPOCH + sequence++ }
      calls.push('upload')
      files.set(revision.snapshotFileId, new Uint8Array(bytes))
      pending.push(revision)
      return revision
    }),
    downloadBlock: vi.fn(async (fileId, maxBytes) => {
      calls.push('verify')
      const bytes = files.get(fileId)
      if (bytes === undefined) throw new Error('Missing archive file')
      if (bytes.byteLength > maxBytes) throw new Error('Download too large')
      return bytes
    }),
    completeSnapshot: vi.fn(async (_workspace, revision) => {
      calls.push('publish')
      if (!archives.some((copy) => copy.id === revision.id)) archives.push(revision)
      const index = pending.findIndex((copy) => copy.id === revision.id)
      if (index !== -1) pending.splice(index, 1)
    }),
    deleteSnapshot: vi.fn(async (_workspace, revision, sourceId) => {
      if (revision.source.id !== sourceId) throw new Error('Foreign source')
      calls.push('delete')
      const index = archives.findIndex((copy) => copy.id === revision.id)
      if (index !== -1) archives.splice(index, 1)
      files.delete(revision.snapshotFileId)
      const pendingIndex = pending.findIndex((copy) => copy.id === revision.id)
      if (pendingIndex !== -1) pending.splice(pendingIndex, 1)
    }),
    appendSettings: vi.fn(async (_workspace, revision) => { settings.push(revision) }),
  } satisfies SyncRemote
  return { remote, archives, pending, files, calls, controller, signal: controller.signal }
}

describe('self-contained compact cloud copies', () => {
  it('uploads and verifies a complete compact archive before publishing it', async () => {
    const { remote, signal, calls } = setup()
    const original = snapshot()
    const revision = await publishArchive(original, workspace, remote, signal)
    expect(calls).toEqual(['upload', 'verify', 'publish'])
    expect(revision).toMatchObject({ storage: 'snapshot', source: original.source, sessions: 1, samples: 0, hours: 1 })
    expect(await downloadArchive(revision, remote, signal)).toEqual(compactCloudArchive(original))
  })

  it('refuses legacy workspace uploads without reading or changing its catalogue', async () => {
    const { remote, signal } = setup()
    await expect(publishArchive(snapshot(), { ...workspace, version: 1 }, remote, signal)).rejects.toThrow('legacy workspace is read-only')
    expect(remote.readCatalog).not.toHaveBeenCalled()
    expect(remote.uploadSnapshot).not.toHaveBeenCalled()
  })

  it('requires hourly preparation before publishing a legacy snapshot', async () => {
    const { remote, signal } = setup()
    const { hours: _hours, ...stores } = snapshot().stores
    await expect(publishArchive({ ...snapshot(), version: 1, stores }, workspace, remote, signal)).rejects.toThrow('prepare hourly history')
    expect(remote.uploadSnapshot).not.toHaveBeenCalled()
  })

  it('does not upload another copy when only capture time or raw chunks changed', async () => {
    const { remote, signal } = setup()
    const original = snapshot()
    const first = await publishArchive(original, workspace, remote, signal)
    remote.uploadSnapshot.mockClear()
    const second = await publishArchive({ ...original, exportedAt: original.exportedAt + 1000 }, workspace, remote, signal)
    expect(second).toEqual(first)
    expect(remote.uploadSnapshot).not.toHaveBeenCalled()
    expect(remote.completeSnapshot).toHaveBeenCalledTimes(1)
  })

  it('keeps earlier copies readable after the current local archive was pruned', async () => {
    const { remote, signal } = setup()
    const original = snapshot()
    const first = await publishArchive(original, workspace, remote, signal)
    const pruned: ArchiveSnapshot = { ...original, exportedAt: original.exportedAt + 1000, stores: { sessions: [], chunks: [], hours: [], devices: [], meta: [], warnings: [], ringRecords: [], ringReads: [] } }
    const second = await publishArchive(pruned, workspace, remote, signal)
    expect(await downloadArchive(first, remote, signal)).toEqual(compactCloudArchive(original))
    expect(await downloadArchive(second, remote, signal)).toEqual(compactCloudArchive(pruned))
  })

  it('keeps the latest three copies of this source and leaves other sources intact', async () => {
    const { remote, archives, signal, files } = setup()
    const original = snapshot()
    const foreign = await publishArchive({ ...original, source: { id: 'phone', label: 'Phone' } }, workspace, remote, signal)
    const own: CloudSnapshotRevision[] = []
    for (let index = 0; index < 5; index++) {
      own.push(await publishArchive({ ...original, exportedAt: original.exportedAt - index * 1000, source: { ...original.source, label: `Boat ${index}` } }, workspace, remote, signal))
    }
    await retireSourceCopies(original.source.id, workspace, remote, signal)
    expect(archives.map((revision) => revision.id)).toEqual([foreign.id, ...own.slice(-3).map((revision) => revision.id)])
    expect(files.has(foreign.snapshotFileId)).toBe(true)
    expect(remote.deleteSnapshot).toHaveBeenCalledTimes(2)
    expect(await downloadArchive(own.at(-1)!, remote, signal)).toMatchObject({ exportedAt: original.exportedAt - 4000 })
  })

  it('retries interrupted retirement without removing surviving copies', async () => {
    const { remote, archives, signal } = setup()
    for (let index = 0; index < 5; index++) {
      await publishArchive({ ...snapshot(), source: { id: 'tablet', label: `Boat ${index}` } }, workspace, remote, signal)
    }
    const remove = remote.deleteSnapshot.getMockImplementation()!
    remote.deleteSnapshot.mockImplementationOnce(remove).mockRejectedValueOnce(new Error('Offline'))
    await expect(retireSourceCopies('tablet', workspace, remote, signal)).rejects.toThrow('Offline')
    expect(archives).toHaveLength(4)
    await retireSourceCopies('tablet', workspace, remote, signal)
    expect(archives).toHaveLength(3)
  })

  it('reuses an uploaded and verified pending copy after catalogue publication failed', async () => {
    const { remote, pending, files, signal } = setup()
    remote.completeSnapshot.mockRejectedValueOnce(new Error('Offline'))
    await expect(publishArchive(snapshot(), workspace, remote, signal)).rejects.toThrow('Offline')
    expect(pending).toHaveLength(1)
    const revision = await publishArchive({ ...snapshot(), exportedAt: SAMPLE_EPOCH + 1000 }, workspace, remote, signal)
    expect(revision.exportedAt).toBe(SAMPLE_EPOCH)
    expect(files.size).toBe(1)
    expect(remote.uploadSnapshot).toHaveBeenCalledTimes(1)
    expect(pending).toHaveLength(0)
  })

  it('leaves a corrupt pending file alone and publishes a newly verified copy', async () => {
    const { remote, pending, files, signal } = setup()
    remote.completeSnapshot.mockRejectedValueOnce(new Error('Offline'))
    await expect(publishArchive(snapshot(), workspace, remote, signal)).rejects.toThrow('Offline')
    const abandoned = pending[0]!
    files.set(abandoned.snapshotFileId, new Uint8Array([1]))
    const revision = await publishArchive(snapshot(), workspace, remote, signal)
    expect(revision.snapshotFileId).not.toBe(abandoned.snapshotFileId)
    expect(pending).toEqual([abandoned])
    expect(remote.deleteSnapshot).not.toHaveBeenCalled()
  })

  it('retires older valid pending copies after publishing changed content without touching other sources or newer uploads', async () => {
    const { remote, pending, files, signal } = setup()
    remote.completeSnapshot.mockRejectedValueOnce(new Error('Cancelled before publication'))
    await expect(publishArchive(snapshot(), workspace, remote, signal)).rejects.toThrow('Cancelled')
    const interrupted = pending[0]!
    const latest = await publishArchive({ ...snapshot(), source: { ...snapshot().source, label: 'Changed boat' } }, workspace, remote, signal)
    const foreign = { ...interrupted, id: 'foreign', snapshotFileId: 'foreign-file', source: { id: 'phone', label: 'Phone' } }
    const newer = { ...interrupted, id: 'newer', snapshotFileId: 'newer-file', createdAt: latest.createdAt + 1 }
    pending.push(foreign, newer)
    files.set(foreign.snapshotFileId, new Uint8Array([1]))
    files.set(newer.snapshotFileId, new Uint8Array([1]))
    await retireSourceCopies('tablet', workspace, remote, signal)
    expect(remote.deleteSnapshot).toHaveBeenCalledExactlyOnceWith(workspace, interrupted, 'tablet', signal, 'pending')
    expect(files.has(interrupted.snapshotFileId)).toBe(false)
    expect(pending).toEqual([foreign, newer])
  })

  it('does not turn a failed pending publication into another upload in the same operation', async () => {
    const { remote, signal } = setup()
    remote.completeSnapshot.mockRejectedValue(new Error('Offline'))
    await expect(publishArchive(snapshot(), workspace, remote, signal)).rejects.toThrow('Offline')
    await expect(publishArchive(snapshot(), workspace, remote, signal)).rejects.toThrow('Offline')
    expect(remote.uploadSnapshot).toHaveBeenCalledTimes(1)
  })

  it('does not publish corrupt uploads or cancelled transfers', async () => {
    const failed = setup()
    failed.remote.downloadBlock.mockResolvedValueOnce(new Uint8Array([1]))
    await expect(publishArchive(snapshot(), workspace, failed.remote, failed.signal)).rejects.toThrow('checksum')
    expect(failed.remote.completeSnapshot).not.toHaveBeenCalled()
    const cancelled = setup()
    await expect(publishArchive(snapshot(), workspace, cancelled.remote, cancelled.signal, () => cancelled.controller.abort())).rejects.toThrow()
    expect(cancelled.remote.completeSnapshot).not.toHaveBeenCalled()
  })

  it('rejects altered source metadata and corrupt saved bytes', async () => {
    const { remote, files, signal } = setup()
    const revision = await publishArchive(snapshot(), workspace, remote, signal)
    await expect(downloadArchive({ ...revision, source: { id: 'other', label: 'Other' } }, remote, signal)).rejects.toThrow('source')
    const bytes = files.get(revision.snapshotFileId)!.slice()
    bytes[0] = 0
    files.set(revision.snapshotFileId, bytes)
    await expect(downloadArchive(revision, remote, signal)).rejects.toThrow('checksum')
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
    expect(remote.uploadSnapshot).not.toHaveBeenCalled()
    expect(remote.deleteSnapshot).not.toHaveBeenCalled()
  })
})

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
