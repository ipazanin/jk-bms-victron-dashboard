/**
 * The wire-scale columns: how a sample becomes a row of typed arrays, and how a row becomes a
 * sample again.
 *
 * Every column is held at the integer scale its radio transmits, so the round trip is exactly
 * lossless — 3.394 V in, 3.394 V out, never 3.3939999. What is stored is only ever what a radio
 * said. There is no house column, because the house load is `solar − pack` and deriving it on
 * read is what lets a correction to the noise floor correct recordings already on disk.
 *
 * Absence is carried by the sentinels Victron itself broadcasts, never by NaN. Decoding turns a
 * sentinel back into `null`, which is the only absence the instruments recognise: NaN passes the
 * `value !== null` guard every one of them uses, so it would reach a path `d` attribute as the
 * literal "NaN" and collapse the scale of the strip it was drawn in.
 *
 * Appending is the only encode path there is. Row offsets have to be measured against a monotonic
 * clock rather than a wall clock — an NTP step under a running chunk would otherwise produce a
 * negative or a duplicated offset — and a free function taking a list of samples would have no
 * monotonic reading to measure against, only the wall stamps the samples carry.
 */

import { CHARGE_STATES, NOT_AVAILABLE_I16, NOT_AVAILABLE_U16, NOT_AVAILABLE_U9 } from '../solar/types'
import type { ChargeState } from '../solar/types'
import { CHUNK_CAPACITY, CHUNK_LAYOUT_VERSION, MAX_CHUNK_SPAN_MS, PACK_STREAM, SOLAR_STREAM } from './types'
import type {
  ChunkHeader,
  PackChunk,
  PackSample,
  SessionId,
  SolarChunk,
  SolarSample,
  StreamName,
} from './types'

const MILLIS_PER_UNIT = 1_000
const CENTIS_PER_UNIT = 100
const DECIS_PER_UNIT = 10

const INT32_LOWEST = -0x8000_0000
const INT32_HIGHEST = 0x7fff_ffff
const UINT32_HIGHEST = 0xffff_ffff
const INT16_LOWEST = -0x8000
const INT16_HIGHEST = 0x7fff
const UINT16_HIGHEST = 0xffff
const UINT8_HIGHEST = 0xff
const INT8_LOWEST = -0x80
const INT8_HIGHEST = 0x7f

const CHARGING_ENABLED_BIT = 0b01
const DISCHARGING_ENABLED_BIT = 0b10

/** 4+4+4+4 + 2+2+2+2 + 1+1+1+1. */
export const PACK_SAMPLE_BYTES = 28
/** 4 + 2+2+2+2+2 + 1+1+1. */
export const SOLAR_SAMPLE_BYTES = 17

/**
 * The byte cost of one row.
 *
 * The archive's budget is expressed in rows rather than bytes precisely because this is a
 * constant: a columnar layout makes size a deterministic function of row count, which is what
 * makes a cap exactly enforceable offline, with no reliance on a padded and lagging quota
 * estimate.
 */
export function sampleBytes(stream: StreamName): number {
  return stream === PACK_STREAM ? PACK_SAMPLE_BYTES : SOLAR_SAMPLE_BYTES
}

// ── absence, at the scales the controller broadcasts ──────────────────────────

interface OptionalColumn {
  /** stored = round(value × perUnit). */
  readonly perUnit: number
  readonly lowest: number
  /** One below the sentinel, so a real reading can never be mistaken for an absent one. */
  readonly highest: number
  readonly absent: number
}

const BATTERY_VOLTAGE: OptionalColumn = {
  perUnit: CENTIS_PER_UNIT,
  lowest: INT16_LOWEST,
  highest: NOT_AVAILABLE_I16 - 1,
  absent: NOT_AVAILABLE_I16,
}

const BATTERY_CURRENT: OptionalColumn = {
  perUnit: DECIS_PER_UNIT,
  lowest: INT16_LOWEST,
  highest: NOT_AVAILABLE_I16 - 1,
  absent: NOT_AVAILABLE_I16,
}

const YIELD_TODAY: OptionalColumn = {
  perUnit: CENTIS_PER_UNIT,
  lowest: 0,
  highest: NOT_AVAILABLE_U16 - 1,
  absent: NOT_AVAILABLE_U16,
}

const PV_POWER: OptionalColumn = {
  perUnit: 1,
  lowest: 0,
  highest: NOT_AVAILABLE_U16 - 1,
  absent: NOT_AVAILABLE_U16,
}

const LOAD_CURRENT: OptionalColumn = {
  perUnit: DECIS_PER_UNIT,
  lowest: 0,
  highest: NOT_AVAILABLE_U9 - 1,
  absent: NOT_AVAILABLE_U9,
}

/**
 * Victron names no state above 245, so 0xff is free to carry `unknown` — the one ChargeState the
 * vendor has no code for. A code this build does not recognise decodes to `unknown` as well, so a
 * state introduced by later firmware sits on disk unharmed until a later build learns to name it.
 */
export const CHARGE_STATE_UNNAMED = 0xff

const CODE_BY_CHARGE_STATE: ReadonlyMap<ChargeState, number> = new Map(
  Object.entries(CHARGE_STATES).map(
    ([code, state]): readonly [ChargeState, number] => [state, Number(code)],
  ),
)

export function chargeStateCodeOf(state: ChargeState): number {
  return CODE_BY_CHARGE_STATE.get(state) ?? CHARGE_STATE_UNNAMED
}

export function chargeStateOf(code: number): ChargeState {
  return CHARGE_STATES[code] ?? 'unknown'
}

// ── the scale table, so the export document describes itself ──────────────────

export interface ColumnScale {
  /** The engineering unit the decoded value carries. */
  readonly unit: string
  /** stored = round(value × perUnit). */
  readonly perUnit: number
  /** The stored integer meaning the radio did not report it; null when the column always has one. */
  readonly absent: number | null
}

type PackColumn = Exclude<keyof PackChunk, keyof ChunkHeader>
type SolarColumn = Exclude<keyof SolarChunk, keyof ChunkHeader>

/**
 * Exhaustive by construction: a column added to the chunk without a scale here is a compile
 * error, which is the only thing that keeps an export document honest about what it contains.
 */
export const PACK_COLUMN_SCALES: Readonly<Record<PackColumn, ColumnScale>> = {
  offsetMs: { unit: 'ms after baseAt', perUnit: 1, absent: null },
  currentMa: { unit: 'A', perUnit: MILLIS_PER_UNIT, absent: null },
  packVoltageMv: { unit: 'V', perUnit: MILLIS_PER_UNIT, absent: null },
  remainingCapacityMah: { unit: 'Ah', perUnit: MILLIS_PER_UNIT, absent: null },
  cellDeltaMv: { unit: 'V', perUnit: MILLIS_PER_UNIT, absent: null },
  mosfetDeciC: { unit: '°C', perUnit: DECIS_PER_UNIT, absent: null },
  temperature1DeciC: { unit: '°C', perUnit: DECIS_PER_UNIT, absent: null },
  temperature2DeciC: { unit: '°C', perUnit: DECIS_PER_UNIT, absent: null },
  stateOfCharge: { unit: '%', perUnit: 1, absent: null },
  highestCell: { unit: '1-based cell index, 0 when no cell was populated', perUnit: 1, absent: null },
  lowestCell: { unit: '1-based cell index, 0 when no cell was populated', perUnit: 1, absent: null },
  switches: { unit: 'bit 0 charging enabled, bit 1 discharging enabled', perUnit: 1, absent: null },
}

export const SOLAR_COLUMN_SCALES: Readonly<Record<SolarColumn, ColumnScale>> = {
  offsetMs: { unit: 'ms after baseAt', perUnit: 1, absent: null },
  batteryVoltageCv: { unit: 'V', perUnit: BATTERY_VOLTAGE.perUnit, absent: BATTERY_VOLTAGE.absent },
  batteryCurrentDa: { unit: 'A', perUnit: BATTERY_CURRENT.perUnit, absent: BATTERY_CURRENT.absent },
  yieldTodayHwh: { unit: 'kWh', perUnit: YIELD_TODAY.perUnit, absent: YIELD_TODAY.absent },
  pvPowerW: { unit: 'W', perUnit: PV_POWER.perUnit, absent: PV_POWER.absent },
  loadCurrentDa: { unit: 'A', perUnit: LOAD_CURRENT.perUnit, absent: LOAD_CURRENT.absent },
  chargeStateCode: { unit: 'Victron state code', perUnit: 1, absent: CHARGE_STATE_UNNAMED },
  chargerError: { unit: 'Victron error code', perUnit: 1, absent: null },
  rssiDbm: { unit: 'dBm', perUnit: 1, absent: null },
}

// ── staging ──────────────────────────────────────────────────────────────────

export interface ChunkOrigin {
  readonly sessionId: SessionId
  readonly seq: number
  /** Wall clock at row 0. Every row's wall time is baseAt + offsetMs[index]. */
  readonly baseAt: number
  /** performance.now() at the same instant. Offsets are measured against this and nothing else. */
  readonly baseMonotonic: number
}

type CommonColumns = Omit<ChunkHeader, 'stream'> & { readonly offsetMs: Uint32Array }

abstract class ChunkStaging {
  private readonly origin: ChunkOrigin
  private readonly offsets: Uint32Array
  private rows: number
  private drift: number

  protected constructor(origin: ChunkOrigin) {
    this.origin = origin
    this.offsets = new Uint32Array(CHUNK_CAPACITY)
    this.rows = 0
    this.drift = 0
  }

  get length(): number {
    return this.rows
  }

  get isEmpty(): boolean {
    return this.rows === 0
  }

  /**
   * Whether a row stamped at this monotonic time belongs in this chunk.
   *
   * A time before the base or past the span bound has to force a seal rather than a write: a
   * Uint32 offset cannot carry a negative, and a wrapped one would read back as a row weeks away
   * from the chunk holding it.
   */
  accepts(monotonic: number): boolean {
    if (this.rows >= CHUNK_CAPACITY) return false
    const elapsed = monotonic - this.origin.baseMonotonic
    return elapsed >= 0 && elapsed <= MAX_CHUNK_SPAN_MS
  }

  protected claimRow(at: number, monotonic: number): number {
    const index = this.rows
    const offset = Math.round(monotonic - this.origin.baseMonotonic)
    this.offsets[index] = offset
    // What the wall clock did that the monotonic clock did not. Non-zero means it was stepped.
    this.drift = Math.round(at - this.origin.baseAt) - offset
    this.rows = index + 1
    return index
  }

  /**
   * The header and the offset column, copied to exactly `length` rows.
   *
   * `.slice` and never `.subarray`: structuredClone copies the entire ArrayBuffer a typed array
   * views, so a short view onto a full-capacity staging buffer would be written to disk at full
   * capacity on every checkpoint, silently, with nothing to show for it but the budget.
   */
  protected commonColumns(sealed: boolean): CommonColumns {
    return {
      sessionId: this.origin.sessionId,
      seq: this.origin.seq,
      layout: CHUNK_LAYOUT_VERSION,
      baseAt: this.origin.baseAt,
      baseMonotonic: this.origin.baseMonotonic,
      wallDriftMs: this.drift,
      length: this.rows,
      sealed,
      offsetMs: this.offsets.slice(0, this.rows),
    }
  }
}

export class PackChunkBuilder extends ChunkStaging {
  private readonly currentMa = new Int32Array(CHUNK_CAPACITY)
  private readonly packVoltageMv = new Uint32Array(CHUNK_CAPACITY)
  private readonly remainingCapacityMah = new Uint32Array(CHUNK_CAPACITY)
  private readonly cellDeltaMv = new Uint16Array(CHUNK_CAPACITY)
  private readonly mosfetDeciC = new Int16Array(CHUNK_CAPACITY)
  private readonly temperature1DeciC = new Int16Array(CHUNK_CAPACITY)
  private readonly temperature2DeciC = new Int16Array(CHUNK_CAPACITY)
  private readonly stateOfCharge = new Uint8Array(CHUNK_CAPACITY)
  private readonly highestCell = new Uint8Array(CHUNK_CAPACITY)
  private readonly lowestCell = new Uint8Array(CHUNK_CAPACITY)
  private readonly switches = new Uint8Array(CHUNK_CAPACITY)

  constructor(origin: ChunkOrigin) {
    super(origin)
  }

  /**
   * Appends one row, or refuses. A refusal is the caller's signal to seal this chunk and open the
   * next one at the sample it was handed; nothing is written and no row is claimed. Refusing here
   * as well as in `accepts` is what stops an overrun leaving `length` claiming rows the columns
   * do not hold.
   */
  append(sample: PackSample, monotonic: number): boolean {
    if (!this.accepts(monotonic)) return false
    const index = this.claimRow(sample.at, monotonic)

    this.currentMa[index] = toInteger(sample.currentA * MILLIS_PER_UNIT, INT32_LOWEST, INT32_HIGHEST)
    this.packVoltageMv[index] = toInteger(sample.packVoltageV * MILLIS_PER_UNIT, 0, UINT32_HIGHEST)
    this.remainingCapacityMah[index] = toInteger(sample.remainingCapacityAh * MILLIS_PER_UNIT, 0, UINT32_HIGHEST)
    this.cellDeltaMv[index] = toInteger(sample.cellDeltaV * MILLIS_PER_UNIT, 0, UINT16_HIGHEST)
    this.mosfetDeciC[index] = toInteger(sample.mosfetTemperatureC * DECIS_PER_UNIT, INT16_LOWEST, INT16_HIGHEST)
    this.temperature1DeciC[index] = toInteger(sample.temperatureSensor1C * DECIS_PER_UNIT, INT16_LOWEST, INT16_HIGHEST)
    this.temperature2DeciC[index] = toInteger(sample.temperatureSensor2C * DECIS_PER_UNIT, INT16_LOWEST, INT16_HIGHEST)
    this.stateOfCharge[index] = toInteger(sample.stateOfCharge, 0, UINT8_HIGHEST)
    this.highestCell[index] = toInteger(sample.highestCell, 0, UINT8_HIGHEST)
    this.lowestCell[index] = toInteger(sample.lowestCell, 0, UINT8_HIGHEST)
    this.switches[index] =
      (sample.chargingEnabled ? CHARGING_ENABLED_BIT : 0) |
      (sample.dischargingEnabled ? DISCHARGING_ENABLED_BIT : 0)

    return true
  }

  /** The finished chunk. Sealed chunks are immutable and are never written at their key again. */
  seal(): PackChunk {
    return this.harvest(true)
  }

  /** The same copy, still open: a tail is rewritten at its key as a prefix extension of itself. */
  tail(): PackChunk {
    return this.harvest(false)
  }

  private harvest(sealed: boolean): PackChunk {
    const rows = this.length
    return {
      ...this.commonColumns(sealed),
      stream: PACK_STREAM,
      currentMa: this.currentMa.slice(0, rows),
      packVoltageMv: this.packVoltageMv.slice(0, rows),
      remainingCapacityMah: this.remainingCapacityMah.slice(0, rows),
      cellDeltaMv: this.cellDeltaMv.slice(0, rows),
      mosfetDeciC: this.mosfetDeciC.slice(0, rows),
      temperature1DeciC: this.temperature1DeciC.slice(0, rows),
      temperature2DeciC: this.temperature2DeciC.slice(0, rows),
      stateOfCharge: this.stateOfCharge.slice(0, rows),
      highestCell: this.highestCell.slice(0, rows),
      lowestCell: this.lowestCell.slice(0, rows),
      switches: this.switches.slice(0, rows),
    }
  }
}

export class SolarChunkBuilder extends ChunkStaging {
  private readonly batteryVoltageCv = new Int16Array(CHUNK_CAPACITY)
  private readonly batteryCurrentDa = new Int16Array(CHUNK_CAPACITY)
  private readonly yieldTodayHwh = new Uint16Array(CHUNK_CAPACITY)
  private readonly pvPowerW = new Uint16Array(CHUNK_CAPACITY)
  private readonly loadCurrentDa = new Uint16Array(CHUNK_CAPACITY)
  private readonly chargeStateCode = new Uint8Array(CHUNK_CAPACITY)
  private readonly chargerError = new Uint8Array(CHUNK_CAPACITY)
  private readonly rssiDbm = new Int8Array(CHUNK_CAPACITY)

  constructor(origin: ChunkOrigin) {
    super(origin)
  }

  /** Appends one row, or refuses — see `PackChunkBuilder.append`. */
  append(sample: SolarSample, monotonic: number): boolean {
    if (!this.accepts(monotonic)) return false
    const index = this.claimRow(sample.at, monotonic)

    this.batteryVoltageCv[index] = encodeOptional(sample.batteryVoltageV, BATTERY_VOLTAGE)
    this.batteryCurrentDa[index] = encodeOptional(sample.batteryCurrentA, BATTERY_CURRENT)
    this.yieldTodayHwh[index] = encodeOptional(sample.yieldTodayKwh, YIELD_TODAY)
    this.pvPowerW[index] = encodeOptional(sample.pvPowerW, PV_POWER)
    this.loadCurrentDa[index] = encodeOptional(sample.loadCurrentA, LOAD_CURRENT)
    this.chargeStateCode[index] = chargeStateCodeOf(sample.chargeState)
    this.chargerError[index] = toInteger(sample.chargerError, 0, UINT8_HIGHEST)
    this.rssiDbm[index] = toInteger(sample.rssi, INT8_LOWEST, INT8_HIGHEST)

    return true
  }

  seal(): SolarChunk {
    return this.harvest(true)
  }

  tail(): SolarChunk {
    return this.harvest(false)
  }

  private harvest(sealed: boolean): SolarChunk {
    const rows = this.length
    return {
      ...this.commonColumns(sealed),
      stream: SOLAR_STREAM,
      batteryVoltageCv: this.batteryVoltageCv.slice(0, rows),
      batteryCurrentDa: this.batteryCurrentDa.slice(0, rows),
      yieldTodayHwh: this.yieldTodayHwh.slice(0, rows),
      pvPowerW: this.pvPowerW.slice(0, rows),
      loadCurrentDa: this.loadCurrentDa.slice(0, rows),
      chargeStateCode: this.chargeStateCode.slice(0, rows),
      chargerError: this.chargerError.slice(0, rows),
      rssiDbm: this.rssiDbm.slice(0, rows),
    }
  }
}

// ── reading back ─────────────────────────────────────────────────────────────

/**
 * Whether this build has a reader for a chunk's layout.
 *
 * A chunk written by a later build carries columns this one has never heard of. The archive lists
 * it and says so; it is never deleted, and it is never plotted from whichever columns happen to
 * line up by name.
 */
export function isReadableLayout(layout: number): boolean {
  return layout <= CHUNK_LAYOUT_VERSION
}

/** One row. `index` must be under `chunk.length`; the capacity says nothing about a tail chunk. */
export function readPackSample(chunk: PackChunk, index: number): PackSample {
  const switches = chunk.switches[index]
  return {
    at: chunk.baseAt + chunk.offsetMs[index],
    currentA: chunk.currentMa[index] / MILLIS_PER_UNIT,
    packVoltageV: chunk.packVoltageMv[index] / MILLIS_PER_UNIT,
    stateOfCharge: chunk.stateOfCharge[index],
    remainingCapacityAh: chunk.remainingCapacityMah[index] / MILLIS_PER_UNIT,
    cellDeltaV: chunk.cellDeltaMv[index] / MILLIS_PER_UNIT,
    highestCell: chunk.highestCell[index],
    lowestCell: chunk.lowestCell[index],
    mosfetTemperatureC: chunk.mosfetDeciC[index] / DECIS_PER_UNIT,
    temperatureSensor1C: chunk.temperature1DeciC[index] / DECIS_PER_UNIT,
    temperatureSensor2C: chunk.temperature2DeciC[index] / DECIS_PER_UNIT,
    chargingEnabled: (switches & CHARGING_ENABLED_BIT) !== 0,
    dischargingEnabled: (switches & DISCHARGING_ENABLED_BIT) !== 0,
  }
}

/** One row. Each sentinel becomes `null` again, which is the absence every instrument tests for. */
export function readSolarSample(chunk: SolarChunk, index: number): SolarSample {
  return {
    at: chunk.baseAt + chunk.offsetMs[index],
    chargeState: chargeStateOf(chunk.chargeStateCode[index]),
    chargerError: chunk.chargerError[index],
    batteryVoltageV: decodeOptional(chunk.batteryVoltageCv[index], BATTERY_VOLTAGE),
    batteryCurrentA: decodeOptional(chunk.batteryCurrentDa[index], BATTERY_CURRENT),
    yieldTodayKwh: decodeOptional(chunk.yieldTodayHwh[index], YIELD_TODAY),
    pvPowerW: decodeOptional(chunk.pvPowerW[index], PV_POWER),
    loadCurrentA: decodeOptional(chunk.loadCurrentDa[index], LOAD_CURRENT),
    rssi: chunk.rssiDbm[index],
  }
}

/**
 * Every row of a chunk.
 *
 * The read path draws from chunks and reads rows one at a time wherever it can — hydrating two
 * million objects to fill two thousand pixels is the cost this layout exists to avoid — so this
 * is for the table, the export and the tests, not for the ribbon.
 */
export function decodePackChunk(chunk: PackChunk): PackSample[] {
  const samples: PackSample[] = []
  for (let index = 0; index < chunk.length; index += 1) samples.push(readPackSample(chunk, index))
  return samples
}

export function decodeSolarChunk(chunk: SolarChunk): SolarSample[] {
  const samples: SolarSample[] = []
  for (let index = 0; index < chunk.length; index += 1) samples.push(readSolarSample(chunk, index))
  return samples
}

/**
 * Saturating conversion to a column's integer scale.
 *
 * Every column is fed by a wire field whose range already fits, so the bounds never bite on
 * anything a radio produced. They matter for the failure: a typed array wraps silently on
 * overflow and stores zero for NaN, and a wrapped value reads back as a plausible wrong number
 * rather than an obviously wrong one. Saturating leaves a corrupt input visibly at the rail.
 */
function toInteger(value: number, lowest: number, highest: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(highest, Math.max(lowest, Math.round(value)))
}

function encodeOptional(value: number | null, column: OptionalColumn): number {
  if (value === null || !Number.isFinite(value)) return column.absent
  return Math.min(column.highest, Math.max(column.lowest, Math.round(value * column.perUnit)))
}

function decodeOptional(stored: number, column: OptionalColumn): number | null {
  return stored === column.absent ? null : stored / column.perUnit
}
