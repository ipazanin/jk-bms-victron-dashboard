import { afterEach, describe, expect, it, vi } from 'vitest'
import { gzipSync, gunzipSync } from 'fflate'
import { exportArchiveJson, importArchiveJson } from '../src/infrastructure/backup/json/archiveJson'
import { exportArchiveFile, importArchiveFile } from '../src/infrastructure/backup/json/archiveJsonClient'
import type { ArchiveWorkerResponse } from '../src/infrastructure/backup/json/ArchiveWorkerResponse'
import { MAX_ARCHIVE_FILE_BYTES, MAX_ARCHIVE_JSON_BYTES } from '../src/infrastructure/backup/json/limits'
import { encodeArchiveSnapshot, encodeArchiveValue } from '../src/domain/backup/archiveCodec'
import type { ArchiveSnapshot } from '../src/domain/backup/ArchiveSnapshot'
import { SNAPSHOT_SCHEMA_VERSION } from '../src/domain/schemaVersion'
import { battery, deviceInfo, deviceRecord, packChunk, packSamples, ringReadRow, ringRecordRow, SAMPLE_EPOCH, sessionRecord, solarChunk, solarSamples, SOLAR_DEVICE_KEY, warningRecord } from './support/samples'
import { CAPTURE_READ_ON_DATE, capturedTotals, dayReading } from './support/solarHistoryFixture'
import remembered from './fixtures/rememberedSession.json'

function snapshot(): ArchiveSnapshot {
  const day = dayReading(0).day
  if (!day.recorded) throw new Error('Expected captured recorded solar day')
  return {
    format: 'shunt-archive', version: 1, exportedAt: SAMPLE_EPOCH,
    source: { id: 'local-source', label: 'Boat archive' },
    stores: {
      sessions: [sessionRecord({ packSamples: 2, solarSamples: 2, packChunks: 1, solarChunks: 1, sealedSamples: 4, solarDeviceKey: SOLAR_DEVICE_KEY, finalBattery: battery(), deviceInfo: deviceInfo(), entries: [{ at: SAMPLE_EPOCH, kind: 'begin', level: 'neutral', text: 'Watch started' }] })],
      chunks: [packChunk(packSamples(2, { currentA: -8.437, mosfetTemperatureC: -12.3 }), { baseMonotonic: 123.456 }), solarChunk(solarSamples(2, { pvPowerW: null, loadCurrentA: null, batteryCurrentA: null, batteryVoltageV: null, yieldTodayKwh: null }))],
      devices: [deviceRecord({ userLabel: '=SUM(A1:A2)' }), deviceRecord({ key: SOLAR_DEVICE_KEY, kind: 'solar' })],
      meta: [{ key: 'totals', schema: SNAPSHOT_SCHEMA_VERSION, totalSamples: 4, createdAt: SAMPLE_EPOCH, lastPrunedAt: null }],
      warnings: [warningRecord()],
      ringRecords: [
        { deviceKey: SOLAR_DEVICE_KEY, format: 'solar-day', seq: 0, date: CAPTURE_READ_ON_DATE, day, firstReadAt: SAMPLE_EPOCH, revisedAt: SAMPLE_EPOCH },
        ringRecordRow({ format: undefined }),
      ],
      ringReads: [ringReadRow(), {
        deviceKey: SOLAR_DEVICE_KEY, observedAt: SAMPLE_EPOCH, format: 'solar-day', outcome: 'days-read', readOnDate: CAPTURE_READ_ON_DATE,
        totals: capturedTotals, daysReceived: 1, daysAppended: 1, daysRevised: 0, daysUnchanged: 0, daysUnwritten: 0, daysRedated: 0,
        refusedRegisters: [], notificationBytes: 34, notificationCount: 1, controlNotificationCount: 0, pduCount: 1, unreadableReplyCount: 0, elapsedMs: 123.5,
      }],
    },
    preferences: [
      { key: 'shunt.theme', value: 'dark' },
      { key: 'shunt.sidebar', value: 'collapsed' },
      { key: 'shunt.statsPreferences', value: JSON.stringify({ version: 1, range: 'all', custom: null, pack: null }, null, 2) },
      { key: 'shunt.rememberedSession', value: JSON.stringify({ ...remembered, capturedAt: SAMPLE_EPOCH }) },
      { key: 'shunt.logbook', value: JSON.stringify({ fetchedAt: SAMPLE_EPOCH, uptimeSecondsAtFetch: null, events: [] }) },
      { key: 'shunt.lastBmsDevice', value: JSON.stringify({ id: 'origin-only-pack', name: 'Pack', at: SAMPLE_EPOCH }) },
      { key: 'shunt.lastSolarController', value: JSON.stringify({ id: 'origin-only-solar', name: null, at: SAMPLE_EPOCH }) },
      { key: 'shunt.rejoinArmed', value: 'off' },
      { key: 'victron.advertisementKey', value: 'a'.repeat(32) },
    ],
  }
}

describe('compressed JSON archives', () => {
  it('round trips every store, settings string, typed column and explicitly absent metadata', () => {
    const original = snapshot()
    const archive = exportArchiveJson([original])
    const [restored] = importArchiveJson(archive.bytes)
    expect(restored).toEqual(original)
    expect(restored!.stores.chunks[0]!.offsetMs).toBeInstanceOf(Uint32Array)
    expect(Object.hasOwn(restored!.stores.ringRecords[1]!, 'format')).toBe(true)
    expect(archive.fileName).toMatch(/\.json\.gz$/)
    expect(archive.mimeType).toBe('application/gzip')
    expect(new TextDecoder().decode(gunzipSync(archive.bytes))).toBe(encodeArchiveSnapshot(original))
  })

  it('imports existing snapshot JSON without a wrapper or filename dependency', () => {
    const original = snapshot()
    const json = new TextEncoder().encode(encodeArchiveSnapshot(original))
    expect(importArchiveJson(json.buffer)).toEqual([original])
    expect(importArchiveJson(gzipSync(json))).toEqual([original])
  })

  it('preserves source order and overlapping local identities in compressed and plain multi-source archives', () => {
    const first = snapshot()
    const second = { ...first, source: { id: 'second-browser', label: 'Phone' } }
    const archives = [second, first]
    const exported = exportArchiveJson(archives)
    expect(JSON.parse(new TextDecoder().decode(gunzipSync(exported.bytes)))).toHaveLength(2)
    expect(importArchiveJson(exported.bytes)).toEqual(archives)
    expect(importArchiveJson(new TextEncoder().encode(encodeArchiveValue(archives)))).toEqual(archives)
  })

  it('preserves Unicode, optional properties and typed-array slices without unrelated bytes', () => {
    const original = snapshot()
    const expanded: ArchiveSnapshot = {
      ...original,
      stores: {
        ...original.stores,
        warnings: [warningRecord({ detail: '🌊'.repeat(40_000) })],
        chunks: original.stores.chunks.map((chunk) => ({
          ...chunk,
          calibrationBytes: new Uint16Array([99, 0, 65535, 88]).subarray(1, 3),
          extra: { absent: undefined, text: 'a\r\nb\t\u0000c' },
        })),
      },
    }
    expect(importArchiveJson(exportArchiveJson([expanded]).bytes)).toEqual([expanded])
  })

  it('exports an empty retained source without inventing records', () => {
    const original: ArchiveSnapshot = { ...snapshot(), stores: { sessions: [], chunks: [], devices: [], meta: [], warnings: [], ringRecords: [], ringReads: [] }, preferences: [] }
    expect(importArchiveJson(exportArchiveJson([original]).bytes)).toEqual([original])
  })

  it('rejects empty, excessive and duplicate sources in both directions', () => {
    const original = snapshot()
    for (const archives of [[], [original, original], Array.from({ length: 101 }, (_, index) => ({ ...original, source: { id: `source-${index}`, label: 'Archive' } }))]) {
      expect(() => exportArchiveJson(archives)).toThrow(/sources|source IDs/)
      expect(() => importArchiveJson(new TextEncoder().encode(encodeArchiveValue(archives)))).toThrow(/sources|source IDs/)
    }
  })

  it('rejects unsupported schema versions and invalid typed arrays before returning any sources', () => {
    const original = snapshot()
    const invalidVersion = { ...original, version: 2 }
    expect(() => importArchiveJson(new TextEncoder().encode(encodeArchiveValue([original, invalidVersion])))).toThrow()
    const encoded = JSON.parse(encodeArchiveSnapshot(original))
    encoded.stores.chunks[0].offsetMs.values[0] = -1
    expect(() => importArchiveJson(new TextEncoder().encode(JSON.stringify(encoded)))).toThrow(/typed array integer/)
  })

  it('rejects malformed JSON, unsafe property names and invalid UTF-8', () => {
    for (const json of ['{', '{"__proto__":{}}', '{"$undefined":false}']) {
      expect(() => importArchiveJson(new TextEncoder().encode(json))).toThrow()
    }
    expect(() => importArchiveJson(new Uint8Array([0xff]))).toThrow()
    expect(() => importArchiveJson(new Uint8Array())).toThrow(/file size/)
  })

  it('rejects missing trailers, corrupt payloads and appended bytes', () => {
    const archive = exportArchiveJson([snapshot()]).bytes
    const corrupt = archive.slice()
    corrupt[corrupt.length - 8] = corrupt[corrupt.length - 8]! ^ 0xff
    for (const bytes of [archive.slice(0, -8), corrupt, new Uint8Array([...archive, 0])]) {
      expect(() => importArchiveJson(bytes)).toThrow()
    }
  })

  it('rejects gzip declarations above the expanded JSON limit before allocating that size', () => {
    const archive = exportArchiveJson([snapshot()]).bytes
    new DataView(archive.buffer, archive.byteOffset, archive.byteLength).setUint32(archive.byteLength - 4, MAX_ARCHIVE_JSON_BYTES + 1, true)
    expect(() => importArchiveJson(archive)).toThrow(/size limit/)
  })
})

describe('archive worker client', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubWorker() {
    let onmessage: ((event: MessageEvent<ArchiveWorkerResponse>) => void) | undefined
    let onerror: ((event: ErrorEvent) => void) | undefined
    const terminate = vi.fn()
    const postMessage = vi.fn()
    const constructor = vi.fn()
    vi.stubGlobal('Worker', class {
      constructor() { constructor() }
      terminate = terminate
      postMessage = postMessage
      set onmessage(handler: (event: MessageEvent<ArchiveWorkerResponse>) => void) { onmessage = handler }
      set onerror(handler: (event: ErrorEvent) => void) { onerror = handler }
    })
    return {
      terminate, postMessage, constructor,
      emit: (response: ArchiveWorkerResponse) => onmessage?.({ data: response } as MessageEvent<ArchiveWorkerResponse>),
      fail: () => onerror?.({ message: 'Worker failed' } as ErrorEvent),
    }
  }

  it('returns a downloadable gzip Blob and terminates the worker after export', async () => {
    const worker = stubWorker()
    const pending = exportArchiveFile([snapshot()])
    worker.emit({ kind: 'exported', file: { bytes: new Uint8Array([1, 2]), fileName: 'archive.json.gz', mimeType: 'application/gzip' } })
    const downloaded = await pending
    expect(downloaded.blob.size).toBe(2)
    expect(downloaded.blob.type).toBe('application/gzip')
    expect(downloaded.fileName).toBe('archive.json.gz')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('terminates a busy worker immediately when cancelled', async () => {
    const worker = stubWorker()
    const cancellation = new AbortController()
    const pending = exportArchiveFile([snapshot()], cancellation.signal)
    cancellation.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('does not start a worker for a cancelled operation or after cancellation during a file read', async () => {
    const worker = stubWorker()
    const cancellation = new AbortController()
    cancellation.abort()
    await expect(exportArchiveFile([snapshot()], cancellation.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(importArchiveFile(new ArrayBuffer(2), cancellation.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const duringRead = new AbortController()
    const file = new Blob(['{}'])
    vi.spyOn(file, 'arrayBuffer').mockImplementation(async () => {
      duringRead.abort()
      return new ArrayBuffer(2)
    })
    await expect(importArchiveFile(file, duringRead.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.constructor).not.toHaveBeenCalled()
  })

  it('transfers a copy of the input buffer and propagates validation failures', async () => {
    const worker = stubWorker()
    const buffer = new Uint8Array([1, 2]).buffer
    const pending = importArchiveFile(buffer)
    const [request, transfers] = worker.postMessage.mock.calls[0]!
    expect(request.bytes).not.toBe(buffer)
    expect(transfers).toEqual([request.bytes])
    worker.emit({ kind: 'error', message: 'Invalid archive' })
    await expect(pending).rejects.toThrow('Invalid archive')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('terminates the worker when posting or executing a request fails', async () => {
    const worker = stubWorker()
    worker.postMessage.mockImplementationOnce(() => { throw new Error('Could not clone snapshot') })
    await expect(exportArchiveFile([snapshot()])).rejects.toThrow('Could not clone snapshot')
    const pending = importArchiveFile(new ArrayBuffer(2))
    worker.fail()
    await expect(pending).rejects.toThrow('Worker failed')
    expect(worker.terminate).toHaveBeenCalledTimes(2)
  })

  it('rejects oversized files before allocating an input buffer', async () => {
    const worker = stubWorker()
    const readBuffer = vi.fn(async () => new ArrayBuffer(0))
    class OversizedArchive extends Blob {
      override get size(): number { return MAX_ARCHIVE_FILE_BYTES + 1 }
      override arrayBuffer = readBuffer
    }
    await expect(importArchiveFile(new OversizedArchive())).rejects.toThrow(/file size/)
    expect(readBuffer).not.toHaveBeenCalled()
    expect(worker.constructor).not.toHaveBeenCalled()
  })
})
