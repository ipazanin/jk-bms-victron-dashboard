/**
 * Reading a stored row's format, and separating a ledger by it.
 *
 * The default lives here and nowhere else. Every pack row already on disk was written before a
 * discriminator existed, and an upgrade may only add — so absence means "pack record", permanently
 * and by design rather than by migration. A second copy of that rule somewhere else is a second
 * place for it to be got wrong, and getting it wrong would hand a 24-byte pack record to a decoder
 * expecting 34 bytes of Victron day.
 *
 * The partition functions exist because a store reads one key range and gets rows of one kind — a
 * device key belongs to a pack or to a controller, never to both — but nothing in the type system
 * says so. Partitioning at the read is what lets every fold above keep the exact row type it was
 * written against, with no cast and no runtime check of its own.
 */

import type { RingReadRow } from './RingReadRow'
import type { RingRecordRow } from './RingRecordRow'
import type { SolarDayRow } from './SolarDayRow'
import type { SolarHistoryReadRow } from './SolarHistoryReadRow'
import { PACK_RECORD_FORMAT, SOLAR_DAY_FORMAT } from './StoredRowFormat'
import type { StoredRowFormat } from './StoredRowFormat'
import type { StoredRingRead } from './StoredRingRead'
import type { StoredRingRecord } from './StoredRingRecord'

/** What wrote a row. A row carrying no format is a pack record, which is most of the archive. */
export function formatOfStoredRow(row: StoredRingRecord | StoredRingRead): StoredRowFormat {
  return row.format ?? PACK_RECORD_FORMAT
}

export function isPackRecordRow(row: StoredRingRecord): row is RingRecordRow {
  return formatOfStoredRow(row) === PACK_RECORD_FORMAT
}

export function isSolarDayRow(row: StoredRingRecord): row is SolarDayRow {
  return row.format === SOLAR_DAY_FORMAT
}

export function isPackReadRow(read: StoredRingRead): read is RingReadRow {
  return formatOfStoredRow(read) === PACK_RECORD_FORMAT
}

export function isSolarReadRow(read: StoredRingRead): read is SolarHistoryReadRow {
  return read.format === SOLAR_DAY_FORMAT
}

export function packRecordsIn(rows: readonly StoredRingRecord[]): readonly RingRecordRow[] {
  return rows.filter(isPackRecordRow)
}

export function solarDaysIn(rows: readonly StoredRingRecord[]): readonly SolarDayRow[] {
  return rows.filter(isSolarDayRow)
}

export function packReadsIn(reads: readonly StoredRingRead[]): readonly RingReadRow[] {
  return reads.filter(isPackReadRow)
}

export function solarReadsIn(reads: readonly StoredRingRead[]): readonly SolarHistoryReadRow[] {
  return reads.filter(isSolarReadRow)
}

/**
 * Whether a receipt claims it put rows in a ledger — the test the journal sweep is written around,
 * asked of either format.
 */
export function readClaimsStoredRows(read: StoredRingRead): boolean {
  if (isSolarReadRow(read)) return read.daysAppended > 0 || read.daysUnchanged > 0
  return read.recordsAppended > 0 || read.overlap > 0
}
