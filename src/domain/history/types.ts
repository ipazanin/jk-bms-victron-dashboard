/**
 * The archive's shapes. Declarations only — every decision about them lives in a sibling module.
 *
 * Two rules produced almost everything below and are worth stating once, here, where the shapes
 * are:
 *
 * **Store what the radios said, derive the rest on read.** There is no `housePower` column and
 * no `houseCurrent` column, because the house load is `solar − pack` and that arithmetic is
 * cheap. Storing it would freeze today's noise floor into every recording; deriving it means a
 * correction to the floor corrects sessions already on disk.
 *
 * **Two streams, never one joined row.** The pack and the controller are separate radios on
 * separate cadences, and a row carrying both would have to invent whichever half had not spoken
 * yet. They are stored apart and paired on read, under an explicit staleness bound, so a gap in
 * one stream stays a gap instead of becoming a stale number in a joined row.
 */

import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../bms/types'
import type { ChargeState, SolarReading } from '../solar/types'

export type SessionId = string
export type DeviceKey = string

export const PACK_STREAM = 'pack'
export const SOLAR_STREAM = 'solar'
export type StreamName = typeof PACK_STREAM | typeof SOLAR_STREAM

/**
 * Bumped when a column is added, removed or rescaled. Independent of the database version:
 * decoding dispatches on this, so a layout change leaves chunks already written readable
 * instead of forcing a migration that would have to rewrite tens of megabytes.
 */
export const CHUNK_LAYOUT_VERSION = 1

/** 300 rows ≈ 5 min at 1 Hz ≈ 8.5 KiB serialized — under Chromium's 64 KiB blob-wrapping threshold. */
export const CHUNK_CAPACITY = 300

/** A chunk seals early past this span, so a Uint32 millisecond offset can never approach its limit. */
export const MAX_CHUNK_SPAN_MS = 30 * 60_000

/** The recorder's own per-stream gate, measured on its own monotonic clock. */
export const SAMPLE_INTERVAL_MS = 1_000

/**
 * A session whose heartbeat is older than this has no live writer behind it: its tab was killed,
 * or frozen so hard its checkpoint timer stopped. Recovery closes it and pruning may evict it;
 * inside the window it is treated as live in some tab and is never touched, which is what stops
 * one tab evicting the session another is still writing.
 */
export const HEARTBEAT_STALE_MS = 10 * 60_000

// ── samples, in display units. Never stored in this shape. ────────────────────

export interface PackSample {
  readonly at: number
  readonly currentA: number
  readonly packVoltageV: number
  readonly stateOfCharge: number
  readonly remainingCapacityAh: number
  readonly cellDeltaV: number
  /** 1-based; 0 when the frame carried no populated cells. */
  readonly highestCell: number
  readonly lowestCell: number
  readonly mosfetTemperatureC: number
  readonly temperatureSensor1C: number
  readonly temperatureSensor2C: number
  readonly chargingEnabled: boolean
  readonly dischargingEnabled: boolean
}

export interface SolarSample {
  readonly at: number
  readonly chargeState: ChargeState
  readonly chargerError: number
  readonly batteryVoltageV: number | null
  readonly batteryCurrentA: number | null
  readonly yieldTodayKwh: number | null
  readonly pvPowerW: number | null
  readonly loadCurrentA: number | null
  readonly rssi: number
}

// ── chunks: exactly-sized typed arrays at the radios' own wire scales ─────────

export interface ChunkKey {
  readonly sessionId: SessionId
  readonly stream: StreamName
  readonly seq: number
}

export interface ChunkHeader extends ChunkKey {
  readonly layout: number
  /** Wall clock of row 0. A row's wall time is baseAt + offsetMs[index]. */
  readonly baseAt: number
  /**
   * performance.now() at the same instant. Offsets are measured against this and never against
   * the wall clock, so a clock step mid-chunk cannot produce a negative or duplicated offset.
   */
  readonly baseMonotonic: number
  /** (wall elapsed − monotonic elapsed) at the last write. Non-zero means the clock was stepped. */
  readonly wallDriftMs: number
  /** Authoritative. A partial tail chunk is short and the capacity says nothing about it. */
  readonly length: number
  /** False only for the single open tail chunk of an open session. */
  readonly sealed: boolean
}

/**
 * 28 bytes a row: 4+4+4+4 + 2+2+2+2 + 1+1+1+1.
 *
 * Every field sits at the integer scale decoding multiplies away, and that scale is the one the
 * BMS transmitted, so the round trip is exactly lossless — 3.394 V in, 3.394 V out, never
 * 3.3939999.
 *
 * Per-cell voltages and resistances are deliberately absent: 4 to 32 Uint16 a row would dominate
 * a 28-byte row. The session's final BatterySnapshot carries the cell ladder, and `cellDeltaMv`
 * with the two extreme indices carries balance over time.
 */
export interface PackChunk extends ChunkHeader {
  readonly stream: typeof PACK_STREAM
  readonly offsetMs: Uint32Array
  readonly currentMa: Int32Array
  readonly packVoltageMv: Uint32Array
  readonly remainingCapacityMah: Uint32Array
  /** A difference of two millivolt integers, so this is exact rather than rounded. */
  readonly cellDeltaMv: Uint16Array
  readonly mosfetDeciC: Int16Array
  readonly temperature1DeciC: Int16Array
  readonly temperature2DeciC: Int16Array
  readonly stateOfCharge: Uint8Array
  readonly highestCell: Uint8Array
  readonly lowestCell: Uint8Array
  /** Bit 0 charging enabled, bit 1 discharging enabled. */
  readonly switches: Uint8Array
}

/**
 * 17 bytes a row: 4 + 2+2+2+2+2 + 1+1+1.
 *
 * Absent values keep the sentinels Victron itself broadcasts, already declared beside the
 * advertisement decoder and already exercised by its tests. No NaN sentinel is invented here or
 * anywhere: NaN passes the `value !== null` guard every instrument uses, so it would reach a path
 * `d` attribute as the literal "NaN" and collapse the scale of the strip it was drawn in.
 */
export interface SolarChunk extends ChunkHeader {
  readonly stream: typeof SOLAR_STREAM
  readonly offsetMs: Uint32Array
  /** Centi-volts. */
  readonly batteryVoltageCv: Int16Array
  /** Deci-amps. */
  readonly batteryCurrentDa: Int16Array
  /** Hundredths of a kWh. */
  readonly yieldTodayHwh: Uint16Array
  readonly pvPowerW: Uint16Array
  /** Nine-bit deci-amps, held in sixteen. */
  readonly loadCurrentDa: Uint16Array
  /** The raw Victron state byte, so a state this build has never heard of survives on disk. */
  readonly chargeStateCode: Uint8Array
  readonly chargerError: Uint8Array
  readonly rssiDbm: Int8Array
}

export type HistoryChunk = PackChunk | SolarChunk

// ── the session row ──────────────────────────────────────────────────────────

export type SessionEndReason =
  /** A disconnect or a stopped scan, with the other link already idle. */
  | 'user-disconnect'
  /** gattserverdisconnected. */
  | 'link-lost'
  /** Three stall strikes, roughly 24 s of silence, or the recorder's own idle timer. */
  | 'stalled'
  /** A different pack serial appeared on an open session. */
  | 'device-changed'
  /** Found open with a stale heartbeat on a later load. */
  | 'abandoned'

export type CoverageClass =
  /** Both radios reported inside this run. */
  | 'both'
  | 'pack-only'
  | 'solar-only'
  /** Both reported and solar − pack was negative: an unmeasured charger was on the bus. */
  | 'foreign'
  /** Neither radio reported. */
  | 'none'

export interface CoverageRun {
  readonly from: number
  readonly to: number
  readonly kind: CoverageClass
}

/**
 * The session's energy account, folded incrementally as samples arrive so the archive list
 * renders without reading a single chunk. It is a cache of a pure function of the chunks —
 * recomputing it from the chunks reproduces it exactly, and the export document carries both so
 * the two can be compared.
 *
 * The partition between the counted window and the foreign window sits at strict zero rather
 * than at the house-load noise floor. The floor is an allowance for the noise on one
 * instantaneous reading, and over an integrated interval that noise averages out — so a
 * floor-independent boundary keeps a stored ledger valid if the floor is ever corrected.
 */
export interface SessionLedger {
  /** Milliseconds in which both radios reported and solar − pack was non-negative. */
  readonly countedMs: number
  /** Milliseconds in which both reported and solar − pack was negative. Reported, never counted. */
  readonly foreignMs: number
  /** Amp-hours through the pack across the counted window. Signed; positive is charge. */
  readonly packAh: number
  /** Amp-hours the controller delivered across the counted window. */
  readonly solarAh: number
  /** Watt-hours out to the boat across the counted window: house = solar − pack, integrated. */
  readonly houseWh: number
  /** Floor on unmeasured charge: ∫max(0, pack − solar) over the foreign window, in amp-hours. */
  readonly foreignAhFloor: number
  /** Every pack sample, counted window or not, for the cross-check against the two windows. */
  readonly packAhWholeSession: number
  readonly stateOfChargeFirst: number | null
  readonly stateOfChargeLast: number | null
  readonly stateOfChargeMin: number | null
  readonly remainingCapacityFirstAh: number | null
  readonly remainingCapacityLastAh: number | null
  readonly pvPowerPeakW: number | null
}

export interface SessionEntry {
  readonly at: number
  readonly kind: 'begin' | 'fault' | 'cleared' | 'gap' | 'deepest' | 'end'
  readonly level: 'good' | 'warning' | 'serious' | 'critical' | 'neutral'
  /** The annunciator text exactly as it read at the time, never re-derived from stale numbers. */
  readonly text: string
}

// ── warnings: a fault kept with the data that caused it ───────────────────────

/** A warning is never 'good' or 'neutral' — those are the absence of one. */
export type WarningLevel = 'warning' | 'serious' | 'critical'

/**
 * The instrument readings at the instant a warning fired, kept beside it so the log can answer
 * "what caused this" without replaying the whole session. Every field is what a radio actually
 * said and nothing derived is stored except the house figures, which the reconciliation owns and
 * which a later floor correction would change — so they carry their own plausibility flag.
 */
export interface WarningSnapshot {
  readonly packCurrentA: number | null
  readonly packVoltageV: number | null
  readonly stateOfCharge: number | null
  readonly cellDeltaMv: number | null
  readonly highestCell: number | null
  readonly lowestCell: number | null
  readonly mosfetTemperatureC: number | null
  readonly temperature1C: number | null
  readonly temperature2C: number | null
  readonly chargingEnabled: boolean | null
  readonly dischargingEnabled: boolean | null
  readonly solarChargeState: ChargeState | null
  readonly pvPowerW: number | null
  readonly solarBatteryCurrentA: number | null
  readonly housePowerW: number | null
  readonly houseCurrentA: number | null
  readonly houseLoadPlausible: boolean | null
}

/**
 * One warning episode: it is written once when the fault first appears, not once per second it
 * stands, and it carries the annunciator text exactly as it read plus the snapshot behind it.
 */
export interface WarningRecord {
  readonly sessionId: SessionId
  /** 0-based within its session, so the primary key [sessionId, seq] orders episodes as they fired. */
  readonly seq: number
  readonly at: number
  readonly level: WarningLevel
  readonly title: string
  readonly detail: string
  readonly snapshot: WarningSnapshot
}

/** A flapping fault could otherwise write a warning a second; past this a session records no more. */
export const MAX_SESSION_WARNINGS = 200

export interface SessionRecord {
  readonly id: SessionId
  /** The snapshot schema in force when this row was written. */
  readonly schema: number
  /** One per tab, so two tabs recording at once can never share a pointer. */
  readonly writerId: string
  /** A string rather than a nullable flag, because IndexedDB cannot index null. */
  readonly state: 'open' | 'closed'
  /** The first sample of either stream. */
  readonly startedAt: number
  readonly endedAt: number | null
  readonly endReason: SessionEndReason | null
  /** Refreshed inside the same transaction as every tail write. Staleness is the crash signal. */
  readonly heartbeatAt: number

  readonly packDeviceKey: DeviceKey | null
  readonly solarDeviceKey: DeviceKey | null
  /** Never empty, so the by-device index cannot silently skip a row. */
  readonly groupKey: DeviceKey

  readonly packSamples: number
  readonly solarSamples: number
  /** Rows in sealed chunks only. The archive total is the sum of these across every row. */
  readonly sealedSamples: number
  readonly packChunks: number
  readonly solarChunks: number

  /** Set when pruning dropped the head, so the view can show where retained data really starts. */
  readonly retainedFrom: number | null
  /** Chunks the store refused. The session admits a hole rather than hiding it. */
  readonly droppedChunks: number
  /** Set when this session continues one a crashed tab left open. Displayed, never merged. */
  readonly continues: SessionId | null

  readonly coverage: readonly CoverageRun[]
  readonly ledger: SessionLedger
  readonly entries: readonly SessionEntry[]

  readonly finalBattery: BatterySnapshot | null
  readonly finalSolar: SolarReading | null
  readonly deviceInfo: DeviceInfo | null
  readonly settings: BmsSettings | null
}

export interface DeviceRecord {
  readonly key: DeviceKey
  readonly kind: 'pack' | 'solar'
  /** Derived, and kept after a rename so it stays clear which name the owner chose. */
  readonly defaultLabel: string
  /** Null until renamed. Clearing the field restores the default rather than blanking the device. */
  readonly userLabel: string | null
  readonly model: string | null
  readonly serialNumber: string | null
  readonly hardwareVersion: string | null
  readonly softwareVersion: string | null
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly sessionCount: number
}

export interface HistoryMeta {
  readonly key: 'totals'
  /** Invariant: exactly the sum of sealedSamples over every surviving session row. */
  readonly totalSamples: number
  readonly schema: number
  readonly createdAt: number
  readonly lastPrunedAt: number | null
}

export interface TimeWindow {
  readonly from: number
  readonly to: number
}
