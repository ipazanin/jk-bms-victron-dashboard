/**
 * Naming the two radios.
 *
 * The archive groups sessions by device, so each radio needs a key that survives a reconnect, a
 * reload and a rename. The pack hands one over directly: the serial number in its device-info
 * frame. The controller hands over nothing — we never connect to it, so there is no serial to
 * read — and the only per-unit constant we hold is its advertisement encryption key, which must
 * never reach the archive. A digest of that key stands in for it.
 *
 * Labels are derived, never invented. A model id that cannot be mapped to a product name is
 * printed as the model id: a wrong friendly name is worse than a hex number, because a name
 * reads as something somebody verified.
 */

import type { DeviceInfo } from '../bms/types'
import { toArrayBuffer } from '../bytes'
import { parseAdvertisementKey } from '../solar/advertisement'
import type { DeviceKey, DeviceRecord } from './types'

const PACK_SERIAL_PREFIX = 'jk:'
const PACK_NAME_PREFIX = 'name:'
const SOLAR_KEY_PREFIX = 'victron:'

/** Serials from this vendor are heavily zero-padded, so a label carries only the tail that varies. */
const SERIAL_TAIL_LENGTH = 4

/**
 * Bytes of SHA-256 kept. Forty-eight bits separates the handful of controllers one browser will
 * ever see with room to spare, and is far too few to be a checkable guess at the 128-bit key
 * behind it.
 */
const SOLAR_KEY_DIGEST_BYTES = 6

/** The advertisement carries the model id as a 16-bit field; two ids must not look alike because
 *  one happens to have a zero high byte. */
const MODEL_ID_HEX_WIDTH = 4

/** Every session carries a group key, because IndexedDB cannot index null and a row the byDevice
 *  index skips is a row the Log can never show. */
export const UNIDENTIFIED_PACK_KEY = 'pack:unidentified'
export const UNIDENTIFIED_PACK_LABEL = 'Unidentified pack'
export const UNNAMED_PACK_LABEL = 'Unnamed pack'
export const UNNAMED_SOLAR_LABEL = 'Solar controller'

/**
 * The pack's stable join key, or null when the frame carried neither a serial nor a name.
 *
 * `BatterySnapshot.uptimeSeconds` looks like it could tell one connection from another and
 * cannot: it is the BMS's own uptime, it does not reset when the BLE link drops, and it therefore
 * reads the same either side of a gap.
 */
export function packDeviceKeyFor(
  info: DeviceInfo | null,
  advertisedName: string | null,
): DeviceKey | null {
  const serial = packSerial(info)
  if (serial) return `${PACK_SERIAL_PREFIX}${serial}`

  const name = advertisedName?.trim() ?? ''
  return name ? `${PACK_NAME_PREFIX}${name}` : null
}

/**
 * `JK_B2A8S20P · …0001`. The full serial appears once, in the group's identity line; a label
 * repeating fourteen padded zeros would push the part that identifies the pack off the row.
 */
export function packDefaultLabel(info: DeviceInfo | null, advertisedName: string | null): string {
  const model = info?.model.trim() ?? ''
  const serial = packSerial(info)
  if (model && serial) return `${model} · …${serial.slice(-SERIAL_TAIL_LENGTH)}`
  if (model) return model

  const name = advertisedName?.trim() ?? ''
  return name || UNNAMED_PACK_LABEL
}

/**
 * `victron:<48 bits of SHA-256 over the key>`. The key itself never enters the archive, and the
 * digest is one-way, so an exported session names the controller without carrying the secret that
 * decrypts its advertisements.
 *
 * The key is normalised through the same parser the scanner uses, so spacing and case cannot
 * split one controller into two devices.
 */
export async function solarDeviceKeyFor(keyHex: string): Promise<DeviceKey> {
  const key = parseAdvertisementKey(keyHex)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(key)))
  return `${SOLAR_KEY_PREFIX}${hexOf(digest.subarray(0, SOLAR_KEY_DIGEST_BYTES))}`
}

/** `SmartSolar · 0xa060`. The id is printed rather than translated: Victron does not publish the
 *  mapping, and a guessed product name would be the one part of the label a reader trusts. */
export function solarDefaultLabel(modelId: number | null): string {
  if (modelId === null || !Number.isInteger(modelId) || modelId < 0) return UNNAMED_SOLAR_LABEL
  return `SmartSolar · 0x${modelId.toString(16).padStart(MODEL_ID_HEX_WIDTH, '0')}`
}

/**
 * Which device a session files under. A solar-only session is a true statement about what one
 * radio heard, so it groups under the controller rather than being hidden or forced under a pack
 * that was never connected.
 */
export function groupKeyFor(
  packDeviceKey: DeviceKey | null,
  solarDeviceKey: DeviceKey | null,
): DeviceKey {
  return packDeviceKey ?? solarDeviceKey ?? UNIDENTIFIED_PACK_KEY
}

/** The name to print. Clearing the user's label restores the derived one rather than blanking the
 *  device, which is why `defaultLabel` is kept after a rename. */
export function deviceLabel(
  device: DeviceRecord | null,
  fallback: string = UNIDENTIFIED_PACK_LABEL,
): string {
  const chosen = device?.userLabel?.trim() ?? ''
  return chosen || device?.defaultLabel.trim() || fallback
}

function packSerial(info: DeviceInfo | null): string {
  return info?.serialNumber.trim().toUpperCase() ?? ''
}

function hexOf(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}
