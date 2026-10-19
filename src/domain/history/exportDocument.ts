import { deviceLabel } from './identity'
import type { SessionHour } from './SessionHour'
import type {
  DeviceRecord,
  PackSample,
  SessionLedger,
  SessionRecord,
  SolarSample,
} from './types'

export const EXPORT_FORMAT = 'shunt.session'

export const EXPORT_FORMAT_VERSION = 2

const DOCUMENT_NOTE =
  'Hourly summaries and selected original observations accompany raw samples still retained. ' +
  'Selected observations are not a continuous recording. house = solar − pack is derived from paired readings. ' +
  'The stored session ledger remains authoritative when raw history is incomplete.'

const MAX_SLUG_LENGTH = 48

const COMBINING_MARKS = /[\u0300-\u036f]/g

type ExportValue = number | string | boolean | null

export interface ColumnDescriptor {
  readonly name: string
  readonly unit: string
  /** Smallest reported measurement step, or null for non-measurement columns. */
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
  /** Null unless retained raw rows cover the complete session. */
  readonly recomputedLedger: SessionLedger | null
  readonly pack: Iterable<PackSample>
  readonly solar: Iterable<SolarSample>
  readonly hours?: readonly SessionHour[]
  readonly rawCoverage?: 'complete' | 'partial' | 'none'
  readonly generatedAt: number
}

/** Emit individual rows so serialization does not build another whole-session string. */
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
  yield `"rawCoverage": ${JSON.stringify(session.rawCoverage ?? 'unknown')},\n`
  yield '"hours": [\n'
  for (const [index, hour] of (session.hours ?? []).entries()) {
    yield `${index === 0 ? '' : ',\n'}${JSON.stringify(hour)}`
  }
  yield '\n],\n'
  yield '"streams": {\n'
  yield* streamParts('pack', PACK_STREAM, session.pack)
  yield ',\n'
  yield* streamParts('solar', SOLAR_STREAM, session.solar)
  yield '\n}\n}\n'
}

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
