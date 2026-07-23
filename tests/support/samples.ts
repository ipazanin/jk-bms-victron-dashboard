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
import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../../src/domain/bms/types'
import { PackChunkBuilder, SolarChunkBuilder } from '../../src/domain/history/columns'
import { packDefaultLabel, packDeviceKeyFor, UNIDENTIFIED_PACK_KEY } from '../../src/domain/history/identity'
import { EMPTY_LEDGER } from '../../src/domain/history/ledger'
import { SAMPLE_INTERVAL_MS } from '../../src/domain/history/types'
import type {
  DeviceKey,
  DeviceRecord,
  PackChunk,
  PackSample,
  SessionId,
  SessionRecord,
  SolarChunk,
  SolarSample,
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
export const PACK_DEVICE_LABEL = packDefaultLabel(deviceInfo(), null)
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

export function bmsSettings(overrides: Partial<BmsSettings> = {}): BmsSettings {
  return {
    cellCount: 4,
    nominalCapacity: 315,
    cellOverVoltage: 3.65,
    cellUnderVoltage: 2.5,
    balanceTriggerDelta: 0.01,
    startBalanceVoltage: 3.1,
    maxBalanceCurrent: 2,
    chargeOverTemperature: 70,
    chargeUnderTemperature: -10,
    mosfetOverTemperature: 80,
    balancerEnabled: true,
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
