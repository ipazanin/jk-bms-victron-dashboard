import { afterEach, describe, expect, it, vi } from 'vitest'
import { read, utils, write, type WorkBook } from 'xlsx'
import { unzipSync, zipSync } from 'fflate'
import { exportArchiveWorkbook, exportArchiveWorkbookBundle, importArchiveWorkbook, importArchiveWorkbookBundle } from '../src/infrastructure/backup/excel/archiveWorkbook'
import { encodeArchiveSnapshot } from '../src/domain/backup/archiveCodec'
import type { ArchiveSnapshot } from '../src/domain/backup/ArchiveSnapshot'
import { SNAPSHOT_SCHEMA_VERSION } from '../src/domain/schemaVersion'
import { battery, deviceInfo, deviceRecord, packChunk, packSamples, ringReadRow, ringRecordRow, SAMPLE_EPOCH, sessionRecord, solarChunk, solarSamples, SOLAR_DEVICE_KEY, warningRecord } from './support/samples'
import { CAPTURE_READ_ON_DATE, capturedTotals, dayReading } from './support/solarHistoryFixture'
import { exportArchiveWorkbooks, importArchiveWorkbooks } from '../src/infrastructure/backup/excel/archiveWorkbookClient'
import type { ArchiveWorkerResponse } from '../src/infrastructure/backup/excel/ArchiveWorkerResponse'
import { ArchiveZipWriter } from '../src/infrastructure/backup/excel/ArchiveZipWriter'

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
    preferences: [{ key: 'shunt.theme', value: 'dark' }],
  }
}

function alterWorkbook(bytes: Uint8Array, change: (workbook: WorkBook) => void): Uint8Array {
  const workbook = read(bytes, { type: 'array' })
  change(workbook)
  return new Uint8Array(write(workbook, { type: 'array', bookType: 'xlsx', compression: true }))
}

describe('readable Excel archives', () => {
  it('roundtrips every retained store, preference, nested record and original typed column exactly', () => {
    const original = snapshot()
    const exported = exportArchiveWorkbook(original)
    const imported = importArchiveWorkbook(exported.bytes)
    expect(imported).toEqual(original)
    expect(JSON.parse(encodeArchiveSnapshot(imported))).toEqual(JSON.parse(encodeArchiveSnapshot(original)))
    expect(exported.fileName).toMatch(/\.xlsx$/)
    expect(exported.partCount).toBe(1)
    expect(imported.stores.chunks[0]!.offsetMs).toBeInstanceOf(Uint32Array)
    expect(imported.stores.ringRecords[1]!.format).toBeUndefined()
    expect(Object.hasOwn(imported.stores.ringRecords[1]!, 'format')).toBe(true)
  })

  it('puts original integer samples and ordinary record fields into readable worksheet columns', () => {
    const workbook = read(exportArchiveWorkbook(snapshot()).bytes, { type: 'array' })
    const samples = utils.sheet_to_json<unknown[]>(workbook.Sheets['Pack Samples']!, { header: 1 })
    expect(samples[0]).toContain('currentMa')
    expect(samples[1]![samples[0]!.indexOf('currentMa')]).toBe(-8437)
    expect(samples[1]![samples[0]!.indexOf('mosfetDeciC')]).toBe(-123)
    const devices = utils.sheet_to_json(workbook.Sheets.Devices!)
    expect(devices[0]).toMatchObject({ userLabel: '=SUM(A1:A2)' })
    expect(Object.values(workbook.Sheets.Devices!).some((cell) => cell?.f)).toBe(false)
    expect(workbook.SheetNames).toContain('Solar Days')
    expect(workbook.SheetNames).toContain('Solar Reads')
  })

  it.each(['', '=not a formula '])('segments long Unicode metadata losslessly with prefix %j', (prefix) => {
    const original = snapshot()
    const expanded: ArchiveSnapshot = { ...original, stores: { ...original.stores, warnings: [warningRecord({ detail: prefix + '🌊'.repeat(40_000) })] } }
    const exported = exportArchiveWorkbook(expanded)
    const imported = importArchiveWorkbook(exported.bytes)
    expect(imported.stores.warnings[0]!.detail === expanded.stores.warnings[0]!.detail).toBe(true)
    expect(imported).toEqual(expanded)
    const workbook = read(exported.bytes, { type: 'array' })
    for (const sheet of Object.values(workbook.Sheets)) {
      for (const cell of Object.values(sheet)) if (typeof cell?.v === 'string') expect(cell.v.length).toBeLessThanOrEqual(30_000)
    }
  })

  it('exports an empty retained source without inventing records', () => {
    const original: ArchiveSnapshot = { ...snapshot(), stores: { sessions: [], chunks: [], devices: [], meta: [], warnings: [], ringRecords: [], ringReads: [] }, preferences: [] }
    expect(importArchiveWorkbook(exportArchiveWorkbook(original).bytes)).toEqual(original)
  })

  it('preserves safe additional metadata and strings matching workbook markers', () => {
    const original = snapshot()
    const expanded: ArchiveSnapshot = {
      ...original, exportedAt: original.exportedAt + 0.25,
      stores: {
        ...original.stores,
        devices: original.stores.devices.map((device) => ({ ...device, userLabel: '[see Field Metadata]' })),
        chunks: original.stores.chunks.map((chunk) => ({ ...chunk, calibrationBytes: new Uint16Array([0, 65535]), extra: { absent: undefined, text: 'a\r\nb\t\u0000c' } })),
        ringRecords: original.stores.ringRecords.map((record) => ({ ...record, $archiveRow: 'original metadata' })),
      },
    }
    expect(importArchiveWorkbook(exportArchiveWorkbook(expanded).bytes)).toEqual(expanded)
  })

  it('splits only between chunks and requires every numbered part', () => {
    const original = snapshot()
    const progress: number[] = []
    const exported = exportArchiveWorkbook(original, { sampleRowsPerPart: 1, archiveId: 'split-archive', onProgress: (event) => progress.push(event.completedParts) })
    expect(exported.partCount).toBe(2)
    expect(exported.fileName).toMatch(/\.zip$/)
    expect(progress).toEqual([1, 2])
    expect(importArchiveWorkbook(exported.bytes)).toEqual(original)
    const files = unzipSync(exported.bytes)
    expect(Object.keys(files)).toEqual(['part-0001.xlsx', 'part-0002.xlsx'])
    expect(() => importArchiveWorkbook(files['part-0001.xlsx']!)).toThrow(/every matching/)
    delete files['part-0001.xlsx']
    expect(() => importArchiveWorkbook(zipSync(files))).toThrow(/missing a workbook part/)
  })

  it('splits metadata independently of samples and preserves every store and ring row order', () => {
    const original = snapshot()
    const exported = exportArchiveWorkbook(original, { metadataRowsPerPart: 2, archiveId: 'metadata-parts' })
    expect(exported.partCount).toBe(5)
    expect(importArchiveWorkbook(exported.bytes)).toEqual(original)
    for (const bytes of Object.values(unzipSync(exported.bytes))) {
      const workbook = read(bytes, { type: 'array' })
      const recordSheets = ['Sessions', 'Devices', 'Totals', 'Warnings', 'Ring Records', 'Solar Days', 'Ring Reads', 'Solar Reads', 'Settings']
      const count = recordSheets.reduce((sum, sheet) => sum + utils.sheet_to_json(workbook.Sheets[sheet]!).length, 0)
      expect(count).toBeLessThanOrEqual(2)
    }
  })

  it('requires all metadata parts and validates aggregate record counts', () => {
    const exported = exportArchiveWorkbook(snapshot(), { metadataRowsPerPart: 2 })
    const missing = unzipSync(exported.bytes)
    delete missing['part-0005.xlsx']
    expect(() => importArchiveWorkbook(zipSync(missing))).toThrow(/every matching/)
    const edited = unzipSync(exported.bytes)
    edited['part-0005.xlsx'] = alterWorkbook(edited['part-0005.xlsx']!, (workbook) => {
      const headings = utils.sheet_to_json<unknown[]>(workbook.Sheets.Settings!, { header: 1 })[0]!
      workbook.Sheets.Settings = utils.aoa_to_sheet([headings])
    })
    expect(() => importArchiveWorkbook(zipSync(edited))).toThrow(/record count does not match/)
    const foreign = unzipSync(exportArchiveWorkbook(snapshot(), { metadataRowsPerPart: 2 }).bytes)
    edited['part-0005.xlsx'] = foreign['part-0005.xlsx']!
    expect(() => importArchiveWorkbook(zipSync(edited))).toThrow(/different archives/)
  })

  it('imports legacy manifests whose metadata is entirely in the first workbook', () => {
    const original = snapshot()
    const files = unzipSync(exportArchiveWorkbook(original, { sampleRowsPerPart: 2 }).bytes)
    for (const [name, bytes] of Object.entries(files)) {
      files[name] = alterWorkbook(bytes, (workbook) => {
        const rows = utils.sheet_to_json<unknown[]>(workbook.Sheets.Manifest!, { header: 1 })
        workbook.Sheets.Manifest = utils.aoa_to_sheet(rows.filter((row) => row[0] !== 'recordCounts'))
      })
    }
    expect(importArchiveWorkbook(zipSync(files))).toEqual(original)
  })

  it('rejects workbook parts from different exports even with matching counts', () => {
    const first = unzipSync(exportArchiveWorkbook(snapshot(), { sampleRowsPerPart: 2, archiveId: 'first' }).bytes)
    const second = unzipSync(exportArchiveWorkbook(snapshot(), { sampleRowsPerPart: 2, archiveId: 'second' }).bytes)
    expect(() => importArchiveWorkbook(zipSync({ ...first, 'part-0002.xlsx': second['part-0002.xlsx']! }))).toThrow(/different archives/)
  })

  it('bundles independent sources without conflating identical local keys', () => {
    const first = snapshot()
    const second: ArchiveSnapshot = { ...snapshot(), source: { id: 'second-source', label: 'Saved copy' }, stores: { ...snapshot().stores, devices: [deviceRecord({ userLabel: 'Other boat' }), deviceRecord({ key: SOLAR_DEVICE_KEY, kind: 'solar' })] } }
    const bundle = exportArchiveWorkbookBundle([first, second], { sampleRowsPerPart: 2 })
    expect(bundle.partCount).toBe(4)
    expect(importArchiveWorkbookBundle(bundle.bytes)).toEqual([first, second])
    expect(importArchiveWorkbookBundle(exportArchiveWorkbookBundle([first]).bytes)).toEqual([first])
    expect(() => exportArchiveWorkbookBundle([first, first])).toThrow(/distinct source IDs/)
    const files = unzipSync(bundle.bytes)
    delete files['source-0002.zip']
    expect(() => importArchiveWorkbookBundle(zipSync(files))).toThrow(/every matching source/)
  })

  it('rejects mixed source bundles and duplicate source IDs before returning an import', () => {
    const first = snapshot()
    const second: ArchiveSnapshot = { ...snapshot(), source: { id: 'second-source', label: 'Other boat' } }
    const bundle = unzipSync(exportArchiveWorkbookBundle([first, second], { archiveId: 'first-bundle' }).bytes)
    const other = unzipSync(exportArchiveWorkbookBundle([first, second], { archiveId: 'other-bundle' }).bytes)
    expect(() => importArchiveWorkbookBundle(zipSync({ ...bundle, 'source-0002.xlsx': other['source-0002.xlsx']! }))).toThrow(/different archive bundle/)
    bundle['source-0002.xlsx'] = alterWorkbook(bundle['source-0002.xlsx']!, (workbook) => {
      const rows = utils.sheet_to_json<unknown[]>(workbook.Sheets.Manifest!, { header: 1 })
      const index = rows.findIndex((row) => row[0] === 'sourceId')
      workbook.Sheets.Manifest![`B${index + 1}`] = { t: 's', v: first.source.id }
    })
    expect(() => importArchiveWorkbookBundle(zipSync(bundle))).toThrow(/duplicate source IDs/)
  })

  it.each(['Pack Samples', 'Devices', 'Manifest', 'Field Metadata'])('rejects formulas in authoritative %s cells', (sheet) => {
    const altered = alterWorkbook(exportArchiveWorkbook(snapshot()).bytes, (workbook) => {
      workbook.Sheets[sheet]!.A2 = { t: 'n', v: 0, f: '1-1' }
    })
    expect(() => importArchiveWorkbook(altered)).toThrow(/Formulas/)
  })

  it('rejects integer overflow before constructing sample arrays', () => {
    const altered = alterWorkbook(exportArchiveWorkbook(snapshot()).bytes, (workbook) => {
      workbook.Sheets['Pack Samples']!.D2 = { t: 'n', v: 2 ** 32 }
    })
    expect(() => importArchiveWorkbook(altered)).toThrow(/outside its range/)
  })

  it('rejects missing samples, unsupported schema versions and missing nested metadata', () => {
    const exported = exportArchiveWorkbook(snapshot())
    const missing = alterWorkbook(exported.bytes, (workbook) => {
      const rows = utils.sheet_to_json<unknown[]>(workbook.Sheets['Pack Samples']!, { header: 1 })
      rows.pop()
      workbook.Sheets['Pack Samples'] = utils.aoa_to_sheet(rows)
    })
    expect(() => importArchiveWorkbook(missing)).toThrow(/count does not match/)
    const version = alterWorkbook(exported.bytes, (workbook) => { workbook.Sheets.Manifest!.B3 = { t: 'n', v: 99 } })
    expect(() => importArchiveWorkbook(version)).toThrow(/Unsupported/)
    const metadata = alterWorkbook(exported.bytes, (workbook) => {
      workbook.Sheets['Field Metadata'] = utils.aoa_to_sheet([['Sheet', 'Record', 'Field', 'Kind', 'Segment', 'Value']])
    })
    expect(() => importArchiveWorkbook(metadata)).toThrow(/Missing field metadata/)
  })

  it('rejects unsafe ZIP paths and excessive declared worksheet dimensions', () => {
    expect(() => importArchiveWorkbook(zipSync({ '../part-0001.xlsx': new Uint8Array([0]) }))).toThrow(/Unsafe/)
    const files = unzipSync(exportArchiveWorkbook(snapshot()).bytes)
    const worksheet = new TextDecoder().decode(files['xl/worksheets/sheet3.xml'])
    files['xl/worksheets/sheet3.xml'] = new TextEncoder().encode(worksheet.replace(/<dimension ref="[^"]+"\/>/, '<dimension ref="A1:XFD1048576"/>'))
    expect(() => importArchiveWorkbook(zipSync(files))).toThrow(/dimensions/)
  })

  it('rejects duplicate ZIP names and excessive expansion before reading workbook content', () => {
    const zipped = zipSync({ 'a.xlsx': new Uint8Array([1]), 'b.xlsx': new Uint8Array([2]) })
    const duplicate = zipped.slice()
    const name = new TextEncoder().encode('b.xlsx')
    for (let index = 0; index <= duplicate.length - name.length; index += 1) {
      if (name.every((byte, offset) => duplicate[index + offset] === byte)) duplicate[index] = 'a'.charCodeAt(0)
    }
    expect(() => importArchiveWorkbook(duplicate)).toThrow(/duplicate ZIP entry/)
    expect(() => importArchiveWorkbook(zipSync({ 'part-0001.xlsx': new Uint8Array(2 * 1024 * 1024) }, { level: 9 }))).toThrow(/expansion/)
  })

  it('applies shared sample budgets and ZIP size limits in both directions', () => {
    const original = snapshot()
    expect(() => exportArchiveWorkbook(original, {}, { bytes: 0, samples: 10_000_000 })).toThrow(/sample count/)
    const exported = exportArchiveWorkbook(original)
    expect(() => importArchiveWorkbook(exported.bytes, {}, { bytes: 0, samples: 10_000_000 })).toThrow(/sample count/)
    expect(() => new ArchiveZipWriter(1, 1000).add('part.xlsx', new Uint8Array([1]))).toThrow(/file size/)
    expect(() => new ArchiveZipWriter(1000, 1).add('part.xlsx', new Uint8Array([1, 2]))).toThrow(/Expanded ZIP/)
  })
})

describe('archive worker client', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubWorker(): { terminate: ReturnType<typeof vi.fn>, postMessage: ReturnType<typeof vi.fn>, emit: (response: ArchiveWorkerResponse) => void } {
    let onmessage: ((event: MessageEvent<ArchiveWorkerResponse>) => void) | undefined
    const terminate = vi.fn()
    const postMessage = vi.fn()
    vi.stubGlobal('Worker', class {
      terminate = terminate
      postMessage = postMessage
      set onmessage(handler: (event: MessageEvent<ArchiveWorkerResponse>) => void) { onmessage = handler }
    })
    return { terminate, postMessage, emit: (response) => onmessage?.({ data: response } as MessageEvent<ArchiveWorkerResponse>) }
  }

  it('reports progress and returns a downloadable Blob without invoking save-only browser APIs', async () => {
    const worker = stubWorker()
    const progress = vi.fn()
    const pending = exportArchiveWorkbooks([snapshot()], { onProgress: progress })
    worker.emit({ kind: 'progress', progress: { phase: 'export', completedParts: 1, totalParts: 1 } })
    worker.emit({ kind: 'exported', file: { bytes: new Uint8Array([1, 2]), fileName: 'archive.xlsx', mimeType: 'application/example', partCount: 1 } })
    const downloaded = await pending
    expect(downloaded.blob.size).toBe(2)
    expect(downloaded.fileName).toBe('archive.xlsx')
    expect(progress).toHaveBeenCalledOnce()
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('terminates a busy worker immediately when cancelled', async () => {
    const worker = stubWorker()
    const cancellation = new AbortController()
    const pending = exportArchiveWorkbooks([snapshot()], { signal: cancellation.signal })
    cancellation.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('transfers a copy of an input buffer and propagates validation failures', async () => {
    const worker = stubWorker()
    const buffer = new Uint8Array([1, 2]).buffer
    const pending = importArchiveWorkbooks(buffer)
    expect(worker.postMessage.mock.calls[0]![0].bytes).not.toBe(buffer)
    worker.emit({ kind: 'error', message: 'Invalid archive' })
    await expect(pending).rejects.toThrow('Invalid archive')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('rejects oversized files before allocating an input buffer', async () => {
    const worker = stubWorker()
    const readBuffer = vi.fn(async () => new ArrayBuffer(0))
    class OversizedArchive extends Blob {
      override get size(): number { return 257 * 1024 * 1024 }
      override arrayBuffer = readBuffer
    }
    await expect(importArchiveWorkbooks(new OversizedArchive())).rejects.toThrow(/file size/)
    expect(readBuffer).not.toHaveBeenCalled()
    expect(worker.postMessage).not.toHaveBeenCalled()
  })
})
