/**
 * What a Victron SmartSolar tells anyone listening.
 *
 * Only what it is doing now. An Instant Readout advertisement is one instant and carries no series
 * at all, so nothing here stands in for the controller's stored days: those come off the same radio
 * by a different route, the 306b GATT tunnel in `tunnel/`, decoded by `history.ts`.
 */

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
