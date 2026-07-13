// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import { useTelemetry } from '../src/application/telemetry'
import type { BatterySnapshot } from '../src/domain/bms/types'
import type { SolarReading } from '../src/domain/solar/types'

// The annunciator's whole value is that its thresholds are exactly where they claim to be, so
// each case pins the fault list at a boundary and just below it. telemetry.ts is a module-level
// singleton; battery/solar are writable shallowRefs, and setting them directly drives the faults
// computed with no BLE and no persistence (only applySnapshot writes to localStorage), so the
// tests stay independent by resetting both refs before each.

function battery(overrides: Partial<BatterySnapshot> = {}): BatterySnapshot {
  return {
    cellVoltages: [3.394, 3.394, 3.393, 3.394],
    cellResistances: [0.052, 0.053, 0.053, 0.053],
    averageCellVoltage: 3.393,
    cellDelta: 0.001,
    highestCell: 1,
    lowestCell: 3,
    packVoltage: 13.0,
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
    chargeState: 'bulk',
    chargerError: 0,
    batteryVoltage: 13.0,
    batteryCurrent: 7.9,
    yieldTodayKwh: 0.42,
    pvPower: 151,
    loadCurrent: null,
    ...overrides,
  }
}

const telemetry = useTelemetry()

function titles(): string[] {
  return telemetry.faults.value.map((fault) => fault.title)
}

function levelOf(title: string) {
  return telemetry.faults.value.find((fault) => fault.title === title)?.level
}

beforeEach(() => {
  telemetry.battery.value = null
  telemetry.solar.value = null
})

describe('cell imbalance thresholds', () => {
  it('stays silent just below the warning spread', () => {
    telemetry.battery.value = battery({ cellDelta: 0.0099 })
    expect(titles()).not.toContain('Cell imbalance')
  })

  it('warns at the warning spread', () => {
    telemetry.battery.value = battery({ cellDelta: 0.01 })
    expect(levelOf('Cell imbalance')).toBe('warning')
  })

  it('escalates to serious at the serious spread', () => {
    telemetry.battery.value = battery({ cellDelta: 0.05 })
    expect(levelOf('Cell imbalance')).toBe('serious')
  })
})

describe('MOSFET temperature thresholds', () => {
  it('stays silent just below the warning temperature', () => {
    telemetry.battery.value = battery({ mosfetTemperature: 54.9 })
    expect(titles()).not.toContain('MOSFET warm')
  })

  it('warns at the warning temperature', () => {
    telemetry.battery.value = battery({ mosfetTemperature: 55 })
    expect(levelOf('MOSFET warm')).toBe('warning')
  })

  it('is serious at the serious temperature', () => {
    telemetry.battery.value = battery({ mosfetTemperature: 70 })
    expect(levelOf('MOSFET hot')).toBe('serious')
  })

  it('is critical at the critical temperature', () => {
    telemetry.battery.value = battery({ mosfetTemperature: 80 })
    expect(levelOf('MOSFET over temperature')).toBe('critical')
  })
})

describe('cell temperature threshold', () => {
  it('stays silent just below the warning temperature', () => {
    telemetry.battery.value = battery({ temperatureSensor1: 44.9, temperatureSensor2: 27.1 })
    expect(titles()).not.toContain('Cells warm')
  })

  it('warns when the hotter of the two sensors reaches the warning temperature', () => {
    telemetry.battery.value = battery({ temperatureSensor1: 27.5, temperatureSensor2: 45 })
    expect(levelOf('Cells warm')).toBe('warning')
  })
})

describe('MOSFET enable flags', () => {
  it('warns when charging is disabled', () => {
    telemetry.battery.value = battery({ chargingEnabled: false })
    expect(levelOf('Charge MOSFET off')).toBe('warning')
  })

  it('warns when discharging is disabled', () => {
    telemetry.battery.value = battery({ dischargingEnabled: false })
    expect(levelOf('Discharge MOSFET off')).toBe('warning')
  })

  it('is silent when both are enabled', () => {
    telemetry.battery.value = battery()
    expect(titles()).not.toContain('Charge MOSFET off')
    expect(titles()).not.toContain('Discharge MOSFET off')
  })
})

describe('state of charge threshold', () => {
  it('warns at the low-charge boundary', () => {
    telemetry.battery.value = battery({ stateOfCharge: 20 })
    expect(levelOf('Low charge')).toBe('warning')
  })

  it('stays silent just above the boundary', () => {
    telemetry.battery.value = battery({ stateOfCharge: 21 })
    expect(titles()).not.toContain('Low charge')
  })
})

describe('charger error', () => {
  it('is silent when the charger reports no error', () => {
    telemetry.battery.value = battery()
    telemetry.solar.value = solar({ chargerError: 0 })
    expect(titles()).not.toContain('Charger error')
  })

  it('is critical when the charger reports any error', () => {
    telemetry.battery.value = battery()
    telemetry.solar.value = solar({ chargerError: 33 })
    expect(levelOf('Charger error')).toBe('critical')
  })
})

describe('bus voltage agreement', () => {
  it('is silent when the two radios agree within tolerance', () => {
    telemetry.battery.value = battery({ packVoltage: 13.573 })
    telemetry.solar.value = solar({ batteryVoltage: 13.873 }) // 0.3 V apart, at the tolerance
    expect(titles()).not.toContain('Devices disagree on bus voltage')
  })

  it('warns when the disagreement exceeds tolerance', () => {
    telemetry.battery.value = battery({ packVoltage: 13.573 })
    telemetry.solar.value = solar({ batteryVoltage: 13.883 }) // 0.31 V apart, over the tolerance
    expect(levelOf('Devices disagree on bus voltage')).toBe('warning')
  })
})

describe('worst fault escalation', () => {
  it('is good with a clean snapshot', () => {
    telemetry.battery.value = battery()
    expect(telemetry.worstFault.value).toBe('good')
  })

  it('takes the highest level across several concurrent faults', () => {
    telemetry.battery.value = battery({
      cellDelta: 0.01, // warning
      stateOfCharge: 15, // warning
      mosfetTemperature: 80, // critical
    })
    expect(telemetry.worstFault.value).toBe('critical')
  })
})
