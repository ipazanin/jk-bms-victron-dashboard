/**
 * Victron "Instant Readout" advertisement decoding.
 *
 * The 20-byte manufacturer payload is a plaintext prologue followed by 12 bytes of
 * AES-CTR ciphertext. Byte 7 is a check byte equal to the first byte of the device's
 * encryption key — the only cheap way to tell your own controller apart from every other
 * Victron device in a marina, all of which advertise under the same company id.
 *
 * The ciphertext is shorter than one AES block, so the CTR counter never increments and
 * the endianness of the increment cannot affect the result. Only the initial counter
 * block matters: the 2-byte nonce little-endian, then fourteen zero bytes.
 */

import { toArrayBuffer } from '../bytes'
import {
  CHARGE_STATES,
  NOT_AVAILABLE_I16,
  NOT_AVAILABLE_U16,
  NOT_AVAILABLE_U9,
  RECORD_SOLAR_CHARGER,
} from './types'
import type { AdvertisementHeader, SolarReading } from './types'

const ADVERTISEMENT_PREFIX = 0x10
const MIN_HEADER_LENGTH = 8
const KEY_LENGTH = 16
/** Everything up to PV power occupies ten bytes; load current needs two more. */
const MIN_PLAINTEXT_LENGTH = 10
const LOAD_CURRENT_LENGTH = 12

export function parseAdvertisementKey(hex: string): Uint8Array {
  const cleaned = hex.trim().toLowerCase().replace(/\s+/g, '')
  if (!/^[0-9a-f]{32}$/.test(cleaned)) {
    throw new Error('The encryption key must be exactly 32 hexadecimal characters.')
  }
  const key = new Uint8Array(KEY_LENGTH)
  for (let index = 0; index < KEY_LENGTH; index += 1) {
    key[index] = Number.parseInt(cleaned.slice(index * 2, index * 2 + 2), 16)
  }
  return key
}

export function parseAdvertisement(payload: Uint8Array): AdvertisementHeader | null {
  if (payload.length < MIN_HEADER_LENGTH || payload[0] !== ADVERTISEMENT_PREFIX) return null
  const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  return {
    modelId: data.getUint16(2, true),
    recordType: payload[4],
    nonce: data.getUint16(5, true),
    keyCheckByte: payload[7],
    ciphertext: payload.slice(8),
  }
}

/**
 * The model id alone, or null when these bytes are not a Victron advertisement.
 *
 * It sits in the plaintext prologue, so it is the one thing a controller says about itself
 * without a key and without ever being connected to — the only identity the archive can put on
 * a device it never handshakes with.
 */
export function readAdvertisementModelId(payload: Uint8Array): number | null {
  return parseAdvertisement(payload)?.modelId ?? null
}

/** True when this advertisement was produced by the device holding `key`. */
export function matchesKey(header: AdvertisementHeader, key: Uint8Array): boolean {
  return header.keyCheckByte === key[0]
}

export function importAdvertisementKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(key), 'AES-CTR', false, ['decrypt'])
}

function counterBlock(nonce: number): Uint8Array {
  const counter = new Uint8Array(16)
  counter[0] = nonce & 0xff
  counter[1] = (nonce >> 8) & 0xff
  return counter
}

export async function decryptRecord(header: AdvertisementHeader, key: CryptoKey): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: toArrayBuffer(counterBlock(header.nonce)), length: 128 },
    key,
    toArrayBuffer(header.ciphertext),
  )
  return new Uint8Array(plaintext)
}

export function parseSolarRecord(plaintext: Uint8Array): SolarReading {
  if (plaintext.length < MIN_PLAINTEXT_LENGTH) {
    throw new Error(`solar record too short: ${plaintext.length} bytes`)
  }
  const data = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength)

  const voltage = data.getInt16(2, true)
  const current = data.getInt16(4, true)
  const yieldToday = data.getUint16(6, true)
  const pvPower = data.getUint16(8, true)

  // Load current is nine bits straddling bytes 10 and 11. Without byte 11 the ninth bit is
  // unknown, and defaulting it either way would fabricate a reading — so report nothing.
  const loadCurrent =
    plaintext.length >= LOAD_CURRENT_LENGTH ? plaintext[10] | ((plaintext[11] & 0x01) << 8) : NOT_AVAILABLE_U9

  return {
    chargeState: CHARGE_STATES[plaintext[0]] ?? 'unknown',
    chargerError: plaintext[1],
    batteryVoltage: voltage === NOT_AVAILABLE_I16 ? null : voltage / 100,
    batteryCurrent: current === NOT_AVAILABLE_I16 ? null : current / 10,
    yieldTodayKwh: yieldToday === NOT_AVAILABLE_U16 ? null : yieldToday / 100,
    pvPower: pvPower === NOT_AVAILABLE_U16 ? null : pvPower,
    loadCurrent: loadCurrent === NOT_AVAILABLE_U9 ? null : loadCurrent / 10,
  }
}

/** Full path: raw manufacturer bytes to a reading. Returns null for other devices. */
export async function decodeSolarAdvertisement(
  payload: Uint8Array,
  key: Uint8Array,
  cryptoKey: CryptoKey,
): Promise<SolarReading | null> {
  const header = parseAdvertisement(payload)
  if (!header) return null
  if (header.recordType !== RECORD_SOLAR_CHARGER) return null
  if (!matchesKey(header, key)) return null
  return parseSolarRecord(await decryptRecord(header, cryptoKey))
}
