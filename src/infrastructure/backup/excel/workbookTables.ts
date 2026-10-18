import { utils, type WorkBook } from 'xlsx'
import { decodeArchiveValue, encodeArchiveValue } from '../../../domain/backup/archiveCodec'

import type { TableCell as Cell } from './TableCell'
import type { TableRecord } from './TableRecord'
import type { TableRow } from './TableRow'

const CELL_TEXT_LIMIT = 30_000
const MAX_SHEET_ROWS = 1_000_000
const MAX_SHEET_COLUMNS = 100
const MAX_SHEET_CELLS = 2_000_000
const MAX_METADATA_TEXT = 16_000_000
const METADATA_HEADER = ['Sheet', 'Record', 'Field', 'Kind', 'Segment', 'Value']
const METADATA_MARKER = '[see Field Metadata]'

export function appendTable(workbook: WorkBook, name: string, rows: readonly TableRow[]): void {
  if (rows.length > MAX_SHEET_ROWS || (rows[0]?.length ?? 0) > MAX_SHEET_COLUMNS || rows.length * (rows[0]?.length ?? 0) > MAX_SHEET_CELLS) throw new Error(`${name} exceeds the worksheet size limit`)
  if (rows.some((row) => row.some((cell) => typeof cell === 'string' && cell.length > CELL_TEXT_LIMIT))) throw new Error(`Cell text is too long in ${name}`)
  const sheet = utils.aoa_to_sheet(rows.map((row) => [...row]), { dense: true })
  sheet['!cols'] = rows[0]?.map((heading) => ({ wch: Math.min(35, Math.max(14, String(heading).length + 2)) })) ?? []
  if (rows.length > 1) sheet['!autofilter'] = { ref: sheet['!ref']! }
  utils.book_append_sheet(workbook, sheet, name)
}

export function readTable(workbook: WorkBook, name: string): Cell[][] {
  const sheet = workbook.Sheets[name]
  if (!sheet || !sheet['!ref']) throw new Error(`Missing worksheet: ${name}`)
  const range = utils.decode_range(sheet['!ref'])
  if (range.s.r !== 0 || range.s.c !== 0 || range.e.r >= MAX_SHEET_ROWS || range.e.c >= MAX_SHEET_COLUMNS || (range.e.r + 1) * (range.e.c + 1) > MAX_SHEET_CELLS) {
    throw new Error(`Worksheet dimensions exceed the archive limits: ${name}`)
  }
  const cellRows = sheet['!data'] ?? [Object.entries(sheet).filter(([address]) => !address.startsWith('!')).map(([, cell]) => cell)]
  for (const cells of cellRows) {
    for (const cell of cells ?? []) {
      if (!cell) continue
      if (cell.f !== undefined || cell.F !== undefined) throw new Error(`Formulas are not allowed in ${name}`)
      if (!['s', 'n', 'b', 'z'].includes(cell.t)) throw new Error(`Unsupported cell type in ${name}`)
      if (typeof cell.v === 'string' && cell.v.length > CELL_TEXT_LIMIT) throw new Error(`Cell text is too long in ${name}`)
    }
  }
  return utils.sheet_to_json<Cell[]>(sheet, { header: 1, raw: true, defval: null, blankrows: true })
}

export function requireHeader(rows: readonly TableRow[], expected: readonly string[], name: string): void {
  if (JSON.stringify(rows[0]) !== JSON.stringify(expected)) throw new Error(`Invalid columns in ${name}`)
}

export function writeRecordTables(workbook: WorkBook, tables: Readonly<Record<string, readonly object[]>>): void {
  const metadata: Cell[][] = [METADATA_HEADER]
  for (const [name, records] of Object.entries(tables)) {
    const fields = [...new Set(records.flatMap((record) => Object.keys(record)))]
    const rows: Cell[][] = [['Record', ...fields]]
    records.forEach((record, recordIndex) => {
      const entries = record as TableRecord
      rows.push([recordIndex, ...fields.map((field): Cell => {
        if (!Object.hasOwn(entries, field)) return null
        const fieldValue = entries[field]
        if (typeof fieldValue === 'number' || typeof fieldValue === 'boolean') return fieldValue
        if (typeof fieldValue === 'string' && fieldValue.length <= CELL_TEXT_LIMIT && fieldValue !== METADATA_MARKER) return fieldValue
        const kind = fieldValue === undefined ? 'undefined' : fieldValue === null ? 'null' : 'json'
        const text = kind === 'json' ? encodeArchiveValue(fieldValue) : ''
        if (text.length > MAX_METADATA_TEXT) throw new Error(`Metadata field is too large: ${name}.${field}`)
        let offset = 0
        let segment = 0
        do {
          let end = Math.min(offset + CELL_TEXT_LIMIT, text.length)
          const lastCodeUnit = text.charCodeAt(end - 1)
          if (end < text.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1
          metadata.push([name, recordIndex, field, kind, segment, text.slice(offset, end)])
          offset = end
          segment += 1
        } while (offset < text.length)
        return kind === 'json' ? METADATA_MARKER : null
      })])
    })
    appendTable(workbook, name, rows)
  }
  appendTable(workbook, 'Field Metadata', metadata)
}

export function readRecordTables(workbook: WorkBook, names: readonly string[]): Record<string, TableRecord[]> {
  const tables: Record<string, TableRecord[]> = Object.create(null)
  const tableFields = new Map<string, readonly Cell[]>()
  const pendingMetadata = new Set<string>()
  for (const name of names) {
    const rows = readTable(workbook, name)
    const fields = rows[0]!
    tableFields.set(name, fields)
    if (fields[0] !== 'Record' || new Set(fields).size !== fields.length || fields.some((field) => typeof field !== 'string' || !field || ['__proto__', 'constructor', 'prototype'].includes(field))) {
      throw new Error(`Invalid columns in ${name}`)
    }
    tables[name] = rows.slice(1).map((row, index) => {
      if (row[0] !== index || row.length !== fields.length) throw new Error(`Invalid record order in ${name}`)
      const record: TableRecord = Object.create(null)
      fields.slice(1).forEach((field, fieldIndex) => {
        const cell = row[fieldIndex + 1]
        if (cell !== null && cell !== undefined) record[field as string] = cell
        if (cell === METADATA_MARKER) pendingMetadata.add(JSON.stringify([name, index, field]))
      })
      return record
    })
  }
  const metadata = readTable(workbook, 'Field Metadata')
  requireHeader(metadata, METADATA_HEADER, 'Field Metadata')
  let previousKey = ''
  let nextSegment = 0
  let text = ''
  let current: { record: TableRecord, field: string, kind: string } | undefined
  const completed = new Set<string>()
  function finish(): void {
    if (!current) return
    if (current.kind === 'json') current.record[current.field] = decodeArchiveValue(text)
    else if (current.kind === 'null') current.record[current.field] = null
    else current.record[current.field] = undefined
    completed.add(previousKey)
    pendingMetadata.delete(previousKey)
  }
  for (const row of metadata.slice(1)) {
    const [sheet, recordIndex, field, kind, segment, fragment] = row
    if (row.length !== 6 || typeof sheet !== 'string' || typeof recordIndex !== 'number' || !Number.isSafeInteger(recordIndex) || typeof field !== 'string' || typeof kind !== 'string' || !['json', 'null', 'undefined'].includes(kind) || typeof segment !== 'number' || typeof fragment !== 'string') {
      throw new Error('Invalid field metadata')
    }
    const record = tables[sheet]?.[recordIndex]
    const headers = tableFields.get(sheet)
    if (!record || !headers?.includes(field) || field === 'Record') throw new Error('Metadata refers to an unknown field')
    const key = JSON.stringify([sheet, recordIndex, field])
    if (key !== previousKey) {
      finish()
      if (completed.has(key) || segment !== 0) throw new Error('Duplicate or missing metadata segment')
      if (kind === 'json' ? record[field] !== METADATA_MARKER : Object.hasOwn(record, field)) throw new Error('Metadata does not match its table cell')
      current = { record, field, kind }
      previousKey = key
      nextSegment = 0
      text = ''
    }
    if (kind !== current?.kind || segment !== nextSegment++) throw new Error('Invalid metadata segment order')
    if (kind !== 'json' && (segment !== 0 || fragment !== '')) throw new Error('Invalid empty field metadata')
    text += fragment
    if (text.length > MAX_METADATA_TEXT) throw new Error('Metadata field exceeds the archive limit')
  }
  finish()
  if (pendingMetadata.size > 0) throw new Error('Missing field metadata')
  return tables
}
