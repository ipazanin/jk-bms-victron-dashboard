export const VICTRON_COMPANY_ID = 0x02e1

export const RECORD_SOLAR_CHARGER = 0x01

/** Sentinels the Victron record uses for "not available". */
export const NOT_AVAILABLE_I16 = 0x7fff
export const NOT_AVAILABLE_U16 = 0xffff
export const NOT_AVAILABLE_U9 = 0x1ff
export const NOT_AVAILABLE_U32 = 0xffffffff

export type ChargeState =
  | 'off'
  | 'fault'
  | 'bulk'
  | 'absorption'
  | 'float'
  | 'equalize'
  | 'starting'
  | 'unknown'

export const CHARGE_STATES: Readonly<Record<number, ChargeState>> = {
  0: 'off',
  2: 'fault',
  3: 'bulk',
  4: 'absorption',
  5: 'float',
  7: 'equalize',
  245: 'starting',
}

/** The plaintext prologue of an Instant Readout advertisement. */
export interface AdvertisementHeader {
  readonly modelId: number
  readonly recordType: number
  readonly nonce: number
  readonly keyCheckByte: number
  readonly ciphertext: Uint8Array
}

export interface SolarReading {
  readonly chargeState: ChargeState
  readonly chargerError: number
  readonly batteryVoltage: number | null
  readonly batteryCurrent: number | null
  readonly yieldTodayKwh: number | null
  readonly pvPower: number | null
  readonly loadCurrent: number | null
}

/** The four charger error codes a history record keeps, most recent first. 0 is "no error". */
export type RecentChargerErrors = readonly [number, number, number, number]

/**
 * One day the controller has stored. Volts, amps, watts and kilowatt-hours; durations in minutes,
 * which is the unit the register itself counts in.
 */
export interface RecordedSolarHistoryDay {
  readonly recorded: true
  /**
   * Identifies the day and stays with the record as it ages down the backlog: it advances by one
   * per day and wraps to zero at 365, so it orders days only within a single year's window.
   */
  readonly daySequenceNumber: number
  readonly yieldKwh: number
  /** Null on a controller without a load output, which reports the field as not available. */
  readonly consumedKwh: number | null
  readonly maxBatteryVoltage: number
  readonly minBatteryVoltage: number
  readonly errorDatabase: number
  readonly errors: RecentChargerErrors
  readonly minutesInBulk: number
  readonly minutesInAbsorption: number
  readonly minutesInFloat: number
  readonly maxPvPower: number
  readonly maxBatteryCurrent: number
  readonly maxPvVoltage: number
}

/**
 * A daily register the controller has not written yet. A recorded day of zero yield is a
 * different thing — a boat under cover produces those — so the two never share a shape.
 */
export interface UnwrittenSolarHistoryDay {
  readonly recorded: false
}

export type SolarHistoryDay = RecordedSolarHistoryDay | UnwrittenSolarHistoryDay

/** The lifetime record that sits alongside the daily backlog. */
export interface SolarHistoryTotals {
  readonly errorDatabase: number
  readonly errors: RecentChargerErrors
  /** Yield since the owner last reset the counter in VictronConnect. */
  readonly resettableYieldKwh: number
  /** Yield over the controller's whole life, which nothing resets. */
  readonly systemYieldKwh: number
  readonly maxPvVoltage: number
  readonly maxBatteryVoltage: number
  /** How many daily registers hold data, so a fetch need not poll the whole backlog blindly. */
  readonly daysAvailable: number
  /** Null on firmware that does not carry the field. */
  readonly minBatteryVoltage: number | null
}
