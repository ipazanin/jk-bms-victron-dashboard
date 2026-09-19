/**
 * The last live session is remembered in this browser's localStorage and nowhere else,
 * so a page load without hardware — or in a browser with no Web Bluetooth at all — shows
 * the last-seen instruments instead of the empty landing page. Like the encryption key,
 * it never leaves the browser: the site is static and has no backend.
 *
 * This is the fast path, and the archive is not: localStorage is synchronous, so the last frame
 * is on screen at first paint, whereas opening IndexedDB would flash the landing page first.
 * The two are kept in step by SNAPSHOT_SCHEMA_VERSION rather than by separate version constants.
 *
 * Only a genuinely live session is ever written here — the write is guarded on the source being
 * 'live', so nothing restored or replayed can overwrite the frame it was itself restored from.
 */

import { SNAPSHOT_SCHEMA_VERSION } from '../domain/schemaVersion'
import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../domain/bms/types'
import type { ChargeState, SolarReading } from '../domain/solar/types'
// Type-only: FaultLevel is erased at build, so this leaves no runtime import edge back
// into telemetry.ts. Importing a *value* from telemetry here would create a cycle.
import type { FaultLevel, TrendPoint } from './telemetry'
import { storageKey } from './storageKey'

const SESSION_STORAGE = 'shunt.rememberedSession'

/**
 * Derived, never declared: this payload holds the same decoded shapes the Log stores, so a build
 * that renames a field on either of them must invalidate both stores or leave one reading the
 * other's ghosts.
 */
export const REMEMBERED_SCHEMA_VERSION = SNAPSHOT_SCHEMA_VERSION

/** Ten minutes at one point per second, including both endpoints. */
export const MAX_REMEMBERED_TREND_POINTS = 601

export interface RememberedStatus {
  /** Captured annunciator severity, preserved as history rather than re-run as a live alarm. */
  readonly worst: FaultLevel
  /** The one-line summary exactly as it read at capture. */
  readonly headline: string
}

export interface RememberedSession {
  /** Schema gate; any mismatch is treated as corrupt and discarded. */
  readonly version: number
  /** Epoch ms of the snapshot observation, never the write time, so the age stays honest. */
  readonly capturedAt: number
  /** Null for a solar-only watch; at least one radio must have reported. */
  readonly battery: BatterySnapshot | null
  /** House load and SolarRow; null when solar was never connected. */
  readonly solar: SolarReading | null
  /** Firmware/model line in BreakerPanel. */
  readonly device: DeviceInfo | null
  /** balanceTriggerDelta for CellLadder. */
  readonly settings: BmsSettings | null
  /** SolarRow signal line. */
  readonly solarRssi: number
  /** Captured summary, so the alarm engine is not re-run against stale numbers. */
  readonly status: RememberedStatus
  /** Captured trend, never fed back into live observation windows. Optional for older saves. */
  readonly history?: readonly TrendPoint[]
  /** The pack that produced the trend, so reconnect never joins different packs. */
  readonly bmsDeviceId?: string | null
}

export function saveRememberedSession(session: RememberedSession): void {
  try {
    localStorage.setItem(storageKey(SESSION_STORAGE), JSON.stringify(session))
  } catch {
    // Private browsing denies storage; the session simply will not persist.
  }
}

export function loadRememberedSession(): RememberedSession | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(storageKey(SESSION_STORAGE))
  } catch {
    return null
  }
  if (raw === null) return null

  const session = parseRememberedSession(raw)
  if (session === null) {
    // Corrupt or wrong-version entries are cleared so they never reload.
    forgetRememberedSession()
    return null
  }
  return session
}

export function forgetRememberedSession(): void {
  try {
    localStorage.removeItem(storageKey(SESSION_STORAGE))
  } catch {
    // Nothing to clear.
  }
}

function parseRememberedSession(raw: string): RememberedSession | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  if (parsed.version !== REMEMBERED_SCHEMA_VERSION) return null

  const capturedAt = parsed.capturedAt
  if (!isFiniteNumber(capturedAt) || capturedAt <= 0 || capturedAt > 8.64e15) return null

  if (parsed.battery !== null && !isValidBattery(parsed.battery)) return null
  if (!isValidSolarOrNull(parsed.solar)) return null
  if (parsed.battery === null && parsed.solar === null) return null
  if (!isValidDeviceOrNull(parsed.device)) return null
  if (!isValidSettingsOrNull(parsed.settings)) return null
  if (!isFiniteNumber(parsed.solarRssi)) return null
  if (!isValidStatus(parsed.status)) return null
  if (
    parsed.bmsDeviceId !== undefined &&
    parsed.bmsDeviceId !== null &&
    typeof parsed.bmsDeviceId !== 'string'
  ) return null

  // An optional damaged trend must not cost the valid instrument snapshot.
  if (parsed.history !== undefined && !isValidHistory(parsed.history)) {
    return { ...parsed, history: [] } as unknown as RememberedSession
  }
  return parsed as unknown as RememberedSession
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isNonEmptyNumberArray(value: unknown): value is number[] {
  // An empty array would clear the cell ladder to zero cells; a battery always has cells.
  return Array.isArray(value) && value.length > 0 && value.every(isFiniteNumber)
}

function isValidBattery(value: unknown): value is BatterySnapshot {
  if (!isRecord(value)) return false
  return (
    isNonEmptyNumberArray(value.cellVoltages) &&
    isNonEmptyNumberArray(value.cellResistances) &&
    isFiniteNumber(value.averageCellVoltage) &&
    isFiniteNumber(value.cellDelta) &&
    isFiniteNumber(value.highestCell) &&
    isFiniteNumber(value.lowestCell) &&
    isFiniteNumber(value.packVoltage) &&
    isFiniteNumber(value.current) &&
    isFiniteNumber(value.power) &&
    isFiniteNumber(value.stateOfCharge) &&
    isFiniteNumber(value.remainingCapacity) &&
    isFiniteNumber(value.nominalCapacity) &&
    isFiniteNumber(value.cycleCount) &&
    isFiniteNumber(value.cycledCapacity) &&
    isFiniteNumber(value.mosfetTemperature) &&
    isFiniteNumber(value.temperatureSensor1) &&
    isFiniteNumber(value.temperatureSensor2) &&
    isFiniteNumber(value.uptimeSeconds) &&
    isBoolean(value.chargingEnabled) &&
    isBoolean(value.dischargingEnabled)
  )
}

function isValidSolarOrNull(value: unknown): value is SolarReading | null {
  if (value === null) return true
  if (!isRecord(value)) return false
  const chargeStates: readonly ChargeState[] = ['off', 'fault', 'bulk', 'absorption', 'float', 'equalize', 'starting', 'unknown']
  return (
    chargeStates.includes(value.chargeState as ChargeState) &&
    isFiniteNumber(value.chargerError) &&
    isFiniteNumberOrNull(value.batteryVoltage) &&
    isFiniteNumberOrNull(value.batteryCurrent) &&
    isFiniteNumberOrNull(value.yieldTodayKwh) &&
    isFiniteNumberOrNull(value.pvPower) &&
    isFiniteNumberOrNull(value.loadCurrent)
  )
}

function isValidDeviceOrNull(value: unknown): value is DeviceInfo | null {
  if (value === null) return true
  if (!isRecord(value)) return false
  return (
    typeof value.model === 'string' &&
    typeof value.hardwareVersion === 'string' &&
    typeof value.softwareVersion === 'string' &&
    typeof value.serialNumber === 'string' &&
    isFiniteNumber(value.uptimeSeconds) &&
    isFiniteNumber(value.powerOnCount)
  )
}

function isValidSettingsOrNull(value: unknown): value is BmsSettings | null {
  if (value === null) return true
  if (!isRecord(value)) return false
  return (
    isFiniteNumber(value.cellCount) &&
    isFiniteNumber(value.nominalCapacity) &&
    isFiniteNumber(value.cellOverVoltage) &&
    isFiniteNumber(value.cellUnderVoltage) &&
    isFiniteNumber(value.balanceTriggerDelta) &&
    isFiniteNumber(value.startBalanceVoltage) &&
    isFiniteNumber(value.maxBalanceCurrent) &&
    isFiniteNumber(value.chargeOverTemperature) &&
    isFiniteNumber(value.chargeUnderTemperature) &&
    isFiniteNumber(value.mosfetOverTemperature) &&
    isBoolean(value.balancerEnabled)
  )
}

function isValidStatus(value: unknown): value is RememberedStatus {
  if (!isRecord(value)) return false
  const levels: readonly FaultLevel[] = ['good', 'warning', 'serious', 'critical']
  return levels.includes(value.worst as FaultLevel) && typeof value.headline === 'string'
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function isValidHistory(history: unknown): history is readonly TrendPoint[] {
  if (!Array.isArray(history) || history.length > MAX_REMEMBERED_TREND_POINTS) return false
  let previousAt = 0
  for (const point of history) {
    if (!isRecord(point) || !isFiniteNumber(point.at) || point.at <= previousAt) return false
    if (!isFiniteNumber(point.packCurrent) || !isFiniteNumber(point.packVoltage)) return false
    if (!isFiniteNumberOrNull(point.pvPower) || !isFiniteNumberOrNull(point.housePower)) return false
    previousAt = point.at
  }
  return true
}
