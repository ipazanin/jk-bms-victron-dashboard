import { describe, expect, it } from 'vitest'

import { hoursToEmpty, hoursToFull, project, reconcile, storedEnergy } from '../src/domain/dcBus'
import { reachOf } from '../src/domain/reach'
import type { Reach } from '../src/domain/reach'
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

  it('agrees at the voltage tolerance and disagrees just past it', () => {
    // Default pack sits at 13.573 V: +0.300 V is the edge, +0.310 V is over.
    expect(reconcile(battery(), solar({ batteryVoltage: 13.873 }))!.voltagesAgree).toBe(true)
    expect(reconcile(battery(), solar({ batteryVoltage: 13.883 }))!.voltagesAgree).toBe(false)
  })

  it('trusts the house load while solar is the sole charger', () => {
    expect(reconcile(battery(), solar())!.houseLoadPlausible).toBe(true)
    expect(reconcile(battery({ current: 7.9 }), solar({ batteryCurrent: 7.9 }))!.houseLoadPlausible).toBe(true)
  })

  it('withholds the house load when the pack draws more than the panels deliver', () => {
    // Engine running: solar 7.9 A but the pack takes 27.9 A, so an alternator is charging.
    expect(reconcile(battery({ current: 27.9 }), solar({ batteryCurrent: 7.9 }))!.houseLoadPlausible).toBe(false)
  })

  it('holds the flag at the noise floor and drops it just beyond', () => {
    expect(reconcile(battery({ current: 8 }), solar({ batteryCurrent: 7.5 }))!.houseLoadPlausible).toBe(true)
    expect(reconcile(battery({ current: 8 }), solar({ batteryCurrent: 7.4 }))!.houseLoadPlausible).toBe(false)
  })

  it('refuses to invent a reading when the controller reports no current', () => {
    expect(reconcile(battery(), solar({ batteryCurrent: null }))).toBeNull()
    expect(reconcile(battery(), solar({ batteryVoltage: null }))).toBeNull()
  })
})

describe('stored energy', () => {
  it('values the charge at nominal cell voltage, not at the voltage on the bus', () => {
    const stored = storedEnergy(battery(), 4)!

    expect(stored.nominalVoltage).toBeCloseTo(12.8, 6)
    expect(stored.wattHours).toBeCloseTo(309.1 * 12.8, 6)
  })

  it('holds the figure still while a load drags the pack voltage down', () => {
    // The windlass takes the bus from 13.573 V to 12.6 V and the charge does not move. A figure
    // taken from the live voltage would shed 300 Wh here and hand them back when the load drops.
    const resting = storedEnergy(battery(), 4)!
    const loaded = storedEnergy(battery({ packVoltage: 12.6, current: -90 }), 4)!

    expect(loaded.wattHours).toBe(resting.wattHours)
  })

  it('reads the series count off the cell frame until the settings frame arrives', () => {
    const fromCells = storedEnergy(battery(), null)!

    expect(fromCells.nominalVoltage).toBeCloseTo(12.8, 6)
    expect(fromCells.wattHours).toBeCloseTo(309.1 * 12.8, 6)
  })

  it('withholds the figure when no source knows how many cells are in series', () => {
    expect(storedEnergy(battery({ cellVoltages: [] }), null)).toBeNull()
    expect(storedEnergy(battery({ cellVoltages: [] }), 0)).toBeNull()
  })

  it('takes the charge from the coulomb count rather than from the quantised percentage', () => {
    // 98 % of 315 Ah is 308.7 Ah; the counter says 309.1 Ah, and the counter is what is used.
    const stored = storedEnergy(battery({ stateOfCharge: 98, remainingCapacity: 309.1 }), 4)!

    expect(stored.wattHours).toBeCloseTo(309.1 * 12.8, 6)
  })
})

describe('projections', () => {
  it('estimates time to full only while charging', () => {
    expect(hoursToFull(battery({ current: -8.4 }), -8.4)).toBeNull()
    expect(hoursToFull(battery({ current: 5.9, remainingCapacity: 309.1 }), 5.9)).toBeCloseTo(1.0, 1)
  })

  it('reports zero hours when already at nominal capacity', () => {
    expect(hoursToFull(battery({ current: 2, remainingCapacity: 315 }), 2)).toBe(0)
  })

  it('estimates time to empty only while discharging', () => {
    expect(hoursToEmpty(battery({ current: 2 }), 2)).toBeNull()
    expect(hoursToEmpty(battery({ current: -10, remainingCapacity: 300 }), -10)).toBeCloseTo(30, 6)
  })

  it('leaves both projections blank across the rest deadband', () => {
    expect(hoursToFull(battery({ current: 0.05 }), 0.05)).toBeNull()
    expect(hoursToEmpty(battery({ current: -0.05 }), -0.05)).toBeNull()
    // A 0.04 A draw sits inside the deadband, so time-to-empty stays blank.
    expect(hoursToEmpty(battery({ current: -0.04 }), -0.04)).toBeNull()
    expect(hoursToFull(battery({ current: 0.04 }), 0.04)).toBeNull()
  })
})

/**
 * The window the projection is taken over widens from empty toward five minutes, and the gate is
 * what decides how much of that widening the owner has to wait through before any figure appears.
 */
describe('the window a projection is willing to answer over', () => {
  /** `count` samples at `stepMs`, so the span is one step short of the sample count times the step. */
  function stream(count: number, stepMs: number, current = -8.4): Reach {
    const samples = Array.from({ length: count }, (_unused, index) => ({
      at: index * stepMs,
      value: current,
    }))
    return reachOf(samples)!
  }

  /** A stream whose current moves, so the window's mean and its last sample can disagree. */
  function varying(stepMs: number, currents: readonly number[]): Reach {
    return reachOf(currents.map((value, index) => ({ at: index * stepMs, value })))!
  }

  it('answers once the window spans fifteen seconds with eight samples', () => {
    const projection = project(battery({ remainingCapacity: 300 }), stream(8, 2_200), false)

    expect(projection).toEqual({
      kind: 'toEmpty',
      hours: expect.closeTo(300 / 8.4, 6),
      overMs: 15_400,
      settled: false,
    })
  })

  it('withholds a figure until both bounds are met', () => {
    // Seven samples across twenty seconds clears the span and not the count.
    expect(project(battery(), stream(7, 3_400), false)).toEqual({ kind: 'collecting' })
    // Thirty samples inside ten seconds clears the count and not the span.
    expect(project(battery(), stream(30, 345), false)).toEqual({ kind: 'collecting' })
  })

  it('marks a twenty-second window unsettled and a minute-long one settled', () => {
    expect(project(battery(), stream(21, 1_000), false)).toMatchObject({ settled: false })
    expect(project(battery(), stream(62, 1_000), false)).toMatchObject({ settled: true })
  })

  it('holds inside the deadband over a short window, and says how short', () => {
    expect(project(battery({ current: -0.1 }), stream(20, 1_000, -0.1), false)).toEqual({
      kind: 'holding',
      overMs: 19_000,
      settled: false,
    })
  })

  it('holds a rate parked between the two edges only for a pack that was already holding', () => {
    // 0.2 A clears the 0.15 A entry edge and sits under the 0.25 A exit edge, which is the whole
    // width of the deadband: the same window answers differently depending on the last verdict,
    // and that is what stops a boundary rate flipping between a runtime and 'holding' every second.
    const boundary = stream(20, 1_000, -0.2)

    expect(project(battery(), boundary, true)).toMatchObject({ kind: 'holding' })
    expect(project(battery(), boundary, false)).toMatchObject({ kind: 'toEmpty' })
  })

  it('names a charging window to full, over the deficit rather than over the charge', () => {
    expect(project(battery({ remainingCapacity: 300 }), stream(20, 1_000, 5), false)).toEqual({
      kind: 'toFull',
      hours: expect.closeTo((315 - 300) / 5, 6),
      overMs: 19_000,
      settled: false,
    })
  })

  it('answers from the window mean, not from whichever sample happened to arrive last', () => {
    // A galley load cycling ±6 A around a small negative bias. The newest sample is charging at
    // +6 A while the pack is really losing 0.3 A, so an implementation reading the latest sample
    // would print a time to FULL on a bank that is emptying.
    const cycling = varying(
      1_000,
      Array.from({ length: 20 }, (_unused, index) => (index % 2 === 0 ? -6.6 : 6)),
    )

    expect(cycling.latest).toBe(6)
    expect(cycling.net).toBeCloseTo(-0.3, 6)
    expect(project(battery({ remainingCapacity: 300 }), cycling, false)).toMatchObject({
      kind: 'toEmpty',
      hours: expect.closeTo(300 / 0.3, 6),
    })
  })

  it('walks toward the settled figure as the window widens under it', () => {
    // Twenty seconds of a 20 A draw that then falls away to 6 A. The short window sees only the
    // draw and names fifteen hours; the minute-long one has integrated the fall and names double
    // that. This is what the unsettled tilde is warning about, and why it is dropped at a minute.
    const currents = Array.from({ length: 90 }, (_unused, index) => (index < 20 ? -20 : -6))
    const pack = battery({ remainingCapacity: 300 })

    const early = project(pack, varying(1_000, currents.slice(0, 20)), false)
    const late = project(pack, varying(1_000, currents), false)

    expect(early).toMatchObject({ kind: 'toEmpty', settled: false })
    expect(late).toMatchObject({ kind: 'toEmpty', settled: true })
    // 300 Ah at a flat 20 A, against 300 Ah at the 89-second window's own mean of 9.07 A.
    expect((early as { hours: number }).hours).toBeCloseTo(15, 6)
    expect((late as { hours: number }).hours).toBeCloseTo((300 * 89) / 807, 6)
  })
})
