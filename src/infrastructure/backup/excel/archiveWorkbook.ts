import { read, utils, write, type WorkBook } from 'xlsx'
import { unzipSync, type UnzipFileInfo } from 'fflate'
import type { ArchiveSnapshot } from '../../../domain/backup/ArchiveSnapshot'
import { decodeArchiveValue, validateArchiveSnapshot } from '../../../domain/backup/archiveCodec'
import type { HistoryChunk } from '../../../domain/history/types'
import { appendTable, readRecordTables, readTable, requireHeader, writeRecordTables } from './workbookTables'
import type { ArchiveWorkbookFile } from './ArchiveWorkbookFile'
import type { ArchiveWorkbookOptions } from './ArchiveWorkbookOptions'
import type { ArchivePart } from './ArchivePart'
import type { ArchiveExpansionBudget } from './ArchiveExpansionBudget'
import type { TableRecord } from './TableRecord'
import type { TableRow } from './TableRow'
import { ArchiveZipWriter } from './ArchiveZipWriter'
import { MAX_ARCHIVE_FILE_BYTES } from './limits'

const MAX_WORKBOOK_XML_BYTES = 128 * 1024 * 1024
const MAX_ARCHIVE_ZIP_BYTES = 2 * 1024 * 1024 * 1024
const MAX_EXPANDED_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024
const MAX_ARCHIVE_SAMPLES = 10_000_000
const MAX_ARCHIVE_PARTS = 500
const MAX_SAMPLE_ROWS = 50_000
const MAX_METADATA_ROWS = 10_000
const LEGACY_MANIFEST_FIELDS = ['format', 'version', 'archiveId', 'part', 'parts', 'exportedAt', 'sourceId', 'sourceLabel', 'sampleRows', 'totalSampleRows']
const MANIFEST_FIELDS = [...LEGACY_MANIFEST_FIELDS, 'recordCounts']
const TABLE_STORES = { Sessions: 'sessions', Devices: 'devices', Totals: 'meta', Warnings: 'warnings' } as const
const RECORD_SHEETS = [...Object.keys(TABLE_STORES), 'Ring Records', 'Solar Days', 'Ring Reads', 'Solar Reads', 'Settings', 'Chunks']
const ALL_SHEETS = ['Manifest', ...RECORD_SHEETS, 'Field Metadata', 'Record Order', 'Pack Samples', 'Solar Samples']
const RECORD_ORDER_HEADER = ['Store', 'Record', 'Sheet', 'Sheet Record']
const PACK_COLUMNS = { offsetMs: 'Uint32Array', currentMa: 'Int32Array', packVoltageMv: 'Uint32Array', remainingCapacityMah: 'Uint32Array', cellDeltaMv: 'Uint16Array', mosfetDeciC: 'Int16Array', temperature1DeciC: 'Int16Array', temperature2DeciC: 'Int16Array', stateOfCharge: 'Uint8Array', highestCell: 'Uint8Array', lowestCell: 'Uint8Array', switches: 'Uint8Array' } as const
const SOLAR_COLUMNS = { offsetMs: 'Uint32Array', batteryVoltageCv: 'Int16Array', batteryCurrentDa: 'Int16Array', yieldTodayHwh: 'Uint16Array', pvPowerW: 'Uint16Array', loadCurrentDa: 'Uint16Array', chargeStateCode: 'Uint8Array', chargerError: 'Uint8Array', rssiDbm: 'Int8Array' } as const

export function exportArchiveWorkbook(snapshot: ArchiveSnapshot, options: ArchiveWorkbookOptions = {}, expansionBudget: ArchiveExpansionBudget = { bytes: 0, samples: 0 }): ArchiveWorkbookFile {
  validateArchiveSnapshot(snapshot)
  const rowLimit = options.sampleRowsPerPart ?? MAX_SAMPLE_ROWS
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > MAX_SAMPLE_ROWS) throw new Error('Invalid sample rows per workbook')
  const metadataLimit = options.metadataRowsPerPart ?? MAX_METADATA_ROWS
  if (!Number.isSafeInteger(metadataLimit) || metadataLimit < 1 || metadataLimit > MAX_METADATA_ROWS) throw new Error('Invalid metadata rows per workbook')
  const recordsByStore: Record<string, readonly object[]> = { ...snapshot.stores, preferences: snapshot.preferences }
  delete recordsByStore.chunks
  const recordsByPart: Record<string, object[]>[] = [{}]
  let metadataRows = 0
  for (const [store, records] of Object.entries(recordsByStore)) {
    for (const record of records) {
      if (metadataRows === metadataLimit) {
        recordsByPart.push({})
        metadataRows = 0
      }
      const part = recordsByPart[recordsByPart.length - 1]!
      const rows = part[store] ??= []
      rows.push(record)
      metadataRows += 1
    }
  }
  const recordCounts = JSON.stringify(Object.fromEntries(Object.entries(recordsByStore).map(([store, records]) => [store, records.length])))
  const chunksByPart: HistoryChunk[][] = [[]]
  let partRows = 0
  for (const chunk of snapshot.stores.chunks) {
    if (chunk.length > MAX_SAMPLE_ROWS) throw new Error('A chunk exceeds the workbook sample limit')
    if (partRows > 0 && partRows + chunk.length > rowLimit) {
      chunksByPart.push([])
      partRows = 0
    }
    chunksByPart[chunksByPart.length - 1]!.push(chunk)
    partRows += chunk.length
  }
  const partCount = Math.max(chunksByPart.length, recordsByPart.length)
  if (partCount > MAX_ARCHIVE_PARTS) throw new Error('Archive needs too many workbook parts')
  const archiveId = options.archiveId ?? crypto.randomUUID()
  const totalSampleRows = snapshot.stores.chunks.reduce((count, chunk) => count + chunk.length, 0)
  expansionBudget.samples += totalSampleRows
  if (expansionBudget.samples > MAX_ARCHIVE_SAMPLES) throw new Error('Archive exceeds the supported sample count')
  const zip = partCount > 1 ? new ArchiveZipWriter(MAX_ARCHIVE_FILE_BYTES, MAX_ARCHIVE_ZIP_BYTES) : undefined
  let singleWorkbook: Uint8Array<ArrayBuffer> | undefined
  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    const chunks = chunksByPart[partIndex] ?? []
    const metadata = recordsByPart[partIndex] ?? {}
    const workbook = utils.book_new()
    const manifest: TableRecord = {
      format: 'shunt-excel-archive', version: 1, archiveId, part: partIndex + 1, parts: partCount,
      exportedAt: snapshot.exportedAt, sourceId: snapshot.source.id, sourceLabel: snapshot.source.label,
      sampleRows: chunks.reduce((count, chunk) => count + chunk.length, 0), totalSampleRows, recordCounts,
    }
    appendTable(workbook, 'Manifest', [['Field', 'Value'], ...MANIFEST_FIELDS.map((field) => [field, manifest[field]] as TableRow)])
    const tables: Record<string, readonly object[]> = {}
    for (const [name, store] of Object.entries(TABLE_STORES)) tables[name] = metadata[store] ?? []
    const recordOrder: TableRow[] = [RECORD_ORDER_HEADER]
    for (const [store, packSheet, solarSheet] of [['ringRecords', 'Ring Records', 'Solar Days'], ['ringReads', 'Ring Reads', 'Solar Reads']] as const) {
      const packRows: object[] = []
      const solarRows: object[] = []
      for (const [index, record] of (metadata[store] ?? []).entries()) {
        const solar = 'format' in record && record.format === 'solar-day'
        const rows = solar ? solarRows : packRows
        recordOrder.push([store, index, solar ? solarSheet : packSheet, rows.length])
        rows.push(record)
      }
      tables[packSheet] = packRows
      tables[solarSheet] = solarRows
    }
    tables.Settings = metadata.preferences ?? []
    tables.Chunks = chunks.map((chunk) => {
      const columns = chunk.stream === 'pack' ? PACK_COLUMNS : SOLAR_COLUMNS
      return Object.fromEntries(Object.entries(chunk).filter(([field]) => !Object.hasOwn(columns, field)))
    })
    writeRecordTables(workbook, tables)
    appendTable(workbook, 'Record Order', recordOrder)
    writeSamples(workbook, chunks, 'pack')
    writeSamples(workbook, chunks, 'solar')
    const bytes = new Uint8Array(write(workbook, { type: 'array', bookType: 'xlsx', compression: true }))
    inspectZip(bytes, 100, (size) => {
      expansionBudget.bytes += size
      if (expansionBudget.bytes > MAX_EXPANDED_ARCHIVE_BYTES) throw new Error('Expanded archive exceeds the supported limit')
    })
    if (bytes.byteLength > MAX_ARCHIVE_FILE_BYTES) throw new Error('Archive exceeds the supported file size')
    if (zip) zip.add(partFileName(partIndex + 1), bytes)
    else singleWorkbook = bytes
    options.onProgress?.({ phase: 'export', completedParts: partIndex + 1, totalParts: partCount })
  }
  const stamp = new Date(snapshot.exportedAt).toISOString().replace(/[:.]/g, '-')
  if (!zip) return { bytes: singleWorkbook!, fileName: `shunt-archive-${stamp}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', partCount: 1 }
  const bytes = zip.finish()
  return { bytes, fileName: `shunt-archive-${stamp}.zip`, mimeType: 'application/zip', partCount }
}

export function importArchiveWorkbook(input: ArrayBuffer | Uint8Array, options: Pick<ArchiveWorkbookOptions, 'onProgress' | 'archiveId'> = {}, expansionBudget: ArchiveExpansionBudget = { bytes: 0, samples: 0 }): ArchiveSnapshot {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_FILE_BYTES) throw new Error('Archive file size is outside the supported limits')
  const names = inspectZip(bytes, MAX_ARCHIVE_PARTS + 100, undefined, MAX_ARCHIVE_ZIP_BYTES)
  const singleWorkbook = names.includes('[Content_Types].xml')
  if (!singleWorkbook && names.some((name) => !/^part-\d{4}\.xlsx$/.test(name))) throw new Error('Unexpected file in archive ZIP')
  const orderedNames = singleWorkbook ? [partFileName(1)] : names.sort()
  if (orderedNames.length === 0 || orderedNames.length > MAX_ARCHIVE_PARTS) throw new Error('Invalid number of workbook parts')
  const parts: ArchivePart[] = []
  for (const [index, name] of orderedNames.entries()) {
    if (name !== partFileName(index + 1)) throw new Error('Archive is missing a workbook part')
    const workbookBytes = singleWorkbook ? bytes : unzipSync(bytes, { filter: (entry) => entry.name === name })[name]!
    inspectZip(workbookBytes, 100, (size) => {
      expansionBudget.bytes += size
      if (expansionBudget.bytes > MAX_EXPANDED_ARCHIVE_BYTES) throw new Error('Expanded archive exceeds the supported limit')
    })
    const workbook = read(workbookBytes, { type: 'array', dense: true, cellFormula: true, cellHTML: false, cellText: false, cellNF: false, bookVBA: false })
    if (JSON.stringify([...workbook.SheetNames].sort()) !== JSON.stringify([...ALL_SHEETS].sort())) throw new Error('Unexpected or missing archive worksheets')
    const part = readPart(workbook)
    expansionBudget.samples += Number(part.manifest.sampleRows)
    if (expansionBudget.samples > MAX_ARCHIVE_SAMPLES) throw new Error('Archive exceeds the supported sample count')
    if (options.archiveId !== undefined && part.manifest.archiveId !== options.archiveId) throw new Error('Workbook source belongs to a different archive bundle')
    if (part.manifest.part !== index + 1 || part.manifest.parts !== orderedNames.length) throw new Error('Archive requires every matching workbook part')
    if (parts[0]) {
      for (const field of MANIFEST_FIELDS.filter((field) => field !== 'part' && field !== 'sampleRows')) {
        if (part.manifest[field] !== parts[0].manifest[field]) throw new Error('Workbook parts belong to different archives')
      }
      if (part.manifest.recordCounts === undefined) {
        for (const sheet of RECORD_SHEETS.filter((sheet) => sheet !== 'Chunks')) {
          if (part.records[sheet]!.length !== 0) throw new Error('Legacy archive metadata must appear only in its first part')
        }
      }
    }
    parts.push(part)
    options.onProgress?.({ phase: 'import', completedParts: index + 1, totalParts: orderedNames.length })
  }
  const first = parts[0]!
  const stores: TableRecord = {}
  for (const [name, store] of Object.entries(TABLE_STORES)) stores[store] = parts.flatMap((part) => part.records[name]!)
  stores.ringRecords = parts.flatMap((part) => part.storedRows.ringRecords)
  stores.ringReads = parts.flatMap((part) => part.storedRows.ringReads)
  const preferences = parts.flatMap((part) => part.records.Settings!)
  if (typeof first.manifest.recordCounts === 'string') {
    const counts = decodeArchiveValue(first.manifest.recordCounts)
    const recordsByStore: Record<string, unknown> = { ...stores, preferences }
    if (counts === null || typeof counts !== 'object' || JSON.stringify(Object.keys(counts).sort()) !== JSON.stringify(Object.keys(recordsByStore).sort())) throw new Error('Invalid archive record counts')
    for (const [store, count] of Object.entries(counts)) {
      if (count !== (recordsByStore[store] as unknown[]).length) throw new Error('Archive record count does not match its manifest')
    }
  }
  const chunks = parts.flatMap((part) => part.chunks)
  stores.chunks = chunks
  if (chunks.reduce((count, chunk) => count + Number(chunk.length), 0) !== first.manifest.totalSampleRows) throw new Error('Archive sample total does not match its manifest')
  const snapshot: unknown = {
    format: 'shunt-archive', version: 1, exportedAt: first.manifest.exportedAt,
    source: { id: first.manifest.sourceId, label: first.manifest.sourceLabel }, stores, preferences,
  }
  validateArchiveSnapshot(snapshot)
  return snapshot
}

export function exportArchiveWorkbookBundle(snapshots: readonly ArchiveSnapshot[], options: ArchiveWorkbookOptions = {}): ArchiveWorkbookFile {
  if (snapshots.length === 0 || snapshots.length > 100) throw new Error('Select between 1 and 100 archive sources')
  if (snapshots.length === 1) return exportArchiveWorkbook(snapshots[0]!, options)
  if (new Set(snapshots.map((snapshot) => snapshot.source.id)).size !== snapshots.length) throw new Error('Archive sources must have distinct source IDs')
  const zip = new ArchiveZipWriter(MAX_ARCHIVE_FILE_BYTES, MAX_ARCHIVE_ZIP_BYTES)
  const names: string[] = []
  const archiveId = options.archiveId ?? crypto.randomUUID()
  const expansionBudget: ArchiveExpansionBudget = { bytes: 0, samples: 0 }
  let partCount = 0
  for (const [index, snapshot] of snapshots.entries()) {
    const sourceOptions: ArchiveWorkbookOptions = {
      archiveId: `${archiveId}/${index + 1}`,
      ...(options.sampleRowsPerPart === undefined ? {} : { sampleRowsPerPart: options.sampleRowsPerPart }),
      ...(options.metadataRowsPerPart === undefined ? {} : { metadataRowsPerPart: options.metadataRowsPerPart }),
    }
    const archive = exportArchiveWorkbook(snapshot, sourceOptions, expansionBudget)
    const name = `source-${String(index + 1).padStart(4, '0')}.${archive.partCount === 1 ? 'xlsx' : 'zip'}`
    names.push(name)
    zip.add(name, archive.bytes)
    partCount += archive.partCount
    options.onProgress?.({ phase: 'export', completedParts: index + 1, totalParts: snapshots.length })
  }
  zip.add('manifest.json', new TextEncoder().encode(JSON.stringify({ format: 'shunt-excel-bundle', version: 1, archiveId, files: names })))
  const bytes = zip.finish()
  return { bytes, fileName: 'shunt-archives.zip', mimeType: 'application/zip', partCount }
}

export function importArchiveWorkbookBundle(input: ArrayBuffer | Uint8Array, options: Pick<ArchiveWorkbookOptions, 'onProgress'> = {}): readonly ArchiveSnapshot[] {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_FILE_BYTES) throw new Error('Archive file size is outside the supported limits')
  const names = inspectZip(bytes, MAX_ARCHIVE_PARTS + 100, undefined, MAX_ARCHIVE_ZIP_BYTES)
  if (!names.includes('manifest.json') && !names.some((name) => name.startsWith('source-'))) return [importArchiveWorkbook(bytes, options)]
  if (names.length > 101 || names.some((name) => name !== 'manifest.json' && !/^source-\d{4}\.(xlsx|zip)$/.test(name))) throw new Error('Unexpected file in source bundle')
  const manifestBytes = unzipSync(bytes, { filter: (entry) => entry.name === 'manifest.json' })['manifest.json']
  if (!manifestBytes || manifestBytes.length > 30_000) throw new Error('Missing or invalid source bundle manifest')
  const manifest: unknown = JSON.parse(new TextDecoder().decode(manifestBytes))
  if (!manifest || typeof manifest !== 'object' || !('format' in manifest) || manifest.format !== 'shunt-excel-bundle' || !('version' in manifest) || manifest.version !== 1 || !('archiveId' in manifest) || typeof manifest.archiveId !== 'string' || !manifest.archiveId || !('files' in manifest) || !Array.isArray(manifest.files)) throw new Error('Invalid source bundle manifest')
  const sourceNames = names.filter((name) => name !== 'manifest.json').sort()
  if (sourceNames.length < 2 || JSON.stringify(manifest.files) !== JSON.stringify(sourceNames)) throw new Error('Archive bundle requires every matching source file')
  const snapshots: ArchiveSnapshot[] = []
  const expansionBudget: ArchiveExpansionBudget = { bytes: 0, samples: 0 }
  for (const [index, name] of sourceNames.entries()) {
    if (!name.startsWith(`source-${String(index + 1).padStart(4, '0')}.`)) throw new Error('Missing or duplicate archive source')
    const sourceBytes = unzipSync(bytes, { filter: (entry) => entry.name === name })[name]!
    const snapshot = importArchiveWorkbook(sourceBytes, { archiveId: `${manifest.archiveId}/${index + 1}` }, expansionBudget)
    if (snapshots.some((previous) => previous.source.id === snapshot.source.id)) throw new Error('Archive bundle has duplicate source IDs')
    snapshots.push(snapshot)
    options.onProgress?.({ phase: 'import', completedParts: index + 1, totalParts: sourceNames.length })
  }
  return snapshots
}

function writeSamples(workbook: WorkBook, chunks: readonly HistoryChunk[], stream: 'pack' | 'solar'): void {
  const columns = Object.keys(stream === 'pack' ? PACK_COLUMNS : SOLAR_COLUMNS)
  const rows: TableRow[] = [['Chunk', 'Row', ...columns]]
  chunks.forEach((chunk, chunkIndex) => {
    if (chunk.stream !== stream) return
    const fields = chunk as unknown as Record<string, ArrayLike<number>>
    for (let row = 0; row < chunk.length; row += 1) rows.push([chunkIndex, row, ...columns.map((column) => fields[column]![row]!)])
  })
  appendTable(workbook, stream === 'pack' ? 'Pack Samples' : 'Solar Samples', rows)
}

function readPart(workbook: WorkBook): ArchivePart {
  const manifestRows = readTable(workbook, 'Manifest')
  requireHeader(manifestRows, ['Field', 'Value'], 'Manifest')
  const fields = manifestRows.length === LEGACY_MANIFEST_FIELDS.length + 1 ? LEGACY_MANIFEST_FIELDS : MANIFEST_FIELDS
  if (manifestRows.length !== fields.length + 1) throw new Error('Invalid archive manifest')
  const manifest: TableRecord = Object.create(null)
  manifestRows.slice(1).forEach((row, index) => {
    if (row.length !== 2 || row[0] !== fields[index]) throw new Error('Invalid archive manifest fields')
    manifest[row[0] as string] = row[1]
  })
  if (manifest.format !== 'shunt-excel-archive' || manifest.version !== 1 || typeof manifest.archiveId !== 'string' || !manifest.archiveId || typeof manifest.sourceId !== 'string' || typeof manifest.sourceLabel !== 'string') throw new Error('Unsupported archive manifest')
  for (const field of ['part', 'parts', 'sampleRows', 'totalSampleRows']) {
    if (typeof manifest[field] !== 'number' || !Number.isSafeInteger(manifest[field]) || manifest[field] < 0) throw new Error('Invalid manifest count')
  }
  if (typeof manifest.exportedAt !== 'number' || !Number.isFinite(manifest.exportedAt) || manifest.exportedAt < 0) throw new Error('Invalid archive export time')
  if (Number(manifest.sampleRows) > MAX_SAMPLE_ROWS) throw new Error('Workbook exceeds the sample row limit')
  const records = readRecordTables(workbook, RECORD_SHEETS)
  if (Object.hasOwn(manifest, 'recordCounts')) {
    if (typeof manifest.recordCounts !== 'string') throw new Error('Invalid archive record counts')
    const metadataRows = RECORD_SHEETS.filter((sheet) => sheet !== 'Chunks').reduce((count, sheet) => count + records[sheet]!.length, 0)
    if (metadataRows > MAX_METADATA_ROWS) throw new Error('Workbook exceeds the metadata record limit')
  }
  const chunks = records.Chunks!
  let sampleCount = 0
  for (const stream of ['pack', 'solar'] as const) {
    const sheet = stream === 'pack' ? 'Pack Samples' : 'Solar Samples'
    const columns = stream === 'pack' ? PACK_COLUMNS : SOLAR_COLUMNS
    const names = Object.keys(columns)
    const rows = readTable(workbook, sheet)
    requireHeader(rows, ['Chunk', 'Row', ...names], sheet)
    const samples = new Map<number, number[][]>()
    rows.slice(1).forEach((row) => {
      const [chunkIndex, sampleIndex] = row
      if (typeof chunkIndex !== 'number' || !Number.isSafeInteger(chunkIndex) || chunks[chunkIndex]?.stream !== stream || typeof sampleIndex !== 'number' || row.length !== names.length + 2) throw new Error(`Invalid sample identity in ${sheet}`)
      let chunkSamples = samples.get(chunkIndex)
      if (!chunkSamples) { chunkSamples = []; samples.set(chunkIndex, chunkSamples) }
      if (sampleIndex !== chunkSamples.length) throw new Error('Missing or duplicate sample rows')
      const integers = row.slice(2)
      if (integers.some((sample) => typeof sample !== 'number' || !Number.isSafeInteger(sample))) throw new Error('Samples must preserve their original integer values')
      chunkSamples.push(integers as number[])
      sampleCount += 1
      if (sampleCount > MAX_SAMPLE_ROWS) throw new Error('Workbook exceeds the sample row limit')
    })
    chunks.forEach((chunk, chunkIndex) => {
      if (chunk.stream !== stream) return
      const chunkSamples = samples.get(chunkIndex) ?? []
      if (chunkSamples.length !== chunk.length) throw new Error('Chunk sample count does not match its header')
      for (const [columnIndex, name] of names.entries()) {
        const tagged = { $typedArray: columns[name as keyof typeof columns], values: chunkSamples.map((row) => row[columnIndex]) }
        chunk[name] = decodeArchiveValue(JSON.stringify(tagged))
      }
    })
  }
  if (sampleCount !== manifest.sampleRows) throw new Error('Workbook sample count does not match its manifest')
  const orderRows = readTable(workbook, 'Record Order')
  requireHeader(orderRows, RECORD_ORDER_HEADER, 'Record Order')
  const storedRows: ArchivePart['storedRows'] = { ringRecords: [], ringReads: [] }
  const usedRecords = new Set<string>()
  for (const row of orderRows.slice(1)) {
    const [store, index, sheet, sheetIndex] = row
    if (row.length !== 4 || (store !== 'ringRecords' && store !== 'ringReads') || index !== storedRows[store].length || typeof sheet !== 'string' || !(store === 'ringRecords' ? ['Ring Records', 'Solar Days'] : ['Ring Reads', 'Solar Reads']).includes(sheet) || typeof sheetIndex !== 'number' || !Number.isSafeInteger(sheetIndex)) throw new Error('Invalid stored record order')
    const record = records[sheet]?.[sheetIndex]
    const identity = JSON.stringify([sheet, sheetIndex])
    if (!record || usedRecords.has(identity)) throw new Error('Missing or duplicate stored record order')
    usedRecords.add(identity)
    storedRows[store].push(record)
  }
  if (usedRecords.size !== ['Ring Records', 'Solar Days', 'Ring Reads', 'Solar Reads'].reduce((count, name) => count + records[name]!.length, 0)) throw new Error('Missing stored record order')
  return { manifest, records, chunks, storedRows }
}

function partFileName(part: number): string {
  return `part-${String(part).padStart(4, '0')}.xlsx`
}

function inspectZip(bytes: Uint8Array, maxEntries: number, onExpandedSize?: (size: number) => void, maxExpandedBytes = MAX_WORKBOOK_XML_BYTES): string[] {
  const names = new Set<string>()
  let expanded = 0
  unzipSync(bytes, { filter: (entry: UnzipFileInfo) => {
    if (!entry.name || entry.name.includes('\\') || entry.name.startsWith('/') || entry.name.split('/').some((piece) => piece === '..' || piece === '.') || /^[A-Za-z]:/.test(entry.name) || names.has(entry.name)) throw new Error('Unsafe or duplicate ZIP entry')
    names.add(entry.name)
    expanded += entry.originalSize
    if (names.size > maxEntries || expanded > maxExpandedBytes || entry.originalSize > Math.min(maxExpandedBytes, MAX_ARCHIVE_FILE_BYTES) || (entry.originalSize > 1024 * 1024 && entry.originalSize > Math.max(1, entry.size) * 500)) throw new Error('ZIP expansion exceeds the supported limits')
    onExpandedSize?.(entry.originalSize)
    return false
  } })
  return [...names]
}
