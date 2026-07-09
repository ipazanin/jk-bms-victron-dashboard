import { describe, expect, it } from 'vitest'

import fixtures from './fixtures.json'
import { decodeCellInfo, decodeDeviceInfo, decodeSettings } from '../src/domain/bms/decode'
import {
  CMD_CELL_INFO,
  CMD_DEVICE_INFO,
  FRAME_CELL_INFO,
  FRAME_DEVICE_INFO,
  FRAME_SETTINGS,
  FrameAssembler,
  buildCommand,
  frameType,
  isChecksumValid,
} from '../src/domain/bms/protocol'

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const cellInfo = bytes(fixtures.bmsCellInfoHex)
const deviceInfo = bytes(fixtures.bmsDeviceInfoHex)
const settings = bytes(fixtures.bmsSettingsHex)

describe('command construction', () => {
  it('produces the exact device-info frame the BMS accepts', () => {
    expect(Buffer.from(buildCommand(CMD_DEVICE_INFO)).toString('hex')).toBe(
      'aa5590eb97000000000000000000000000000011',
    )
  })

  it('produces the exact cell-info frame the BMS accepts', () => {
    expect(Buffer.from(buildCommand(CMD_CELL_INFO)).toString('hex')).toBe(
      'aa5590eb96000000000000000000000000000010',
    )
  })

  it('refuses to build any command that is not a read', () => {
    // 0x01 is the settings-write opcode. It must be impossible to emit.
    expect(() => buildCommand(0x01)).toThrow(/non-read command/)
    expect(() => buildCommand(0x00)).toThrow()
  })
})

describe('frames', () => {
  it('accepts the captured frames and identifies their types', () => {
    expect(isChecksumValid(cellInfo)).toBe(true)
    expect(isChecksumValid(deviceInfo)).toBe(true)
    expect(isChecksumValid(settings)).toBe(true)
    expect(frameType(cellInfo)).toBe(FRAME_CELL_INFO)
    expect(frameType(deviceInfo)).toBe(FRAME_DEVICE_INFO)
    expect(frameType(settings)).toBe(FRAME_SETTINGS)
  })

  it('rejects a frame whose payload was altered', () => {
    const tampered = cellInfo.slice()
    tampered[7] ^= 0xff
    expect(isChecksumValid(tampered)).toBe(false)
  })
})

describe('FrameAssembler', () => {
  it('reassembles a frame split across 20-byte notifications', () => {
    const assembler = new FrameAssembler()
    const emitted: Uint8Array[] = []
    for (let offset = 0; offset < cellInfo.length; offset += 20) {
      emitted.push(...assembler.feed(cellInfo.subarray(offset, offset + 20)))
    }
    expect(emitted).toHaveLength(1)
    expect(Buffer.from(emitted[0])).toEqual(Buffer.from(cellInfo))
  })

  it('reassembles when a notification carries more than one frame boundary', () => {
    const assembler = new FrameAssembler()
    const doubled = new Uint8Array(cellInfo.length * 2)
    doubled.set(cellInfo, 0)
    doubled.set(cellInfo, cellInfo.length)
    expect(assembler.feed(doubled)).toHaveLength(2)
  })

  it('drops a corrupted frame and resynchronises on the next header', () => {
    const assembler = new FrameAssembler()
    const corrupted = cellInfo.slice()
    corrupted[100] ^= 0xff
    const stream = new Uint8Array(corrupted.length + deviceInfo.length)
    stream.set(corrupted, 0)
    stream.set(deviceInfo, corrupted.length)

    const emitted = assembler.feed(stream)
    expect(emitted).toHaveLength(1)
    expect(frameType(emitted[0])).toBe(FRAME_DEVICE_INFO)
  })

  it('survives leading garbage before the first header', () => {
    const assembler = new FrameAssembler()
    const stream = new Uint8Array(7 + cellInfo.length)
    stream.set([1, 2, 3, 4, 5, 6, 7], 0)
    stream.set(cellInfo, 7)
    expect(assembler.feed(stream)).toHaveLength(1)
  })
})

describe('decodeCellInfo — physics invariants on a real frame', () => {
  const snapshot = decodeCellInfo(cellInfo)

  it('finds exactly the cells the enabled-cell mask advertises', () => {
    expect(snapshot.cellVoltages).toHaveLength(4)
    expect(snapshot.cellResistances).toHaveLength(4)
  })

  it('sums the cell voltages to the pack voltage within sense-wire drop', () => {
    const sum = snapshot.cellVoltages.reduce((total, volts) => total + volts, 0)
    expect(Math.abs(sum - snapshot.packVoltage)).toBeLessThan(0.03)
  })

  it('satisfies power = voltage x current', () => {
    const computed = Math.abs(snapshot.packVoltage * snapshot.current)
    expect(Math.abs(computed - snapshot.power)).toBeLessThan(2)
  })

  it('reports plausible physical quantities', () => {
    expect(snapshot.packVoltage).toBeGreaterThan(10)
    expect(snapshot.packVoltage).toBeLessThan(15)
    expect(snapshot.stateOfCharge).toBeGreaterThanOrEqual(0)
    expect(snapshot.stateOfCharge).toBeLessThanOrEqual(100)
    expect(snapshot.nominalCapacity).toBeCloseTo(315, 1)
    expect(snapshot.mosfetTemperature).toBeGreaterThan(-20)
    expect(snapshot.mosfetTemperature).toBeLessThan(90)
  })

  it('derives spread and extremes from the voltages rather than the lagging BMS fields', () => {
    const high = Math.max(...snapshot.cellVoltages)
    const low = Math.min(...snapshot.cellVoltages)
    expect(snapshot.cellDelta).toBeCloseTo(high - low, 6)
    expect(snapshot.cellVoltages[snapshot.highestCell - 1]).toBe(high)
    expect(snapshot.cellVoltages[snapshot.lowestCell - 1]).toBe(low)
  })
})

describe('decodeDeviceInfo', () => {
  it('reads the identity strings', () => {
    const info = decodeDeviceInfo(deviceInfo)
    expect(info.model).toBe('JK_B2A8S20P')
    expect(info.hardwareVersion).toBe('19H')
    expect(info.softwareVersion).toBe('19.10')
    expect(info.serialNumber).toBe('DEMO00000000001')
    expect(info.uptimeSeconds).toBeGreaterThan(0)
  })
})

describe('decodeSettings', () => {
  const parsed = decodeSettings(settings)

  it('reproduces the values cross-checked against the vendor app', () => {
    expect(parsed.cellCount).toBe(4)
    expect(parsed.nominalCapacity).toBeCloseTo(315, 3)
    expect(parsed.cellOverVoltage).toBeCloseTo(3.65, 3)
    expect(parsed.cellUnderVoltage).toBeCloseTo(2.5, 3)
    expect(parsed.balanceTriggerDelta).toBeCloseTo(0.01, 3)
    expect(parsed.startBalanceVoltage).toBeCloseTo(3.1, 3)
    expect(parsed.maxBalanceCurrent).toBeCloseTo(2, 3)
    expect(parsed.balancerEnabled).toBe(true)
  })

  it('reads the low-temperature charge cutoff as a signed value', () => {
    expect(parsed.chargeUnderTemperature).toBeCloseTo(-10, 3)
    expect(parsed.chargeOverTemperature).toBeCloseTo(70, 3)
    expect(parsed.mosfetOverTemperature).toBeCloseTo(80, 3)
  })
})
