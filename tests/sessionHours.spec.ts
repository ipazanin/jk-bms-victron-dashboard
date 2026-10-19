import { describe, expect, it } from 'vitest'

import { MAX_PAIRING_AGE_MS, MAX_SAMPLE_GAP_MS, pairSamples } from '../src/domain/history/join'
import type { PairedSample } from '../src/domain/history/join'
import { EMPTY_LEDGER, foldAccount, mergeLedgers } from '../src/domain/history/ledger'
import { MAX_SESSION_HOUR_MOMENTS, SESSION_HOUR_MS } from '../src/domain/history/SessionHour'
import type { SessionHour } from '../src/domain/history/SessionHour'
import { SessionHourAccumulator } from '../src/domain/history/SessionHourAccumulator'
import { SESSION_HOUR_METRICS } from '../src/domain/history/SessionHourMetric'
import { summarizeSessionHours } from '../src/domain/history/summarizeSessionHours'
import type { PackSample, SessionLedger, SolarSample } from '../src/domain/history/types'
import { packSample, solarSample } from './support/samples'

const HOUR = Math.floor(Date.UTC(2026, 9, 25, 1) / SESSION_HOUR_MS) * SESSION_HOUR_MS

function paired(at: number, pack: Partial<PackSample> | null = {}, solar: Partial<SolarSample> | null = {}): PairedSample {
  return {
    at,
    pack: pack === null ? null : packSample({ at, currentA: -4, packVoltageV: 12, ...pack }),
    solar: solar === null ? null : solarSample({ at, batteryCurrentA: 3, ...solar }),
  }
}

function record(samples: readonly PairedSample[]): readonly SessionHour[] {
  const accumulator = new SessionHourAccumulator('session', 'recorded')
  for (const sample of samples) accumulator.push(sample)
  return accumulator.updatedHours()
}

function expectLedgerClose(actual: SessionLedger, expected: SessionLedger): void {
  for (const field of Object.keys(expected) as (keyof SessionLedger)[]) {
    if (expected[field] === null) expect(actual[field], field).toBeNull()
    else expect(actual[field], field).toBeCloseTo(expected[field], 10)
  }
}

describe('hourly session accounting', () => {
  it('preserves the live ledger while dividing a ramp across a UTC hour boundary', () => {
    const samples = [
      paired(HOUR - 3_000, { currentA: -8, packVoltageV: 14, stateOfCharge: 50 }),
      paired(HOUR + 1_000, { currentA: 0, packVoltageV: 12, stateOfCharge: 49 }),
    ]
    const hours = record(samples)
    const expected = foldAccount(samples).ledger
    expect(hours.map((hour) => hour.hourStart)).toEqual([HOUR - SESSION_HOUR_MS, HOUR])
    expect(hours[0].from).toBe(HOUR - 3_000)
    expect(hours[0].to).toBe(HOUR)
    expect(hours[1].from).toBe(HOUR)
    expect(hours[1].to).toBe(HOUR + 1_000)
    expect(hours[0].ledger.countedMs).toBe(3_000)
    expect(hours[1].ledger.countedMs).toBe(1_000)
    expect(hours[0].ledger.houseWh).toBeCloseTo(expected.houseWh * 0.75, 12)
    expectLedgerClose(hours.reduce((sum, hour) => mergeLedgers(sum, hour.ledger), EMPTY_LEDGER), expected)
    expect(hours[0].currentIntegrals.packCurrentA).toEqual({ integral: -15_000, observedMs: 3_000 })
    expect(hours[1].currentIntegrals.packCurrentA).toEqual({ integral: -1_000, observedMs: 1_000 })
    expect(hours[0].moments.every((moment) => moment.sample.at !== HOUR)).toBe(true)
  })

  it('does not reclassify foreign charge when the current crosses zero inside a boundary interval', () => {
    const samples = [
      paired(HOUR - 2_000, { currentA: -2 }, { batteryCurrentA: 0 }),
      paired(HOUR + 2_000, { currentA: 6 }, { batteryCurrentA: 0 }),
    ]
    const hours = record(samples)
    for (const hour of hours) {
      expect(hour.ledger.foreignMs).toBe(2_000)
      expect(hour.ledger.foreignAhFloor).toBeGreaterThan(0)
      expect(hour.ledger.countedMs).toBe(0)
      expect(hour.coverageMs.foreign).toBe(2_000)
    }
    expectLedgerClose(mergeLedgers(hours[0].ledger, hours[1].ledger), foldAccount(samples).ledger)
  })

  it('counts a sample on the boundary once and integrates no span twice', () => {
    const samples = [paired(HOUR - 1_000), paired(HOUR), paired(HOUR + 1_000)]
    const hours = record(samples)
    expect(hours.map((hour) => hour.packSamples)).toEqual([1, 2])
    expect(hours.map((hour) => hour.solarSamples)).toEqual([1, 2])
    expect(hours.map((hour) => hour.currentIntegrals.packCurrentA.observedMs)).toEqual([1_000, 1_000])
    expectLedgerClose(mergeLedgers(hours[0].ledger, hours[1].ledger), foldAccount(samples).ledger)
  })

  it('keeps long silences unknown and does not create rows for entirely missing hours', () => {
    const samples = [paired(HOUR + 1_000), paired(HOUR + 1_001 + MAX_SAMPLE_GAP_MS)]
    const [hour] = record(samples)
    expect(hour.ledger.countedMs).toBe(0)
    expect(hour.currentIntegrals.packCurrentA.observedMs).toBe(0)
    expect(hour.coverageMs.none).toBe(MAX_SAMPLE_GAP_MS + 1)

    const disconnected = record([paired(HOUR + 1_000), paired(HOUR + 3 * SESSION_HOUR_MS + 1_000)])
    expect(disconnected).toHaveLength(2)
    expect(disconnected.every((summary) => summary.ledger.packAhWholeSession === 0)).toBe(true)
  })

  it('retains solar-only current while unavailable current stays null rather than zero', () => {
    const [solarOnly] = record([paired(HOUR, null), paired(HOUR + 1_000, null)])
    expect(solarOnly.coverageMs['solar-only']).toBe(1_000)
    expect(solarOnly.currentIntegrals.solarCurrentA).toEqual({ integral: 3_000, observedMs: 1_000 })
    expect(solarOnly.metrics.packCurrentA.minimum).toBeNull()
    expect(solarOnly.metrics.houseCurrentA.minimum).toBeNull()
    expect(solarOnly.currentIntegrals.houseCurrentA.observedMs).toBe(0)

    const [missingCurrent] = record([
      paired(HOUR, {}, { batteryCurrentA: null, pvPowerW: null }),
      paired(HOUR + 1_000, {}, { batteryCurrentA: null, pvPowerW: null }),
    ])
    expect(missingCurrent.coverageMs['pack-only']).toBe(1_000)
    expect(missingCurrent.metrics.solarCurrentA.minimum).toBeNull()
    expect(missingCurrent.metrics.pvPowerW.observations).toBe(0)
    expect(missingCurrent.currentIntegrals.solarCurrentA).toEqual({ integral: 0, observedMs: 0 })
  })

  it('preserves arrival-order accounting for two radios reporting in the same millisecond', () => {
    const first = paired(HOUR)
    const nextPack = packSample({ at: HOUR + 1_000, currentA: -8 })
    const nextSolar = solarSample({ at: HOUR + 1_000, batteryCurrentA: 12 })
    const samples = [
      first,
      { at: HOUR + 1_000, pack: nextPack, solar: first.solar },
      { at: HOUR + 1_000, pack: nextPack, solar: nextSolar },
    ]
    const [hour] = record(samples)
    expectLedgerClose(hour.ledger, foldAccount(samples).ledger)
    expect(hour.ledger.countedMs).toBe(1_000)
    expect(hour.packSamples).toBe(2)
    expect(hour.solarSamples).toBe(2)
    expect(hour.moments.some((moment) => moment.sample.solar?.at === HOUR && moment.sample.at === HOUR + 1_000)).toBe(true)
    const reconstructed = summarizeSessionHours('session', [first.pack!, nextPack], [first.solar!, nextSolar])
    expect(reconstructed[0].basis).toBe('reconstructed')
    expect(reconstructed[0].ledger.solarAh).not.toBe(hour.ledger.solarAh)
  })

  it('retains every required extremum in at most 22 original observations', () => {
    const samples = Array.from({ length: 1_000 }, (_, index) => paired(HOUR + index * 1_000,
      {
        currentA: Math.sin(index) * 100,
        packVoltageV: 12 + Math.cos(index * 0.7),
        stateOfCharge: index % 101,
        cellDeltaV: (index % 37) / 1_000,
        mosfetTemperatureC: 20 + (index % 53),
      },
      { batteryCurrentA: 20 + Math.cos(index * 0.3) * 20, pvPowerW: index % 311 },
    ))
    const [hour] = record(samples)
    expect(hour.moments.length).toBeLessThanOrEqual(MAX_SESSION_HOUR_MOMENTS)
    for (const metric of SESSION_HOUR_METRICS) {
      const minimum = hour.moments.find((moment) => moment.reasons.includes(`${metric}-minimum`))
      const maximum = hour.moments.find((moment) => moment.reasons.includes(`${metric}-maximum`))
      expect(minimum?.sample.at).toBe(hour.metrics[metric].minimumAt)
      expect(maximum?.sample.at).toBe(hour.metrics[metric].maximumAt)
    }
    for (const moment of hour.moments) expect(samples).toContainEqual(moment.sample)
    expect(hour.moments.find((moment) => moment.reasons.includes('first-pack'))?.sample.at).toBe(HOUR)
    expect(hour.moments.find((moment) => moment.reasons.includes('last-solar'))?.sample.at).toBe(HOUR + 999_000)
  })

  it('keeps the earliest tied extremum and does not combine independent stream extrema', () => {
    const [hour] = record([
      paired(HOUR, { currentA: 0 }, { batteryCurrentA: 10 }),
      paired(HOUR + 1_000, { currentA: 20 }, { batteryCurrentA: 30 }),
      paired(HOUR + 2_000, { currentA: 0 }, { batteryCurrentA: 10 }),
    ])
    expect(hour.metrics.packCurrentA.minimumAt).toBe(HOUR)
    expect(hour.metrics.houseCurrentA.minimum).toBe(10)
    expect(hour.metrics.houseCurrentA.maximum).toBe(10)
  })

  it('retains newer updates when an older checkpoint is acknowledged', () => {
    const accumulator = new SessionHourAccumulator('session', 'recorded')
    accumulator.push(paired(HOUR))
    const firstCheckpoint = accumulator.updatedHours()
    accumulator.push(paired(HOUR + 1_000))
    accumulator.acknowledge(firstCheckpoint)
    const secondCheckpoint = accumulator.updatedHours()
    expect(secondCheckpoint).toHaveLength(1)
    expect(secondCheckpoint[0].packSamples).toBe(2)
    expect(firstCheckpoint[0].packSamples).toBe(1)
    expect(firstCheckpoint[0].metrics.packCurrentA.observations).toBe(1)
    accumulator.acknowledge(secondCheckpoint)
    expect(accumulator.updatedHours()).toEqual([])
  })

  it('reconstructs only the available rows under the existing pairing age', () => {
    const pack = [packSample({ at: HOUR + 10_000 }), packSample({ at: HOUR + 11_000 })]
    const solar = [solarSample({ at: HOUR + 1_000 })]
    const hours = summarizeSessionHours('session', pack, solar)
    expect(hours[0].from).toBe(HOUR + 1_000)
    expect(hours[0].basis).toBe('reconstructed')
    expect(hours[0].ledger.countedMs).toBe(0)
    expectLedgerClose(hours[0].ledger, foldAccount(pairSamples(pack, solar, MAX_PAIRING_AGE_MS)).ledger)
  })

  it('preserves repeated intervals after a recording clock rollback and marks their hour', () => {
    const samples = [1_000, 2_000, 1_000, 2_000].map((offset) => paired(HOUR + offset))
    const [hour] = record(samples)
    expect(hour.clockAdjusted).toBe(true)
    expect(hour.to - hour.from).toBe(1_000)
    expect(hour.ledger.countedMs).toBe(2_000)
    expect(hour.currentIntegrals.packCurrentA.observedMs).toBe(2_000)
    expectLedgerClose(hour.ledger, foldAccount(samples).ledger)
  })

  it('marks existing and newly revisited hours until a multi-hour rollback catches up', () => {
    const accumulator = new SessionHourAccumulator('session', 'recorded')
    for (const offset of [1_000, SESSION_HOUR_MS + 1_000, 3 * SESSION_HOUR_MS + 1_000]) {
      accumulator.push(paired(HOUR + offset))
    }
    accumulator.acknowledge(accumulator.updatedHours())
    accumulator.push(paired(HOUR + 2_000))
    accumulator.push(paired(HOUR + 2 * SESSION_HOUR_MS + 2_000))
    const revisited = accumulator.updatedHours()
    expect(revisited).toHaveLength(4)
    expect(revisited.every((hour) => hour.clockAdjusted)).toBe(true)
    accumulator.acknowledge(revisited)
    accumulator.push(paired(HOUR + 4 * SESSION_HOUR_MS + 2_000))
    const later = accumulator.updatedHours().find((hour) => hour.hourStart === HOUR + 4 * SESSION_HOUR_MS)
    expect(later?.clockAdjusted).toBeUndefined()
  })

  it('retains more than an hour of accounting when the clock repeats almost a whole hour', () => {
    const firstPass = Array.from({ length: 450 }, (_, index) => paired(HOUR + index * 8_000))
    const samples = [...firstPass, ...firstPass]
    const [hour] = record(samples)
    expect(hour.clockAdjusted).toBe(true)
    expect(hour.coverageMs.both).toBeGreaterThan(SESSION_HOUR_MS)
    expect(hour.currentIntegrals.packCurrentA.observedMs).toBeGreaterThan(SESSION_HOUR_MS)
    expectLedgerClose(hour.ledger, foldAccount(samples).ledger)
  })

  it('orders copied streams before reconstructing chunks written across a clock rollback', () => {
    const pack = [packSample({ at: HOUR + 1_000 }), packSample({ at: HOUR })]
    const solar = [solarSample({ at: HOUR + 1_000 }), solarSample({ at: HOUR })]
    const [hour] = summarizeSessionHours('session', pack, solar)
    expect(hour.ledger.countedMs).toBe(1_000)
    expect(hour.basis).toBe('reconstructed')
    expect(pack[0].at).toBe(HOUR + 1_000)
    expect(solar[0].at).toBe(HOUR + 1_000)
  })
})
