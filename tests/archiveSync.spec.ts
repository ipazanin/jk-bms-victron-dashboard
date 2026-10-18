import { describe, expect, it, vi } from 'vitest'
import { publishArchive, downloadArchive } from '../src/application/sync/archiveSync'
import type { SyncRemote } from '../src/application/sync/SyncRemote'
import { hexToBytes } from '../src/domain/bytes'
import type { RingReadRow } from '../src/domain/history/RingReadRow'
import ring from './fixtures/ringLedger.json'
import type { ArchiveSnapshot } from '../src/domain/backup/ArchiveSnapshot'
import type { CloudArchiveRevision } from '../src/domain/sync/CloudArchiveRevision'
import type { CloudBlock } from '../src/domain/sync/CloudBlock'
import type { CloudSettingsRevision } from '../src/domain/sync/CloudSettingsRevision'
import { CLOUD_BLOCK_BYTES } from '../src/domain/sync/limits'
import { deviceRecord, packChunk, packSamples, SAMPLE_EPOCH, sessionRecord, warningRecord } from './support/samples'

const workspace = { id: 'sheet', name: 'Boat', folderId: 'folder' }

function snapshot(): ArchiveSnapshot {
  return {
    format: 'shunt-archive', version: 1, exportedAt: SAMPLE_EPOCH,
    source: { id: 'tablet', label: 'Boat tablet' },
    stores: {
      sessions: [sessionRecord({ packSamples: 2, packChunks: 1, sealedSamples: 2, state: 'closed', endedAt: SAMPLE_EPOCH + 1_000, endReason: 'user-disconnect' })],
      chunks: [packChunk(packSamples(2))], devices: [deviceRecord()],
      meta: [{ key: 'totals', schema: 1, totalSamples: 2, createdAt: SAMPLE_EPOCH, lastPrunedAt: null }],
      warnings: [warningRecord()], ringRecords: ring.records.map((record) => ({ ...record, bytes: hexToBytes(record.bytes) })), ringReads: ring.reads as RingReadRow[],
    },
    preferences: [{ key: 'shunt.theme', value: 'light' }],
  }
}

function setup() {
  const archives: CloudArchiveRevision[] = []
  const settings: CloudSettingsRevision[] = []
  const blocks: CloudBlock[] = []
  const files = new Map<string, Uint8Array>()
  const calls: string[] = []
  const controller = new AbortController()
  const remote = {
    readCatalog: vi.fn(async () => ({ archives, settings })),
    listBlocks: vi.fn(async () => blocks),
    uploadBlock: vi.fn(async (_workspace, bytes, hash) => {
      const block = { hash, size: bytes.byteLength, fileId: `file-${calls.length}` }
      calls.push('upload')
      files.set(block.fileId, new Uint8Array(bytes))
      blocks.push(block)
      return block
    }),
    downloadBlock: vi.fn(async (fileId, maxBytes) => {
      const bytes = files.get(fileId)
      if (bytes === undefined) throw new Error('Missing archive file')
      if (bytes.byteLength > maxBytes) throw new Error('Download too large')
      return bytes
    }),
    appendArchive: vi.fn(async (_workspace, revision) => {
      calls.push('publish')
      archives.push(revision)
    }),
    appendSettings: vi.fn(async (_workspace, revision) => { settings.push(revision) }),
  } satisfies SyncRemote
  return { remote, archives, blocks, files, calls, controller, signal: controller.signal }
}

describe('immutable cloud archive revisions', () => {
  it('publishes the catalogue last and restores every typed column exactly', async () => {
    const { remote, signal, calls } = setup()
    const original = snapshot()
    const revision = await publishArchive(original, workspace, remote, signal)
    expect(calls.at(-1)).toBe('publish')
    expect(revision).toMatchObject({ source: original.source, sessions: 1, samples: 2 })
    const restored = await downloadArchive(revision, remote, signal)
    expect(restored).toEqual(original)
    expect(restored.stores.chunks[0]!.offsetMs).toBeInstanceOf(Uint32Array)
  })

  it('splits an oversized record without truncating Unicode or extra metadata', async () => {
    const { remote, signal } = setup()
    const original = snapshot()
    const annotation = '🌊'.repeat(CLOUD_BLOCK_BYTES / 2)
    const expanded: ArchiveSnapshot = { ...original, stores: { ...original.stores, devices: [{ ...original.stores.devices[0]!, annotation } as typeof original.stores.devices[number]] } }
    const revision = await publishArchive(expanded, workspace, remote, signal)
    expect(remote.uploadBlock.mock.calls.every((call) => call[1].byteLength <= CLOUD_BLOCK_BYTES)).toBe(true)
    expect(remote.uploadBlock.mock.calls.some((call) => call[1].byteLength === CLOUD_BLOCK_BYTES)).toBe(true)
    expect(await downloadArchive(revision, remote, signal)).toEqual(expanded)
  })

  it('does not publish or upload again when only the capture time changed', async () => {
    const { remote, signal } = setup()
    const original = snapshot()
    const first = await publishArchive(original, workspace, remote, signal)
    remote.uploadBlock.mockClear()
    const second = await publishArchive({ ...original, exportedAt: SAMPLE_EPOCH + 1_000 }, workspace, remote, signal)
    expect(second).toEqual(first)
    expect(remote.uploadBlock).not.toHaveBeenCalled()
    expect(remote.appendArchive).toHaveBeenCalledTimes(1)
  })

  it('compares with the last catalogue row after the device clock moved backwards', async () => {
    const { remote, signal, archives } = setup()
    const original = snapshot()
    await publishArchive({ ...original, exportedAt: original.exportedAt + 3_600_000, preferences: [{ key: 'shunt.theme', value: 'dark' }] }, workspace, remote, signal)
    await publishArchive(original, workspace, remote, signal)
    await publishArchive({ ...original, exportedAt: original.exportedAt + 60_000 }, workspace, remote, signal)
    await publishArchive({ ...original, exportedAt: original.exportedAt + 120_000 }, workspace, remote, signal)
    expect(archives).toHaveLength(2)
  })

  it('reuses the block with the smallest file ID when Drive lists several copies', async () => {
    const { remote, signal, archives, blocks } = setup()
    const original = snapshot()
    await publishArchive(original, workspace, remote, signal)
    blocks.push({ ...blocks[0]!, fileId: 'zz-copy' })
    remote.uploadBlock.mockClear()
    const second = await publishArchive({ ...original, exportedAt: original.exportedAt + 60_000 }, workspace, remote, signal)
    expect(archives).toHaveLength(1)
    expect(second).toEqual(archives[0])
    expect(remote.uploadBlock).not.toHaveBeenCalled()
  })

  it('publishes repaired references when a previously uploaded block has disappeared', async () => {
    const { remote, signal, blocks, files } = setup()
    const original = snapshot()
    const first = await publishArchive(original, workspace, remote, signal)
    const lost = blocks.shift()!
    files.delete(lost.fileId)
    const repaired = await publishArchive({ ...original, exportedAt: original.exportedAt + 1 }, workspace, remote, signal)
    expect(repaired.contentHash).toBe(first.contentHash)
    expect(repaired.id).not.toBe(first.id)
    expect(await downloadArchive(repaired, remote, signal)).toEqual({ ...original, exportedAt: original.exportedAt + 1 })
  })

  it('keeps an earlier revision available after all local history was pruned', async () => {
    const { remote, signal, archives } = setup()
    const original = snapshot()
    const first = await publishArchive(original, workspace, remote, signal)
    const pruned: ArchiveSnapshot = { ...original, exportedAt: original.exportedAt + 1_000, stores: { sessions: [], chunks: [], devices: [], meta: [], warnings: [], ringRecords: [], ringReads: [] } }
    const second = await publishArchive(pruned, workspace, remote, signal)
    expect(archives).toHaveLength(2)
    expect(await downloadArchive(first, remote, signal)).toEqual(original)
    expect(await downloadArchive(second, remote, signal)).toEqual(pruned)
  })

  it('reuses unchanged groups when a setting changes and isolates foreign source revisions', async () => {
    const { remote, signal, archives } = setup()
    const original = snapshot()
    await publishArchive(original, workspace, remote, signal)
    remote.uploadBlock.mockClear()
    await publishArchive({ ...original, preferences: [{ key: 'shunt.theme', value: 'dark' }], exportedAt: original.exportedAt + 1 }, workspace, remote, signal)
    expect(remote.uploadBlock).toHaveBeenCalledTimes(1)
    await publishArchive({ ...original, source: { id: 'phone', label: 'Phone' } }, workspace, remote, signal)
    expect(archives.map((archive) => archive.source.id)).toEqual(['tablet', 'tablet', 'phone'])
  })

  it('reuses earlier session blocks when another recording is appended', async () => {
    const { remote, signal } = setup()
    const original = snapshot()
    await publishArchive(original, workspace, remote, signal)
    remote.uploadBlock.mockClear()
    const extended: ArchiveSnapshot = {
      ...original, exportedAt: original.exportedAt + 1000,
      stores: {
        ...original.stores,
        sessions: [...original.stores.sessions, { ...original.stores.sessions[0]!, id: 'next-session' }],
        chunks: [...original.stores.chunks, { ...original.stores.chunks[0]!, sessionId: 'next-session' }],
        meta: [{ ...original.stores.meta[0]!, totalSamples: 4 }],
      },
    }
    const revision = await publishArchive(extended, workspace, remote, signal)
    expect(remote.uploadBlock).toHaveBeenCalledTimes(4)
    const restored = await downloadArchive(revision, remote, signal)
    expect(restored.stores.sessions).toEqual(expect.arrayContaining([...extended.stores.sessions]))
    expect(restored.stores.chunks).toEqual(expect.arrayContaining([...extended.stores.chunks]))
  })

  it('rejects corrupt bytes and missing parts before returning an archive', async () => {
    const { remote, signal, files, blocks } = setup()
    const revision = await publishArchive(snapshot(), workspace, remote, signal)
    const block = blocks[0]!
    const bytes = files.get(block.fileId)!
    const corrupt = new Uint8Array(bytes)
    corrupt[0] = 0
    files.set(block.fileId, corrupt)
    await expect(downloadArchive(revision, remote, signal)).rejects.toThrow('checksum')
    files.delete(block.fileId)
    await expect(downloadArchive(revision, remote, signal)).rejects.toThrow('Missing archive file')
  })

  it('does not publish partial revisions after failed uploads or cancellation', async () => {
    const failed = setup()
    failed.remote.uploadBlock.mockRejectedValueOnce(new Error('Drive quota exceeded'))
    await expect(publishArchive(snapshot(), workspace, failed.remote, failed.signal)).rejects.toThrow('quota')
    expect(failed.remote.appendArchive).not.toHaveBeenCalled()
    const cancelled = setup()
    await expect(publishArchive(snapshot(), workspace, cancelled.remote, cancelled.signal, () => cancelled.controller.abort())).rejects.toThrow()
    expect(cancelled.remote.appendArchive).not.toHaveBeenCalled()
  })

  it('rejects metadata that names a different source or sample count', async () => {
    const { remote, signal } = setup()
    const revision = await publishArchive(snapshot(), workspace, remote, signal)
    await expect(downloadArchive({ ...revision, source: { id: 'other', label: 'Other' } }, remote, signal)).rejects.toThrow('source')
    await expect(downloadArchive({ ...revision, samples: 3 }, remote, signal)).rejects.toThrow('totals')
  })
})
