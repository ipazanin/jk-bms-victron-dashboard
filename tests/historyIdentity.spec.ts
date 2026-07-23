import { describe, expect, it } from 'vitest'

import { decodeDeviceInfo } from '../src/domain/bms/decode'
import {
  UNIDENTIFIED_PACK_KEY,
  UNIDENTIFIED_PACK_LABEL,
  UNNAMED_PACK_LABEL,
  UNNAMED_SOLAR_LABEL,
  deviceLabel,
  groupKeyFor,
  packDefaultLabel,
  packDeviceKeyFor,
  solarDefaultLabel,
  solarDeviceKeyFor,
} from '../src/domain/history/identity'
import { readAdvertisementModelId } from '../src/domain/solar/advertisement'
import fixtures from './fixtures.json'
import { deviceRecord } from './support/samples'

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

/**
 * The pack is named from the real captured device-info frame, whose serial `DEMO00000000001` is a
 * redacted real serial inside that capture and not demo scaffolding — deleting it would break the
 * decoder regression in `tests/bms.spec.ts`, and it is why the archive's derived label for this
 * pack reads the way it does.
 */
describe('naming the pack', () => {
  const captured = decodeDeviceInfo(bytes(fixtures.bmsDeviceInfoHex))

  it('keys on the serial, which is the only stable join key the hardware gives', () => {
    expect(packDeviceKeyFor(captured, 'JK-B2A8S20P')).toBe('jk:DEMO00000000001')
  })

  it('keeps the full serial in the key and only shortens the label', () => {
    // Serials from this vendor are heavily zero-padded, so a label repeating fourteen zeros would
    // push the part that identifies the pack off the row. Two padded serials still key apart.
    expect(packDefaultLabel(captured, null)).toBe('JK_B2A8S20P · …0001')
    expect(packDeviceKeyFor({ ...captured, serialNumber: 'DEMO00000000002' }, null)).not.toBe(
      packDeviceKeyFor(captured, null),
    )
  })

  it('normalises the serial, so one pack cannot become two devices', () => {
    expect(packDeviceKeyFor({ ...captured, serialNumber: ' demo00000000001 ' }, null)).toBe(
      'jk:DEMO00000000001',
    )
  })

  it('falls back to the advertised Bluetooth name when the frame carried no serial', () => {
    const nameless = { ...captured, model: '', serialNumber: '' }

    expect(packDeviceKeyFor(nameless, 'Starboard JK')).toBe('name:Starboard JK')
    expect(packDefaultLabel(nameless, 'Starboard JK')).toBe('Starboard JK')
  })

  it('has no key at all when the pack said nothing about itself', () => {
    expect(packDeviceKeyFor(null, null)).toBeNull()
    expect(packDeviceKeyFor({ ...captured, model: '', serialNumber: '' }, '   ')).toBeNull()
    expect(packDefaultLabel(null, null)).toBe(UNNAMED_PACK_LABEL)
  })

  it('names the model alone when the serial is missing but the model is not', () => {
    expect(packDefaultLabel({ ...captured, serialNumber: '' }, null)).toBe('JK_B2A8S20P')
  })
})

describe('naming the controller', () => {
  const key = fixtures.victron.advertisementKey

  it('keys on a digest, so the key that decrypts the advertisements never reaches the archive', async () => {
    const deviceKey = await solarDeviceKeyFor(key)

    expect(deviceKey.startsWith('victron:')).toBe(true)
    expect(deviceKey).not.toContain(key)
    // Forty-eight bits: room to spare for the handful of controllers one browser will see, and
    // far too few to be a checkable guess at the 128-bit key behind it.
    expect(deviceKey.slice('victron:'.length)).toHaveLength(12)
  })

  it('gives the same controller the same key every time', async () => {
    expect(await solarDeviceKeyFor(key)).toBe(await solarDeviceKeyFor(key))
  })

  it('is not confused by spacing or case, which would split one controller into two', async () => {
    expect(await solarDeviceKeyFor(key.toUpperCase())).toBe(await solarDeviceKeyFor(key))
    expect(await solarDeviceKeyFor(`${key.slice(0, 16)} ${key.slice(16)}`)).toBe(
      await solarDeviceKeyFor(key),
    )
  })

  it('gives two controllers two keys', async () => {
    const other = `f${key.slice(1)}`

    expect(await solarDeviceKeyFor(other)).not.toBe(await solarDeviceKeyFor(key))
  })

  it('labels the controller with the model id the advertisement carries in plain sight', () => {
    // Printed rather than translated: Victron does not publish the mapping, and a guessed product
    // name would be the one part of the label a reader trusts.
    const modelId = readAdvertisementModelId(bytes(fixtures.victron.payloadHex))

    expect(modelId).toBe(0xa057)
    expect(solarDefaultLabel(modelId)).toBe('SmartSolar · 0xa057')
  })

  it('pads a low model id so two ids cannot look alike', () => {
    expect(solarDefaultLabel(0x0060)).toBe('SmartSolar · 0x0060')
  })

  it('says only what it knows when the model id never arrived', () => {
    expect(solarDefaultLabel(null)).toBe(UNNAMED_SOLAR_LABEL)
    expect(readAdvertisementModelId(new Uint8Array([0, 1, 2]))).toBeNull()
  })
})

describe('which device a session files under', () => {
  it('files under the pack whenever there is one', () => {
    expect(groupKeyFor('jk:DEMO00000000001', 'victron:3f9a17c40b2e')).toBe('jk:DEMO00000000001')
  })

  it('files a solar-only watch under the controller rather than hiding it', () => {
    // A scan with no BMS is a true statement about what one radio heard, and the archive says so.
    expect(groupKeyFor(null, 'victron:3f9a17c40b2e')).toBe('victron:3f9a17c40b2e')
  })

  it('always returns a key, because the by-device index cannot skip a row', () => {
    expect(groupKeyFor(null, null)).toBe(UNIDENTIFIED_PACK_KEY)
    expect(UNIDENTIFIED_PACK_KEY).not.toBe('')
  })
})

describe('the name that gets printed', () => {
  it('prefers the name the owner chose', () => {
    expect(deviceLabel(deviceRecord({ userLabel: 'Starboard bank' }))).toBe('Starboard bank')
  })

  it('restores the derived name when the owner clears the field', () => {
    // Clearing restores the default rather than blanking the device, which is why defaultLabel is
    // kept after a rename.
    expect(deviceLabel(deviceRecord({ userLabel: null }))).toBe('JK_B2A8S20P · …0001')
    expect(deviceLabel(deviceRecord({ userLabel: '   ' }))).toBe('JK_B2A8S20P · …0001')
  })

  it('falls back when there is no device row at all', () => {
    expect(deviceLabel(null)).toBe(UNIDENTIFIED_PACK_LABEL)
    expect(deviceLabel(null, 'Solar controller')).toBe('Solar controller')
  })
})
