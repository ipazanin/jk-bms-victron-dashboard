/**
 * The shapes every spec starts from.
 *
 * These were private helpers inside one spec until three more needed them. They are here so that
 * a field added to `BatterySnapshot` or to `SessionRecord` breaks one file rather than eight, and
 * so that two specs asserting on "the same session" genuinely mean the same numbers.
 *
 * Two conventions run through all of it. Every builder takes an overrides object and merges it
 * last, so a case states only the field it is about and the rest reads as context. And every
 * default is a value the radios could actually have produced: the pack figures are the captured
 * frame the decoder tests use, and every optional solar figure sits exactly on its wire scale, so
 * a fixture survives the encode-decode round trip unchanged and a failure is never the fixture's
 * own rounding.
 *
 * Nothing here reads a clock. Times are laid out from a fixed epoch at the recorder's own sample
 * interval, because a spec that disagrees with the wall clock is a spec that fails at midnight.
 */

import type { SessionClosure, SessionPatch } from '../../src/application/history/port'
import { REMEMBERED_SCHEMA_VERSION } from '../../src/application/rememberedSession'
import type { RememberedSession } from '../../src/application/rememberedSession'
import { RTC_EPOCH_UTC_MS } from '../../src/domain/bms/detailLog'
import type { BatterySnapshot, DeviceInfo } from '../../src/domain/bms/types'
import { PackChunkBuilder, SolarChunkBuilder } from '../../src/domain/history/columns'
import { packDefaultLabel, packDeviceKeyFor, UNIDENTIFIED_PACK_KEY } from '../../src/domain/history/identity'
import { EMPTY_LEDGER } from '../../src/domain/history/ledger'
import { PACK_SAMPLING_PERIOD_SECONDS } from '../../src/domain/history/ringClock'
import type { RingReadRow } from '../../src/domain/history/RingReadRow'
import type { RingRecordRow } from '../../src/domain/history/RingRecordRow'
import type { RingSnapshot } from '../../src/domain/history/RingSnapshot'
import { CHUNK_LAYOUT_VERSION, SAMPLE_INTERVAL_MS } from '../../src/domain/history/types'
import type {
  DeviceKey,
  DeviceRecord,
  HistoryChunk,
  PackChunk,
  PackSample,
  SessionId,
  SessionRecord,
  SolarChunk,
  SolarSample,
  WarningRecord,
  WarningSnapshot,
} from '../../src/domain/history/types'
import { SNAPSHOT_SCHEMA_VERSION } from '../../src/domain/schemaVersion'
import type { SolarReading } from '../../src/domain/solar/types'

/** Sat 12 Jul 2025, 06:20 UTC — the watch the wireframes are drawn against. */
export const SAMPLE_EPOCH = Date.UTC(2025, 6, 12, 6, 20, 0)

/**
 * The serial in `tests/fixtures.json` is a redacted real one inside a captured device-info frame,
 * not scaffolding left over from anything. `tests/bms.spec.ts` pins it, and the derived label and
 * device key below therefore read the way the archive really labels this pack.
 */
const CAPTURED_SERIAL = 'DEMO00000000001'

export const PACK_DEVICE_KEY: DeviceKey = packDeviceKeyFor(deviceInfo(), null) ?? UNIDENTIFIED_PACK_KEY
const PACK_DEVICE_LABEL = packDefaultLabel(deviceInfo(), null)
/** A digest of some controller's advertisement key. Opaque by construction; never parsed back. */
export const SOLAR_DEVICE_KEY: DeviceKey = 'victron:3f9a17c40b2e'

export const SESSION_ID: SessionId = 'session-0001'

// ── what the radios said ─────────────────────────────────────────────────────

export function battery(overrides: Partial<BatterySnapshot> = {}): BatterySnapshot {
  return {
    cellVoltages: [3.394, 3.394, 3.393, 3.394],
    cellResistances: [0.052, 0.053, 0.053, 0.053],
    averageCellVoltage: 3.393,
    cellDelta: 0.001,
    highestCell: 1,
    lowestCell: 3,
    packVoltage: 13.573,
    current: -8.4,
    power: 114.0,
    stateOfCharge: 98,
    remainingCapacity: 309.1,
    nominalCapacity: 315,
    cycleCount: 4,
    cycledCapacity: 1268.6,
    mosfetTemperature: 30.1,
    temperatureSensor1: 27.5,
    temperatureSensor2: 27.1,
    uptimeSeconds: 4_481_077,
    chargingEnabled: true,
    dischargingEnabled: true,
    ...overrides,
  }
}

export function deviceInfo(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    model: 'JK_B2A8S20P',
    hardwareVersion: '19H',
    softwareVersion: '19.10',
    serialNumber: CAPTURED_SERIAL,
    uptimeSeconds: 4_481_077,
    powerOnCount: 37,
    ...overrides,
  }
}

export function solarReading(overrides: Partial<SolarReading> = {}): SolarReading {
  return {
    chargeState: 'bulk',
    chargerError: 0,
    batteryVoltage: 13.57,
    batteryCurrent: 12.3,
    yieldTodayKwh: 0.42,
    pvPower: 168,
    loadCurrent: 0,
    ...overrides,
  }
}

// ── stored samples ───────────────────────────────────────────────────────────

export function packSample(overrides: Partial<PackSample> = {}): PackSample {
  return {
    at: SAMPLE_EPOCH,
    currentA: -8.4,
    packVoltageV: 13.573,
    stateOfCharge: 98,
    remainingCapacityAh: 309.1,
    cellDeltaV: 0.001,
    highestCell: 1,
    lowestCell: 3,
    mosfetTemperatureC: 30.1,
    temperatureSensor1C: 27.5,
    temperatureSensor2C: 27.1,
    chargingEnabled: true,
    dischargingEnabled: true,
    ...overrides,
  }
}

export function solarSample(overrides: Partial<SolarSample> = {}): SolarSample {
  return {
    at: SAMPLE_EPOCH,
    chargeState: 'bulk',
    chargerError: 0,
    batteryVoltageV: 13.57,
    batteryCurrentA: 12.3,
    yieldTodayKwh: 0.42,
    pvPowerW: 168,
    loadCurrentA: 0,
    rssi: -67,
    ...overrides,
  }
}

/**
 * A run of rows one sample interval apart, starting at `overrides.at`. Every other override
 * applies to every row, so a case that needs a varying signal maps over the result — a builder
 * that took a generator per column would be longer than the map it replaced.
 */
export function packSamples(count: number, overrides: Partial<PackSample> = {}): PackSample[] {
  return timeline(count, overrides.at).map((at) => packSample({ ...overrides, at }))
}

export function solarSamples(count: number, overrides: Partial<SolarSample> = {}): SolarSample[] {
  return timeline(count, overrides.at).map((at) => solarSample({ ...overrides, at }))
}

// ── stored chunks ────────────────────────────────────────────────────────────

export interface ChunkOptions {
  readonly sessionId?: SessionId
  readonly seq?: number
  /** False builds the open tail: a chunk still being written and rewritten at its own key. */
  readonly sealed?: boolean
  readonly baseMonotonic?: number
}

/**
 * A chunk holding these rows, built the only way a chunk can be: appended one at a time.
 *
 * Each row is handed the monotonic reading its wall stamp implies, so a fixture's offsets are
 * exactly the gaps between its samples — which is what lets a spec assert on decoded times
 * without knowing the encoding.
 */
export function packChunk(samples: readonly PackSample[], options: ChunkOptions = {}): PackChunk {
  const baseMonotonic = options.baseMonotonic ?? 0
  const builder = new PackChunkBuilder({
    sessionId: options.sessionId ?? SESSION_ID,
    seq: options.seq ?? 0,
    baseAt: samples[0]?.at ?? SAMPLE_EPOCH,
    baseMonotonic,
  })
  appendAll(samples, baseMonotonic, (sample, monotonic) => builder.append(sample, monotonic))
  return options.sealed === false ? builder.tail() : builder.seal()
}

export function solarChunk(samples: readonly SolarSample[], options: ChunkOptions = {}): SolarChunk {
  const baseMonotonic = options.baseMonotonic ?? 0
  const builder = new SolarChunkBuilder({
    sessionId: options.sessionId ?? SESSION_ID,
    seq: options.seq ?? 0,
    baseAt: samples[0]?.at ?? SAMPLE_EPOCH,
    baseMonotonic,
  })
  appendAll(samples, baseMonotonic, (sample, monotonic) => builder.append(sample, monotonic))
  return options.sealed === false ? builder.tail() : builder.seal()
}

/**
 * The same chunk, stamped with a layout this build has no reader for.
 *
 * A builder can only stamp its own layout, so this is the one way to produce what a newer build
 * left on disk. The gate refuses either direction, and the direction is arbitrary here: what every
 * case below it turns on is that the chunk is intact and unreadable at once.
 */
export function inForeignLayout<TChunk extends HistoryChunk>(chunk: TChunk): TChunk {
  return { ...chunk, layout: CHUNK_LAYOUT_VERSION + 1 }
}

// ── archive rows ─────────────────────────────────────────────────────────────

export function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    schema: SNAPSHOT_SCHEMA_VERSION,
    writerId: 'writer-0001',
    state: 'open',
    startedAt: SAMPLE_EPOCH,
    endedAt: null,
    endReason: null,
    heartbeatAt: SAMPLE_EPOCH,
    packDeviceKey: PACK_DEVICE_KEY,
    solarDeviceKey: null,
    groupKey: PACK_DEVICE_KEY,
    packSamples: 0,
    solarSamples: 0,
    sealedSamples: 0,
    packChunks: 0,
    solarChunks: 0,
    retainedFrom: null,
    droppedChunks: 0,
    continues: null,
    coverage: [],
    ledger: EMPTY_LEDGER,
    entries: [],
    finalBattery: null,
    finalSolar: null,
    deviceInfo: null,
    settings: null,
    ...overrides,
  }
}

export function sessionPatch(overrides: Partial<SessionPatch> = {}): SessionPatch {
  return {
    heartbeatAt: SAMPLE_EPOCH,
    packSamples: 0,
    solarSamples: 0,
    packChunks: 0,
    solarChunks: 0,
    droppedChunks: 0,
    coverage: [],
    ledger: EMPTY_LEDGER,
    entries: [],
    packDeviceKey: PACK_DEVICE_KEY,
    solarDeviceKey: null,
    groupKey: PACK_DEVICE_KEY,
    deviceInfo: null,
    settings: null,
    finalBattery: null,
    finalSolar: null,
    ...overrides,
  }
}

export function sessionClosure(overrides: Partial<SessionClosure> = {}): SessionClosure {
  return {
    ...sessionPatch(overrides),
    endedAt: SAMPLE_EPOCH + SAMPLE_INTERVAL_MS,
    endReason: 'user-disconnect',
    ...overrides,
  }
}

export function deviceRecord(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  const info = deviceInfo()
  return {
    key: PACK_DEVICE_KEY,
    kind: 'pack',
    defaultLabel: PACK_DEVICE_LABEL,
    userLabel: null,
    model: info.model,
    serialNumber: info.serialNumber,
    hardwareVersion: info.hardwareVersion,
    softwareVersion: info.softwareVersion,
    firstSeenAt: SAMPLE_EPOCH,
    lastSeenAt: SAMPLE_EPOCH,
    sessionCount: 1,
    packUtcOffsetMinutes: null,
    packClockAheadSeconds: null,
    ...overrides,
  }
}

// ── the pack's own ring ──────────────────────────────────────────────────────

/**
 * The pack's RTC counter at `SAMPLE_EPOCH`, so a synthesised record's face lands on the same watch
 * the rest of this file is drawn against. Derived rather than transcribed: the counter's origin is
 * the decoder's own, and a hand-copied constant here would drift from it silently.
 */
export const RING_EPOCH_COUNTER_SECONDS = Math.round((SAMPLE_EPOCH - RTC_EPOCH_UTC_MS) / 1_000)

/** Where the pack writes each field of a record, and at what scale. Mirrors `detailLog.ts`. */
const RECORD_BYTES = 24
const CHARGE_MOSFET_ON = 0x01
const DISCHARGE_MOSFET_ON = 0x02
const BALANCING = 0x04
const HEATING = 0x08

/**
 * One record's worth of pack, in display units.
 *
 * The defaults are the same instant the rest of this file describes — `battery()`'s figures, at the
 * wire scales the record encodes them in — so a record decoded back through `decodeDetailLogRecord`
 * reproduces them exactly rather than to within a rounding.
 */
export interface RingRecordSpec {
  readonly counterSeconds: number
  /** 0 is a scheduled sample; 0x3b is the pair the pack writes when its clock is set. */
  readonly eventCode: number
  readonly chargingEnabled: boolean
  readonly dischargingEnabled: boolean
  readonly balancing: boolean
  readonly heating: boolean
  /** Zero-based, as the record carries them. */
  readonly highestCellIndex: number
  readonly lowestCellIndex: number
  readonly highestCellVoltage: number
  readonly lowestCellVoltage: number
  readonly packVoltage: number
  /** Positive is charge. */
  readonly current: number
  readonly remainingCapacity: number
  readonly nominalCapacity: number
  readonly highestTemperature: number
  readonly lowestTemperature: number
  readonly mosfetTemperature: number
  readonly heatingCurrent: number
}

/** The 24 bytes the pack would have written for that state. The inverse of `decodeDetailLogRecord`. */
export function ringRecordBytes(overrides: Partial<RingRecordSpec> = {}): Uint8Array {
  const spec: RingRecordSpec = {
    counterSeconds: RING_EPOCH_COUNTER_SECONDS,
    eventCode: 0,
    chargingEnabled: true,
    dischargingEnabled: true,
    balancing: false,
    heating: false,
    highestCellIndex: 0,
    lowestCellIndex: 2,
    highestCellVoltage: 3.394,
    lowestCellVoltage: 3.393,
    packVoltage: 13.57,
    current: -8.4,
    remainingCapacity: 309.1,
    nominalCapacity: 315,
    highestTemperature: 27,
    lowestTemperature: 27,
    mosfetTemperature: 30,
    heatingCurrent: 0,
    ...overrides,
  }

  const bytes = new Uint8Array(RECORD_BYTES)
  const record = new DataView(bytes.buffer)
  record.setUint32(0, spec.counterSeconds, true)
  record.setUint8(4, spec.eventCode)
  record.setUint8(
    5,
    (spec.chargingEnabled ? CHARGE_MOSFET_ON : 0) |
      (spec.dischargingEnabled ? DISCHARGE_MOSFET_ON : 0) |
      (spec.balancing ? BALANCING : 0) |
      (spec.heating ? HEATING : 0),
  )
  record.setUint8(6, spec.highestCellIndex)
  record.setUint8(7, spec.lowestCellIndex)
  record.setUint16(8, Math.round(spec.highestCellVoltage * 1_000), true)
  record.setUint16(10, Math.round(spec.lowestCellVoltage * 1_000), true)
  record.setUint16(12, Math.round(spec.packVoltage * 100), true)
  record.setInt16(14, Math.round(spec.current * 10), true)
  record.setUint16(16, Math.round(spec.remainingCapacity * 10), true)
  record.setUint16(18, Math.round(spec.nominalCapacity * 10), true)
  record.setInt8(20, spec.highestTemperature)
  record.setInt8(21, spec.lowestTemperature)
  record.setInt8(22, spec.mosfetTemperature)
  record.setInt8(23, Math.round(spec.heatingCurrent * 10))
  return bytes
}

/**
 * A stretch of scheduled records one sampling period apart, oldest first — the ring as the pack
 * fills it when nothing happens. Every other override applies to every record, so a case that needs
 * a varying signal maps over the result.
 */
export function ringRecords(count: number, overrides: Partial<RingRecordSpec> = {}): Uint8Array[] {
  const from = overrides.counterSeconds ?? RING_EPOCH_COUNTER_SECONDS
  return Array.from({ length: count }, (_unused, position) =>
    ringRecordBytes({ ...overrides, counterSeconds: from + position * PACK_SAMPLING_PERIOD_SECONDS }),
  )
}

/** The pack's RTC counter as a record carries it: the little-endian uint32 at bytes[0..3]. */
export function ringRecordCounter(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
}

/**
 * One stored row. `packClockSeconds` follows the bytes unless a case overrides it deliberately,
 * which is how the invariant binding the two is stated as breakable rather than assumed.
 */
export function ringRecordRow(overrides: Partial<RingRecordRow> = {}): RingRecordRow {
  const bytes = overrides.bytes ?? ringRecordBytes()
  return {
    deviceKey: PACK_DEVICE_KEY,
    seq: 0,
    packClockSeconds: ringRecordCounter(bytes),
    bytes,
    firstReadAt: SAMPLE_EPOCH,
    followsGap: false,
    ...overrides,
  }
}

/**
 * One read, as the fold takes it: eight scheduled records from ring index 0, unbroken.
 *
 * A case that is about the merge overrides `runs`; a case that is about a read carrying nothing
 * passes `runs: []` with the outcome that produced it.
 */
export function ringSnapshot(overrides: Partial<RingSnapshot> = {}): RingSnapshot {
  return {
    deviceKey: PACK_DEVICE_KEY,
    observedAt: SAMPLE_EPOCH,
    outcome: 'records-read',
    runs: [{ firstIndex: 0, records: ringRecords(8) }],
    transport: {
      notificationBytes: 2_360,
      notificationCount: 12,
      assembledFrameCount: 1,
      logFrameCount: 1,
      elapsedMs: 940,
    },
    ...overrides,
  }
}

/**
 * One journal row, as the read that opened a ledger leaves it: nothing to align against, so no
 * overlap and no shift — the ring's movement is only ever measured against a read before it.
 */
export function ringReadRow(overrides: Partial<RingReadRow> = {}): RingReadRow {
  return {
    deviceKey: PACK_DEVICE_KEY,
    observedAt: SAMPLE_EPOCH,
    outcome: 'records-read',
    notificationBytes: 2_360,
    notificationCount: 12,
    assembledFrameCount: 1,
    logFrameCount: 1,
    indexSpan: { from: 0, to: 7 },
    recordsReceived: 8,
    recordsAppended: 8,
    overlap: 0,
    ringShift: null,
    gapDeclared: false,
    runsDiscarded: 0,
    newestSampleCounter: RING_EPOCH_COUNTER_SECONDS + 7 * PACK_SAMPLING_PERIOD_SECONDS,
    newestSampleSeq: 7,
    elapsedMs: 940,
    ...overrides,
  }
}

// ── warnings ─────────────────────────────────────────────────────────────────

export function warningSnapshot(overrides: Partial<WarningSnapshot> = {}): WarningSnapshot {
  return {
    packCurrentA: -8.4,
    packVoltageV: 13.573,
    stateOfCharge: 98,
    cellDeltaMv: 1,
    highestCell: 1,
    lowestCell: 3,
    mosfetTemperatureC: 30.1,
    temperature1C: 27.5,
    temperature2C: 27.1,
    chargingEnabled: true,
    dischargingEnabled: true,
    solarChargeState: 'bulk',
    pvPowerW: 168,
    solarBatteryCurrentA: 12.3,
    housePowerW: 176,
    houseCurrentA: 13,
    houseLoadPlausible: true,
    ...overrides,
  }
}

export function warningRecord(overrides: Partial<WarningRecord> = {}): WarningRecord {
  return {
    sessionId: SESSION_ID,
    seq: 0,
    at: SAMPLE_EPOCH,
    level: 'warning',
    title: 'MOSFET hot',
    detail: '72.0 °C. Reduce load or improve ventilation.',
    snapshot: warningSnapshot(),
    ...overrides,
  }
}

// ── the localStorage snapshot ────────────────────────────────────────────────

export function rememberedSession(overrides: Partial<RememberedSession> = {}): RememberedSession {
  return {
    version: REMEMBERED_SCHEMA_VERSION,
    capturedAt: SAMPLE_EPOCH,
    battery: battery(),
    solar: null,
    device: null,
    settings: null,
    solarRssi: -67,
    status: { worst: 'good', headline: 'All nominal' },
    ...overrides,
  }
}

function timeline(count: number, from: number = SAMPLE_EPOCH): number[] {
  const times: number[] = []
  for (let index = 0; index < count; index += 1) times.push(from + index * SAMPLE_INTERVAL_MS)
  return times
}

/**
 * The monotonic reading a row's wall stamp implies. A builder refuses a row it cannot hold, and a
 * fixture wider than one chunk is a fixture the spec did not mean to write, so the refusal is
 * raised here rather than silently producing a short chunk.
 */
function appendAll<Sample extends { readonly at: number }>(
  samples: readonly Sample[],
  baseMonotonic: number,
  append: (sample: Sample, monotonic: number) => boolean,
): void {
  const baseAt = samples[0]?.at ?? SAMPLE_EPOCH
  for (const sample of samples) {
    if (!append(sample, baseMonotonic + (sample.at - baseAt))) {
      throw new Error(`sample at ${sample.at} does not fit the chunk starting at ${baseAt}`)
    }
  }
}
