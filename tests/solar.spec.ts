import { describe, expect, it } from 'vitest'

import fixtures from './fixtures.json'
import {
  decodeSolarAdvertisement,
  decryptRecord,
  importAdvertisementKey,
  matchesKey,
  parseAdvertisement,
  parseAdvertisementKey,
  parseSolarRecord,
} from '../src/domain/solar/advertisement'

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const payload = bytes(fixtures.victron.payloadHex)
const key = parseAdvertisementKey(fixtures.victron.advertisementKey)
const expected = fixtures.victron.expected

describe('parseAdvertisementKey', () => {
  it('accepts a 32-character hex key, case and whitespace insensitive', () => {
    expect(parseAdvertisementKey(' 0123456789ABCDEF0123456789abcdef ')).toHaveLength(16)
  })

  it('rejects anything that is not 32 hex characters', () => {
    expect(() => parseAdvertisementKey('abc')).toThrow(/32 hexadecimal/)
    expect(() => parseAdvertisementKey('z'.repeat(32))).toThrow(/32 hexadecimal/)
    expect(() => parseAdvertisementKey('0'.repeat(31))).toThrow()
    expect(() => parseAdvertisementKey('0'.repeat(33))).toThrow()
  })
})

describe('parseAdvertisement', () => {
  it('reads the plaintext prologue', () => {
    const header = parseAdvertisement(payload)!
    expect(header).not.toBeNull()
    expect(header.recordType).toBe(0x01)
    expect(header.keyCheckByte).toBe(key[0])
    expect(header.ciphertext).toHaveLength(12)
  })

  it('returns null for a payload too short to hold a header', () => {
    expect(parseAdvertisement(new Uint8Array([0x10, 0x02, 0x57]))).toBeNull()
  })

  it('returns null when the record prefix is absent', () => {
    const wrong = payload.slice()
    wrong[0] = 0x11
    expect(parseAdvertisement(wrong)).toBeNull()
  })
})

describe('matchesKey — the marina test', () => {
  it('accepts an advertisement from the device holding the key', () => {
    expect(matchesKey(parseAdvertisement(payload)!, key)).toBe(true)
  })

  it('rejects a neighbouring Victron device broadcasting under the same company id', () => {
    const foreign = payload.slice()
    foreign[7] = key[0] ^ 0xff
    expect(matchesKey(parseAdvertisement(foreign)!, key)).toBe(false)
  })
})

describe('decrypt and parse', () => {
  it('recovers the exact plaintext record', async () => {
    const header = parseAdvertisement(payload)!
    const cryptoKey = await importAdvertisementKey(key)
    const plaintext = await decryptRecord(header, cryptoKey)
    expect(Buffer.from(plaintext).toString('hex')).toBe(fixtures.victron.plaintextHex)
  })

  it('decodes every field to the expected value', async () => {
    const cryptoKey = await importAdvertisementKey(key)
    const reading = (await decodeSolarAdvertisement(payload, key, cryptoKey))!

    expect(reading.chargeState).toBe(expected.chargeState)
    expect(reading.chargerError).toBe(expected.chargerError)
    expect(reading.batteryVoltage).toBeCloseTo(expected.batteryVoltage, 3)
    expect(reading.batteryCurrent).toBeCloseTo(expected.batteryCurrent, 3)
    expect(reading.yieldTodayKwh).toBeCloseTo(expected.yieldTodayKwh, 3)
    expect(reading.pvPower).toBe(expected.pvPower)
    expect(reading.loadCurrent).toBeNull()
  })

  it('returns null rather than garbage when decoded with the wrong key', async () => {
    const wrongKey = parseAdvertisementKey('ff'.repeat(16))
    const cryptoKey = await importAdvertisementKey(wrongKey)
    expect(await decodeSolarAdvertisement(payload, wrongKey, cryptoKey)).toBeNull()
  })
})

describe('parseSolarRecord sentinels', () => {
  it('maps the not-available sentinels to null instead of absurd readings', () => {
    const plaintext = new Uint8Array([
      0x05, 0x00,
      0xff, 0x7f, // voltage sentinel
      0xff, 0x7f, // current sentinel
      0xff, 0xff, // yield sentinel
      0xff, 0xff, // pv sentinel
      0xff, 0xff, // load sentinel (9 bits set)
    ])
    const reading = parseSolarRecord(plaintext)
    expect(reading.batteryVoltage).toBeNull()
    expect(reading.batteryCurrent).toBeNull()
    expect(reading.yieldTodayKwh).toBeNull()
    expect(reading.pvPower).toBeNull()
    expect(reading.loadCurrent).toBeNull()
  })

  it('reads a negative battery current as negative', () => {
    const plaintext = new Uint8Array([0x03, 0x00, 0x41, 0x05, 0xf6, 0xff, 0x69, 0x00, 0x63, 0x00, 0xff, 0xff])
    expect(parseSolarRecord(plaintext).batteryCurrent).toBeCloseTo(-1.0, 3)
  })

  it('throws on a truncated record rather than returning partial data', () => {
    expect(() => parseSolarRecord(new Uint8Array([0x05, 0x00, 0x41]))).toThrow(/too short/)
  })

  it('reports no load current when the byte carrying its ninth bit is absent', () => {
    // An 11-byte record holds the low byte but not bit 8. Guessing that bit either way
    // fabricates a reading: 0x50 with the bit set is 33.6 A, with it clear 8.0 A.
    const eleven = new Uint8Array([0x05, 0x00, 0x41, 0x05, 0x47, 0x00, 0x69, 0x00, 0x63, 0x00, 0x50])
    expect(parseSolarRecord(eleven).loadCurrent).toBeNull()
  })

  it('reads a real load current when both bytes are present', () => {
    const twelve = new Uint8Array([0x05, 0x00, 0x41, 0x05, 0x47, 0x00, 0x69, 0x00, 0x63, 0x00, 0x50, 0x00])
    expect(parseSolarRecord(twelve).loadCurrent).toBeCloseTo(8.0, 3)
  })
})
