/**
 * The export document.
 *
 * On iOS this is the only durable copy of a session, so the file has to stand on its own years
 * later with no page to open it: it names its own format, lists its columns with their units and
 * the resolution each radio can actually express, and carries the session's metadata beside its
 * samples.
 *
 * Two rules from the archive carry through unchanged. The document is what the radios said, so
 * there is no `housePower` column — `house = solar − pack` is derived on read, and a stored
 * derivation would freeze today's noise floor into a file that outlives it. And the ledger travels
 * twice, as the value the recorder folded incrementally and as the value a full pass over these
 * same rows reproduces, so a reader can check the account rather than take it.
 *
 * Rows are arrays against a declared column list rather than objects. Repeating thirteen field
 * names forty thousand times quadruples the file for no information, and the column list says
 * everything the repetition would.
 */

import { deviceLabel } from './identity'
import type {
  DeviceRecord,
  PackSample,
  SessionLedger,
  SessionRecord,
  SolarSample,
} from './types'

export const EXPORT_FORMAT = 'shunt.session'
/** Bumped when a column is added, removed or renamed. A reader gates on this, never on the app's
 *  version, which moves for reasons that have nothing to do with the file. */
export const EXPORT_FORMAT_VERSION = 1

const DOCUMENT_NOTE =
  'Every sample exactly as the radios reported it. house = solar − pack is derived on read and ' +
  'is deliberately not a column.'

/** One row at ordinary magnitudes, with its separator and its newline. */
const PACK_ROW_BYTES = 77
const SOLAR_ROW_BYTES = 52
/** The head: session metadata, both ledgers, the two device records and the column lists. */
const DOCUMENT_OVERHEAD_BYTES = 4_096

const MAX_SLUG_LENGTH = 48
/** Combining marks left behind by NFKD, so an accented name slugs to its unaccented letters. */
const COMBINING_MARKS = /[\u0300-\u036f]/g

type ExportValue = number | string | boolean | null

export interface ColumnDescriptor {
  readonly name: string
  readonly unit: string
  /** The smallest step this radio can express in this column: a figure is exact to here and no
   *  finer. Null where the column is not a measurement. */
  readonly resolution: number | null
}

interface Column<TSample> extends ColumnDescriptor {
  readonly read: (sample: TSample) => ExportValue
}

const PACK_STREAM: readonly Column<PackSample>[] = [
  { name: 'at', unit: 'ms since epoch', resolution: 1, read: (sample) => sample.at },
  { name: 'currentA', unit: 'A', resolution: 0.001, read: (sample) => sample.currentA },
  { name: 'packVoltageV', unit: 'V', resolution: 0.001, read: (sample) => sample.packVoltageV },
  { name: 'stateOfCharge', unit: '%', resolution: 1, read: (sample) => sample.stateOfCharge },
  {
    name: 'remainingCapacityAh',
    unit: 'Ah',
    resolution: 0.001,
    read: (sample) => sample.remainingCapacityAh,
  },
  { name: 'cellDeltaV', unit: 'V', resolution: 0.001, read: (sample) => sample.cellDeltaV },
  { name: 'highestCell', unit: 'cell, 1-based', resolution: 1, read: (sample) => sample.highestCell },
  { name: 'lowestCell', unit: 'cell, 1-based', resolution: 1, read: (sample) => sample.lowestCell },
  {
    name: 'mosfetTemperatureC',
    unit: '°C',
    resolution: 0.1,
    read: (sample) => sample.mosfetTemperatureC,
  },
  {
    name: 'temperatureSensor1C',
    unit: '°C',
    resolution: 0.1,
    read: (sample) => sample.temperatureSensor1C,
  },
  {
    name: 'temperatureSensor2C',
    unit: '°C',
    resolution: 0.1,
    read: (sample) => sample.temperatureSensor2C,
  },
  {
    name: 'chargingEnabled',
    unit: 'true or false',
    resolution: null,
    read: (sample) => sample.chargingEnabled,
  },
  {
    name: 'dischargingEnabled',
    unit: 'true or false',
    resolution: null,
    read: (sample) => sample.dischargingEnabled,
  },
]

const SOLAR_STREAM: readonly Column<SolarSample>[] = [
  { name: 'at', unit: 'ms since epoch', resolution: 1, read: (sample) => sample.at },
  { name: 'chargeState', unit: 'state name', resolution: null, read: (sample) => sample.chargeState },
  { name: 'chargerError', unit: 'Victron error code', resolution: 1, read: (sample) => sample.chargerError },
  { name: 'batteryVoltageV', unit: 'V', resolution: 0.01, read: (sample) => sample.batteryVoltageV },
  { name: 'batteryCurrentA', unit: 'A', resolution: 0.1, read: (sample) => sample.batteryCurrentA },
  { name: 'yieldTodayKwh', unit: 'kWh', resolution: 0.01, read: (sample) => sample.yieldTodayKwh },
  { name: 'pvPowerW', unit: 'W', resolution: 1, read: (sample) => sample.pvPowerW },
  { name: 'loadCurrentA', unit: 'A', resolution: 0.1, read: (sample) => sample.loadCurrentA },
  { name: 'rssiDbm', unit: 'dBm', resolution: 1, read: (sample) => sample.rssi },
]

export const PACK_COLUMNS: readonly ColumnDescriptor[] = PACK_STREAM.map(describeColumn)
export const SOLAR_COLUMNS: readonly ColumnDescriptor[] = SOLAR_STREAM.map(describeColumn)

export interface SessionExport {
  readonly record: SessionRecord
  readonly packDevice: DeviceRecord | null
  readonly solarDevice: DeviceRecord | null
  /** A full pass over the exported rows. Null when the rows are a window rather than the whole
   *  session, because a ledger recomputed over part of one is not a check on the other. */
  readonly recomputedLedger: SessionLedger | null
  readonly pack: Iterable<PackSample>
  readonly solar: Iterable<SolarSample>
  readonly generatedAt: number
}

/**
 * The document, emitted in parts.
 *
 * A whole session is millions of characters, and `JSON.stringify` over a hydrated array of
 * samples would hold the objects and the string at once. Yielding a row at a time keeps peak
 * memory at one row, and the caller joins the parts into whatever it is writing to.
 *
 * One row per line, which costs a byte and makes a three-megabyte file readable by anything that
 * reads lines.
 */
export function* exportSessionParts(session: SessionExport): Generator<string> {
  const { ledger: storedLedger, ...meta } = session.record
  const devices = {
    pack: describeDevice(session.packDevice),
    solar: describeDevice(session.solarDevice),
  }

  yield '{\n'
  yield `"format": ${JSON.stringify(EXPORT_FORMAT)},\n`
  yield `"formatVersion": ${EXPORT_FORMAT_VERSION},\n`
  yield `"generatedAt": ${JSON.stringify(session.generatedAt)},\n`
  yield `"snapshotSchemaVersion": ${JSON.stringify(session.record.schema)},\n`
  yield `"note": ${JSON.stringify(DOCUMENT_NOTE)},\n`
  yield `"session": ${JSON.stringify(meta)},\n`
  yield `"devices": ${JSON.stringify(devices)},\n`
  yield `"ledger": ${JSON.stringify({ stored: storedLedger, recomputed: session.recomputedLedger })},\n`
  yield '"streams": {\n'
  yield* streamParts('pack', PACK_STREAM, session.pack)
  yield ',\n'
  yield* streamParts('solar', SOLAR_STREAM, session.solar)
  yield '\n}\n}\n'
}

/**
 * Roughly how large the file will be, for the sentence printed on the button before anything is
 * built. Derived from the column widths at ordinary magnitudes; it is an answer to "about how big
 * is this", never a budget, and nothing enforces it.
 */
export function estimateExportBytes(packRows: number, solarRows: number): number {
  return DOCUMENT_OVERHEAD_BYTES + packRows * PACK_ROW_BYTES + solarRows * SOLAR_ROW_BYTES
}

/** `shunt-starboard-bank-2025-07-12-0620.json`. The label and the local start time, because a
 *  downloads folder sorts by name and the two together are what tells one watch from another. */
export function exportFileName(label: string, startedAt: number): string {
  const slug = slugify(label)
  return `shunt-${slug ? `${slug}-` : ''}${localStamp(startedAt)}.json`
}

function* streamParts<TSample>(
  name: string,
  columns: readonly Column<TSample>[],
  samples: Iterable<TSample>,
): Generator<string> {
  yield `${JSON.stringify(name)}: {\n`
  yield `"columns": ${JSON.stringify(columns.map(describeColumn))},\n`
  yield '"rows": [\n'

  let written = false
  for (const sample of samples) {
    const row = JSON.stringify(columns.map((column) => column.read(sample)))
    yield written ? `,\n${row}` : row
    written = true
  }

  yield '\n]\n}'
}

function describeColumn(column: ColumnDescriptor): ColumnDescriptor {
  return { name: column.name, unit: column.unit, resolution: column.resolution }
}

function describeDevice(device: DeviceRecord | null): object | null {
  if (!device) return null
  // The resolved name and the derived one both travel: a file that carried only "Starboard bank"
  // would lose which pack that was, and one that carried only the model would lose the name.
  return { label: deviceLabel(device), ...device }
}

function slugify(label: string): string {
  return label
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '')
}

function localStamp(at: number): string {
  const when = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
  return `${date}-${pad(when.getHours())}${pad(when.getMinutes())}`
}
