// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTelemetry } from '../src/application/telemetry'
import type { Telemetry, TelemetryDeps } from '../src/application/telemetry'
import type { BatterySnapshot } from '../src/domain/bms/types'
import { STEP_EXCLUSION_A } from '../src/domain/cellBalance'
import { battery as capturedBattery, solarReading } from './support/samples'
import { fakeBmsLink, fakeSolarScan } from './support/fakeRadios'
import type { FakeBmsLink, FakeSolarScan } from './support/fakeRadios'

// The annunciator's whole value is that its thresholds are exactly where they claim to be, so
// each case pins the fault list at a boundary and just below it. The frames go in through the
// radio handler rather than by assigning a ref, because the alarm is latched state written by one
// function: a fault list assigned around that function would test nothing the app does.

const ADVERTISEMENT_KEY = '0123456789abcdef0123456789abcdef'

/**
 * The balance verdict is derived from the cell voltages and `cellDelta` is only the raw fallback,
 * so a fixture that moved one without the other would describe a pack that cannot exist.
 */
function battery(overrides: Partial<BatterySnapshot> = {}): BatterySnapshot {
  const cellDelta = overrides.cellDelta ?? 0.001
  return capturedBattery({
    cellVoltages: [3.394, 3.394, 3.394 - cellDelta, 3.394],
    averageCellVoltage: 3.394 - cellDelta / 4,
    cellDelta,
    highestCell: 1,
    lowestCell: 3,
    packVoltage: 13.0,
    ...overrides,
  })
}

/** Millivolts of load-independent divergence per cell, and milliohms of path resistance. */
interface Pack {
  readonly offsetsMv: readonly number[]
  readonly slopesMilliohm: readonly number[]
}

/** The owner's bank: cell 1 reads −7 mV at rest and sags to −13 mV at −4.9 A. */
const OWNERS_PACK: Pack = {
  offsetsMv: [-7.0, 2.333, 2.333, 2.334],
  slopesMilliohm: [1.2, -0.4, -0.4, -0.4],
}

/** The same wiring under a genuine 16 mV of state-of-charge divergence. */
const DIVERGED_PACK: Pack = {
  offsetsMv: [-12.0, 4.0, 4.0, 4.0],
  slopesMilliohm: [1.2, -0.4, -0.4, -0.4],
}

/** A loose terminal on cell 3, on a pack whose cells hold identical charge. */
const LOOSE_TERMINAL_PACK: Pack = {
  offsetsMv: [0, 0, 0, 0],
  slopesMilliohm: [-2, -2, 6, -2],
}

function snapshotOf(pack: Pack, current: number): BatterySnapshot {
  const deviations = pack.offsetsMv.map((offset, cell) => offset + pack.slopesMilliohm[cell] * current)
  const highest = deviations.indexOf(Math.max(...deviations))
  const lowest = deviations.indexOf(Math.min(...deviations))
  return capturedBattery({
    cellVoltages: deviations.map((deviation) => 3.4 + deviation / 1000),
    averageCellVoltage: 3.4,
    cellDelta: (deviations[highest] - deviations[lowest]) / 1000,
    highestCell: highest + 1,
    lowestCell: lowest + 1,
    current,
    packVoltage: 13.6,
  })
}

/**
 * The load dwells rather than alternating every frame. A per-frame square wave straddles a step on
 * every frame, so `STEP_EXCLUSION_A` would drop the whole window and the estimator would correctly
 * refuse to fit anything — a series that proves only that the guard works.
 */
function dwellingCurrents(frames: number, dwell = 8, low = -4.9, high = 4.3): number[] {
  return Array.from({ length: frames }, (_, index) =>
    Math.floor(index / dwell) % 2 === 0 ? low : high,
  )
}

let clock = 0
let telemetry: Telemetry
let bms: FakeBmsLink
let solar: FakeSolarScan

function deps(): TelemetryDeps {
  bms = fakeBmsLink()
  solar = fakeSolarScan()
  return {
    createBmsLink: bms.create,
    createSolarScan: solar.create,
    historyStore: () => null,
    now: () => clock,
    monotonic: () => clock,
    newId: () => 'session',
  }
}

beforeEach(() => {
  clock = Date.now()
  telemetry = createTelemetry(deps())
})

afterEach(() => {
  telemetry.dispose()
  localStorage.clear()
})

function titles(): string[] {
  return telemetry.faults.value.map((fault) => fault.title)
}

function levelOf(title: string) {
  return telemetry.faults.value.find((fault) => fault.title === title)?.level
}

/** Runs a load through the radio, one frame a second, and reports what stood after each. */
function run(pack: Pack, currents: readonly number[], title: string): boolean[] {
  return currents.map((current) => {
    bms.emitSnapshot(snapshotOf(pack, current))
    clock += 1000
    return titles().includes(title)
  })
}

function transitionsIn(states: readonly boolean[]): number {
  let count = 0
  for (let index = 1; index < states.length; index += 1) {
    if (states[index] !== states[index - 1]) count += 1
  }
  return count
}

describe('cell imbalance thresholds', () => {
  it('stays silent just below the warning spread', () => {
    bms.emitSnapshot(battery({ cellDelta: 0.0099 }))
    expect(titles()).not.toContain('Cell imbalance')
  })

  it('warns at the warning spread', () => {
    bms.emitSnapshot(battery({ cellDelta: 0.01 }))
    expect(levelOf('Cell imbalance')).toBe('warning')
  })

  it('escalates to serious at the serious spread', () => {
    bms.emitSnapshot(battery({ cellDelta: 0.05 }))
    expect(levelOf('Cell imbalance')).toBe('serious')
  })

  it('names the current and says the terms are not separated while the load is steady', () => {
    bms.emitSnapshot(battery({ cellDelta: 0.017, current: -4.9 }))
    const detail = telemetry.faults.value.find((fault) => fault.title === 'Cell imbalance')?.detail
    expect(detail).toBe(
      'Spread 17 mV at −4.9 A, uncorrected — the load has not varied enough to separate charge divergence from path resistance.',
    )
  })
})

describe('cell imbalance under a cycling load', () => {
  it('stops calling the owner’s wiring an imbalance once the fit is identified', () => {
    const currents = dwellingCurrents(150)
    const raised = run(OWNERS_PACK, currents, 'Cell imbalance')

    // The raw comparison the old alarm made fires on every low-current frame of this series.
    expect(currents.some((current) => snapshotOf(OWNERS_PACK, current).cellDelta >= 0.01)).toBe(true)
    // Once the window holds enough separated pairs the load term is removed, and what is left is
    // 9.3 mV of divergence — under the trigger, and it stays under it.
    expect(raised.slice(60).some((standing) => standing)).toBe(false)
    // It settles rather than flapping: at most the assertion it opened with and its clearing.
    expect(transitionsIn(raised)).toBeLessThanOrEqual(2)
  })

  it('still annunciates a genuine divergence under the identical load', () => {
    const raised = run(DIVERGED_PACK, dwellingCurrents(150), 'Cell imbalance')

    expect(raised.slice(60).every((standing) => standing)).toBe(true)
    expect(levelOf('Cell imbalance')).toBe('warning')
  })

  it('reports a loose terminal as path resistance rather than as imbalance', () => {
    const raised = run(LOOSE_TERMINAL_PACK, dwellingCurrents(150), 'Cell path resistance')

    expect(raised.slice(60).every((standing) => standing)).toBe(true)
    expect(levelOf('Cell path resistance')).toBe('serious')
    expect(titles()).not.toContain('Cell imbalance')
    expect(telemetry.faults.value.find((fault) => fault.title === 'Cell path resistance')?.detail)
      .toContain('Cell 3 sits 8.0 mΩ above the pack')
  })

  it('drops the frames captured across a load step, whatever the guard is set to', () => {
    expect(STEP_EXCLUSION_A).toBe(1.0)
  })
})

describe('MOSFET temperature thresholds', () => {
  it('stays silent just below the warning temperature', () => {
    bms.emitSnapshot(battery({ mosfetTemperature: 54.9 }))
    expect(titles()).not.toContain('MOSFET warm')
  })

  it('warns at the warning temperature', () => {
    bms.emitSnapshot(battery({ mosfetTemperature: 55 }))
    expect(levelOf('MOSFET warm')).toBe('warning')
  })

  it('is serious at the serious temperature', () => {
    bms.emitSnapshot(battery({ mosfetTemperature: 70 }))
    expect(levelOf('MOSFET hot')).toBe('serious')
  })

  it('is critical at the critical temperature', () => {
    bms.emitSnapshot(battery({ mosfetTemperature: 80 }))
    expect(levelOf('MOSFET over temperature')).toBe('critical')
  })
})

describe('cell temperature threshold', () => {
  it('stays silent just below the warning temperature', () => {
    bms.emitSnapshot(battery({ temperatureSensor1: 44.9, temperatureSensor2: 27.1 }))
    expect(titles()).not.toContain('Cells warm')
  })

  it('warns when the hotter of the two sensors reaches the warning temperature', () => {
    bms.emitSnapshot(battery({ temperatureSensor1: 27.5, temperatureSensor2: 45 }))
    expect(levelOf('Cells warm')).toBe('warning')
  })
})

describe('MOSFET enable flags', () => {
  it('warns when charging is disabled', () => {
    bms.emitSnapshot(battery({ chargingEnabled: false }))
    expect(levelOf('Charge MOSFET off')).toBe('warning')
  })

  it('warns when discharging is disabled', () => {
    bms.emitSnapshot(battery({ dischargingEnabled: false }))
    expect(levelOf('Discharge MOSFET off')).toBe('warning')
  })

  it('is silent when both are enabled', () => {
    bms.emitSnapshot(battery())
    expect(titles()).not.toContain('Charge MOSFET off')
    expect(titles()).not.toContain('Discharge MOSFET off')
  })
})

describe('state of charge threshold', () => {
  it('warns at the low-charge boundary', () => {
    bms.emitSnapshot(battery({ stateOfCharge: 20 }))
    expect(levelOf('Low charge')).toBe('warning')
  })

  it('stays silent just above the boundary', () => {
    bms.emitSnapshot(battery({ stateOfCharge: 21 }))
    expect(titles()).not.toContain('Low charge')
  })
})

describe('charger error', () => {
  it('is silent when the charger reports no error', () => {
    bms.emitSnapshot(battery())
    solar.emitReading(solarReading({ chargerError: 0, batteryVoltage: 13.0 }))
    expect(titles()).not.toContain('Charger error')
  })

  it('is critical when the charger reports any error', () => {
    bms.emitSnapshot(battery())
    solar.emitReading(solarReading({ chargerError: 33, batteryVoltage: 13.0 }))
    expect(levelOf('Charger error')).toBe('critical')
  })
})

describe('bus voltage agreement', () => {
  it('is silent when the two radios agree within tolerance', () => {
    bms.emitSnapshot(battery({ packVoltage: 13.573 }))
    solar.emitReading(solarReading({ batteryVoltage: 13.873 })) // 0.3 V apart, at the tolerance
    expect(titles()).not.toContain('Devices disagree on bus voltage')
  })

  it('warns when the disagreement exceeds tolerance', () => {
    bms.emitSnapshot(battery({ packVoltage: 13.573 }))
    solar.emitReading(solarReading({ batteryVoltage: 13.883 })) // 0.31 V apart, over the tolerance
    expect(levelOf('Devices disagree on bus voltage')).toBe('warning')
  })
})

describe('worst fault escalation', () => {
  it('is good with a clean snapshot', () => {
    bms.emitSnapshot(battery())
    expect(telemetry.worstFault.value).toBe('good')
  })

  it('takes the highest level across several concurrent faults', () => {
    bms.emitSnapshot(
      battery({
        cellDelta: 0.01, // warning
        stateOfCharge: 15, // warning
        mosfetTemperature: 80, // critical
      }),
    )
    expect(telemetry.worstFault.value).toBe('critical')
  })
})

describe('the off-delay', () => {
  it('holds a fault whose condition has gone false, then drops it', () => {
    bms.emitSnapshot(battery({ mosfetTemperature: 80 }))
    expect(levelOf('MOSFET over temperature')).toBe('critical')

    clock += 9000
    bms.emitSnapshot(battery({ mosfetTemperature: 30 }))
    expect(titles()).toContain('MOSFET over temperature')
    // The list is what worstFault reads, so a latched fault still colours the annunciator.
    expect(telemetry.worstFault.value).toBe('critical')

    clock += 2000
    bms.emitSnapshot(battery({ mosfetTemperature: 30 }))
    expect(titles()).not.toContain('MOSFET over temperature')
    expect(telemetry.worstFault.value).toBe('good')
  })

  it('never delays an annunciation on the way in', () => {
    bms.emitSnapshot(battery())
    expect(titles()).toHaveLength(0)

    bms.emitSnapshot(battery({ mosfetTemperature: 80 }))
    expect(levelOf('MOSFET over temperature')).toBe('critical')
  })

  it('keeps a standing fault ahead of one on its way out', () => {
    bms.emitSnapshot(battery({ mosfetTemperature: 80 }))
    clock += 1000
    bms.emitSnapshot(battery({ mosfetTemperature: 30, stateOfCharge: 15 }))

    expect(titles()).toEqual(['Low charge', 'MOSFET over temperature'])
  })
})

describe('a scan with no pack', () => {
  it('reports the charger error with no battery snapshot at all', async () => {
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    solar.emitReading(solarReading({ chargerError: 33 }))

    expect(telemetry.battery.value).toBeNull()
    expect(levelOf('Charger error')).toBe('critical')
  })
})
