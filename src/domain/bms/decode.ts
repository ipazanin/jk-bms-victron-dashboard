/**
 * Frame decoders for the JK-BMS 300-byte protocol frames.
 *
 * Offsets were derived from captured frames and hold for firmware 19.10 / hardware 19H.
 * Two invariants make a decode self-checking on live data, and both are asserted by the
 * test suite: the cell voltages must sum to the pack voltage within sense-wire drop, and
 * pack voltage times current must equal the reported power.
 *
 * The BMS also reports its own delta / highest-cell / lowest-cell, but those fields lag
 * the voltage block by at least one sample, so they are recomputed here instead.
 *
 * Pack power at 154 is an UNSIGNED MAGNITUDE, unlike the signed current beside it at 158.
 * A discharge frame read from the hardware carries current bytes `0e e2 ff ff` (−7.666 A)
 * next to power bytes `41 98 01 00` (104.513 W = |V × I|). Reading it signed would be
 * wrong; the sign lives on the current, and only there.
 */

import { MAX_CELLS } from './protocol'
import type { BatterySnapshot, BmsSettings, DeviceInfo } from './types'

const MILLI = 0.001
const DECI = 0.1

const CELL_VOLTAGE_BASE = 6
const ENABLED_CELL_MASK = 70
const AVERAGE_CELL_VOLTAGE = 74
const CELL_RESISTANCE_BASE = 80
const MOSFET_TEMPERATURE = 144
const PACK_VOLTAGE = 150
const PACK_POWER = 154
const PACK_CURRENT = 158
const TEMPERATURE_1 = 162
const TEMPERATURE_2 = 164
const STATE_OF_CHARGE = 173
const REMAINING_CAPACITY = 174
const NOMINAL_CAPACITY = 178
const CYCLE_COUNT = 182
const CYCLED_CAPACITY = 186
const UPTIME = 194
const CHARGE_SWITCH = 198
const DISCHARGE_SWITCH = 199

function view(frame: Uint8Array): DataView {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
}

function ascii(frame: Uint8Array, offset: number, length: number): string {
  const slice = frame.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  const bytes = end === -1 ? slice : slice.subarray(0, end)
  return String.fromCharCode(...bytes)
}

function popCount(value: number): number {
  let count = 0
  let remaining = value >>> 0
  while (remaining !== 0) {
    count += remaining & 1
    remaining >>>= 1
  }
  return count
}

export function decodeCellInfo(frame: Uint8Array): BatterySnapshot {
  const data = view(frame)
  // A corrupt mask must not make us read past the 32-cell block.
  const cellCount = Math.min(MAX_CELLS, popCount(data.getUint32(ENABLED_CELL_MASK, true)))

  const cellVoltages: number[] = []
  const cellResistances: number[] = []
  for (let index = 0; index < cellCount; index += 1) {
    cellVoltages.push(data.getUint16(CELL_VOLTAGE_BASE + index * 2, true) * MILLI)
    cellResistances.push(data.getUint16(CELL_RESISTANCE_BASE + index * 2, true) * MILLI)
  }

  const populated = cellVoltages.length > 0
  const highest = cellVoltages.reduce((best, value, index) => (value > cellVoltages[best] ? index : best), 0)
  const lowest = cellVoltages.reduce((best, value, index) => (value < cellVoltages[best] ? index : best), 0)

  return {
    cellVoltages,
    cellResistances,
    averageCellVoltage: data.getUint16(AVERAGE_CELL_VOLTAGE, true) * MILLI,
    cellDelta: populated ? cellVoltages[highest] - cellVoltages[lowest] : 0,
    highestCell: populated ? highest + 1 : 0,
    lowestCell: populated ? lowest + 1 : 0,
    packVoltage: data.getUint32(PACK_VOLTAGE, true) * MILLI,
    power: data.getUint32(PACK_POWER, true) * MILLI,
    current: data.getInt32(PACK_CURRENT, true) * MILLI,
    stateOfCharge: frame[STATE_OF_CHARGE],
    remainingCapacity: data.getUint32(REMAINING_CAPACITY, true) * MILLI,
    nominalCapacity: data.getUint32(NOMINAL_CAPACITY, true) * MILLI,
    cycleCount: data.getUint32(CYCLE_COUNT, true),
    cycledCapacity: data.getUint32(CYCLED_CAPACITY, true) * MILLI,
    mosfetTemperature: data.getInt16(MOSFET_TEMPERATURE, true) * DECI,
    temperatureSensor1: data.getInt16(TEMPERATURE_1, true) * DECI,
    temperatureSensor2: data.getInt16(TEMPERATURE_2, true) * DECI,
    uptimeSeconds: data.getUint32(UPTIME, true),
    chargingEnabled: frame[CHARGE_SWITCH] === 1,
    dischargingEnabled: frame[DISCHARGE_SWITCH] === 1,
  }
}

export function decodeDeviceInfo(frame: Uint8Array): DeviceInfo {
  const data = view(frame)
  return {
    model: ascii(frame, 6, 16),
    hardwareVersion: ascii(frame, 22, 8),
    softwareVersion: ascii(frame, 30, 8),
    serialNumber: ascii(frame, 86, 16),
    uptimeSeconds: data.getUint32(38, true),
    powerOnCount: data.getUint32(42, true),
  }
}

export function decodeSettings(frame: Uint8Array): BmsSettings {
  const data = view(frame)
  return {
    cellUnderVoltage: data.getUint32(10, true) * MILLI,
    cellOverVoltage: data.getUint32(18, true) * MILLI,
    balanceTriggerDelta: data.getUint32(26, true) * MILLI,
    maxBalanceCurrent: data.getUint32(78, true) * MILLI,
    chargeOverTemperature: data.getInt32(82, true) * DECI,
    chargeUnderTemperature: data.getInt32(98, true) * DECI,
    mosfetOverTemperature: data.getInt32(106, true) * DECI,
    cellCount: data.getUint32(114, true),
    balancerEnabled: data.getUint32(126, true) === 1,
    nominalCapacity: data.getUint32(130, true) * MILLI,
    startBalanceVoltage: data.getUint32(138, true) * MILLI,
  }
}
