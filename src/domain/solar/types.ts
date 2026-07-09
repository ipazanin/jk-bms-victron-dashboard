export const VICTRON_COMPANY_ID = 0x02e1

export const RECORD_SOLAR_CHARGER = 0x01

/** Sentinels the Victron record uses for "not available". */
export const NOT_AVAILABLE_I16 = 0x7fff
export const NOT_AVAILABLE_U16 = 0xffff
export const NOT_AVAILABLE_U9 = 0x1ff

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
