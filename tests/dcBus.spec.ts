import { describe, expect, it } from 'vitest'

import { hoursToEmpty, hoursToFull, reconcile } from '../src/domain/dcBus'
import type { BatterySnapshot } from '../src/domain/bms/types'
import type { SolarReading } from '../src/domain/solar/types'

function battery(overrides: Partial<BatterySnapshot> = {}): BatterySnapshot {
  return {
    cellVoltages: [3.394, 3.394, 3.393, 3.394],
    cellResistances: [0.052, 0.053, 0.053, 0.053],
    averageCellVoltage: 3.393,
    cellDelta: 0.001,
    highestCell: 1,
    lowestCell: 3,
    packVoltage: 13.573,
    current: -8.4,
    power: 114.0,
    stateOfCharge: 98,
    remainingCapacity: 309.1,
    nominalCapacity: 315,
    cycleCount: 4,
    cycledCapacity: 1268.6,
    mosfetTemperature: 30.1,
    temperatureSensor1: 27.5,
    temperatureSensor2: 27.1,
    uptimeSeconds: 4_481_077,
    chargingEnabled: true,
    dischargingEnabled: true,
    ...overrides,
  }
}

function solar(overrides: Partial<SolarReading> = {}): SolarReading {
  return {
    chargeState: 'float',
    chargerError: 0,
    batteryVoltage: 13.48,
    batteryCurrent: 7.9,
    yieldTodayKwh: 1.03,
    pvPower: 110,
    loadCurrent: null,
    ...overrides,
  }
}

describe('reconcile — the virtual shunt', () => {
  it('derives the house load as solar minus pack, across zero', () => {
    const bus = reconcile(battery(), solar())!
    expect(bus.houseCurrent).toBeCloseTo(16.3, 6)
    expect(bus.housePower).toBeCloseTo(16.3 * 13.573, 3)
  })

  it('derives the house load when both tips sit on the charging side', () => {
    const bus = reconcile(battery({ current: 5.0 }), solar({ batteryCurrent: 7.9 }))!
    expect(bus.houseCurrent).toBeCloseTo(2.9, 6)
  })

  it('yields zero house load when the pack absorbs everything the panels make', () => {
    const bus = reconcile(battery({ current: 7.9 }), solar({ batteryCurrent: 7.9 }))!
    expect(bus.houseCurrent).toBeCloseTo(0, 6)
  })

  it('flags disagreement when the two devices report different bus voltages', () => {
    expect(reconcile(battery(), solar())!.voltagesAgree).toBe(true)
    expect(reconcile(battery(), solar({ batteryVoltage: 12.0 }))!.voltagesAgree).toBe(false)
  })

  it('refuses to invent a reading when the controller reports no current', () => {
    expect(reconcile(battery(), solar({ batteryCurrent: null }))).toBeNull()
    expect(reconcile(battery(), solar({ batteryVoltage: null }))).toBeNull()
  })
})

describe('projections', () => {
  it('estimates time to full only while charging', () => {
    expect(hoursToFull(battery({ current: -8.4 }))).toBeNull()
    expect(hoursToFull(battery({ current: 5.9, remainingCapacity: 309.1 }))).toBeCloseTo(1.0, 1)
  })

  it('reports zero hours when already at nominal capacity', () => {
    expect(hoursToFull(battery({ current: 2, remainingCapacity: 315 }))).toBe(0)
  })

  it('estimates time to empty only while discharging', () => {
    expect(hoursToEmpty(battery({ current: 2 }))).toBeNull()
    expect(hoursToEmpty(battery({ current: -10, remainingCapacity: 300 }))).toBeCloseTo(30, 6)
  })
})
