import { describe, expect, it } from 'vitest'

import { deriveHouse } from '../src/domain/dcBus'
import {
  MAX_PAIRING_AGE_MS,
  MAX_SAMPLE_GAP_MS,
  deriveTracks,
  pairSamples,
  solarCurrentOf,
} from '../src/domain/history/join'
import type { PackSample, SolarSample } from '../src/domain/history/types'
import { SAMPLE_EPOCH, packSample, packSamples, solarSample, solarSamples } from './support/samples'

// The two radios are stored apart because they are independent instruments on independent clocks.
// Everything here is about the moment they are put back together: what a reading is allowed to
// speak for, and what has to stay a hole.

function packAt(offsets: readonly number[], overrides: Partial<PackSample> = {}): PackSample[] {
  return offsets.map((offset) => packSample({ at: SAMPLE_EPOCH + offset, ...overrides }))
}

function solarAt(offsets: readonly number[], overrides: Partial<SolarSample> = {}): SolarSample[] {
  return offsets.map((offset) => solarSample({ at: SAMPLE_EPOCH + offset, ...overrides }))
}

describe('pairing the two streams', () => {
  it('gives a reading of the same instant to the row that instant produced', () => {
    const rows = pairSamples(packAt([0]), solarAt([0]), MAX_PAIRING_AGE_MS)

    expect(rows).toHaveLength(1)
    expect(rows[0].pack).not.toBeNull()
    expect(rows[0].solar).not.toBeNull()
  })

  it('lets a reading stand in for a neighbouring instant while it is inside the bound', () => {
    const rows = pairSamples(packAt([MAX_PAIRING_AGE_MS]), solarAt([0]), MAX_PAIRING_AGE_MS)

    expect(rows.map((row) => row.at)).toEqual([SAMPLE_EPOCH, SAMPLE_EPOCH + MAX_PAIRING_AGE_MS])
    expect(rows[1].solar).not.toBeNull()
  })

  it('refuses a solar row older than the bound rather than carrying it forward', () => {
    // Past the bound the half is null and null is drawn as a hole. A value held here would become
    // integrated charge in the ledger, which is why this bound is far tighter than the scanner's
    // own fifteen-second demotion.
    const rows = pairSamples(packAt([MAX_PAIRING_AGE_MS + 1]), solarAt([0]), MAX_PAIRING_AGE_MS)

    expect(rows[1].pack).not.toBeNull()
    expect(rows[1].solar).toBeNull()
  })

  it('never infers a pack reading the BMS did not send', () => {
    const rows = pairSamples([], solarAt([0, 1_000]), MAX_PAIRING_AGE_MS)

    expect(rows.every((row) => row.pack === null)).toBe(true)
    expect(rows.every((row) => row.solar !== null)).toBe(true)
  })

  it('collapses two rows stamped in the same millisecond to the last of them', () => {
    // A re-checkpointed tail produces exactly this, and two rows at one instant are one instant.
    const rows = pairSamples(
      [packSample({ at: SAMPLE_EPOCH, currentA: -1 }), packSample({ at: SAMPLE_EPOCH, currentA: -2 })],
      [],
      MAX_PAIRING_AGE_MS,
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].pack?.currentA).toBe(-2)
  })

  it('reads the amps the controller delivered, and nothing when it reported none', () => {
    const [withCurrent] = pairSamples([], solarAt([0], { batteryCurrentA: 7.9 }), MAX_PAIRING_AGE_MS)
    const [without] = pairSamples([], solarAt([0], { batteryCurrentA: null }), MAX_PAIRING_AGE_MS)

    expect(solarCurrentOf(withCurrent)).toBe(7.9)
    expect(solarCurrentOf(without)).toBeNull()
  })
})

describe('the house load a paired row can support', () => {
  it('is a hole when another source is charging the bank, while pv power stays a real reading', () => {
    // The rule the live instrument has always applied, stated where the archive applies it too.
    // The pack is taking 10 A while the controller delivers 2 A, so something nobody measured is
    // on the bus: house = 2 − 10 = −8 A. The house figure is withheld. The panels' own output is
    // still a measurement and is not withheld with it.
    const [row] = pairSamples(
      packAt([0], { currentA: 10, packVoltageV: 13.6 }),
      solarAt([0], { batteryCurrentA: 2, pvPowerW: 151 }),
      MAX_PAIRING_AGE_MS,
    )

    const solarCurrent = solarCurrentOf(row)!
    const house = deriveHouse(row.pack!.currentA, solarCurrent, row.pack!.packVoltageV)

    expect(house.plausible).toBe(false)
    expect(row.solar?.pvPowerW).toBe(151)
  })

  it('is a real figure when the panels covered the pack', () => {
    const [row] = pairSamples(
      packAt([0], { currentA: -8.4, packVoltageV: 13.6 }),
      solarAt([0], { batteryCurrentA: 7.9 }),
      MAX_PAIRING_AGE_MS,
    )

    const house = deriveHouse(row.pack!.currentA, solarCurrentOf(row)!, row.pack!.packVoltageV)

    expect(house.plausible).toBe(true)
    expect(house.currentA).toBeCloseTo(16.3, 10)
  })

  it('cannot be derived at all where either half is missing', () => {
    const [row] = pairSamples(packAt([0]), [], MAX_PAIRING_AGE_MS)
    expect(solarCurrentOf(row)).toBeNull()
  })
})

describe('thinning a session to a drawable width', () => {
  const window = { from: SAMPLE_EPOCH, to: SAMPLE_EPOCH + 400_000 }

  it('keeps the lowest and the highest sample of every column', () => {
    // At four hundred columns a twelve-hour session puts a hundred-odd samples in each one, and a
    // single-sample spike is the thing most worth not losing. A representative value per column
    // would throw exactly that away.
    const pack = packSamples(400).map((sample, index) =>
      packSample({ ...sample, currentA: index === 137 ? -84.2 : -5 }),
    )
    const tracks = deriveTracks(pairSamples(pack, [], MAX_PAIRING_AGE_MS), window, 400)

    const spike = tracks.pack.columns[137]!
    expect(spike.low).toBe(-84.2)
    expect(spike.high).toBe(-84.2)
    expect(tracks.pack.columns[136]!.low).toBe(-5)
  })

  it('reports a column no sample fell into as nothing, not as zero', () => {
    const tracks = deriveTracks(pairSamples(packSamples(4), [], MAX_PAIRING_AGE_MS), window, 400)

    expect(tracks.pack.columns[0]).not.toBeNull()
    expect(tracks.pack.columns[200]).toBeNull()
  })

  it('takes the house band from per-sample differences and not from the two aggregates', () => {
    // Pack and solar both swing ten amps, in lockstep, so every sample's house load is exactly
    // zero. Differencing the two bands instead would draw a forty-amp ribbon over a boat that
    // never drew anything — and it goes wrong hardest where the load was spikiest.
    const offsets = [0, 1_000, 2_000, 3_000]
    const swing = [-10, 10, -10, 10]
    const pack = offsets.map((offset, index) =>
      packSample({ at: SAMPLE_EPOCH + offset, currentA: swing[index] }),
    )
    const solar = offsets.map((offset, index) =>
      solarSample({ at: SAMPLE_EPOCH + offset, batteryCurrentA: swing[index] }),
    )

    const tracks = deriveTracks(pairSamples(pack, solar, MAX_PAIRING_AGE_MS), window, 1)

    expect(tracks.pack.columns[0]!.low).toBe(-10)
    expect(tracks.pack.columns[0]!.high).toBe(10)
    expect(tracks.house.columns[0]!.low).toBe(0)
    expect(tracks.house.columns[0]!.high).toBe(0)
  })

  it('carries a stretch with no samples through as a gap', () => {
    const pack = [...packAt([0, 1_000, 2_000]), ...packAt([60_000, 61_000])]
    const tracks = deriveTracks(pairSamples(pack, [], MAX_PAIRING_AGE_MS), window, 400)

    expect(tracks.pack.gaps).toContainEqual({ from: SAMPLE_EPOCH + 2_000, to: SAMPLE_EPOCH + 60_000 })
  })

  it('carries the silence at the end of a window rather than trailing off flat', () => {
    // A stream that fell quiet before the window closed says so all the way to the edge, which is
    // what stops a three-minute stall drawing as a confident straight line.
    const tracks = deriveTracks(pairSamples(packAt([0, 1_000]), [], MAX_PAIRING_AGE_MS), window, 400)

    expect(tracks.pack.gaps.at(-1)).toEqual({ from: SAMPLE_EPOCH + 1_000, to: window.to })
  })

  it('never bridges a gap it reported', () => {
    const pack = [...packAt([0]), ...packAt([MAX_SAMPLE_GAP_MS + 1])]
    const tracks = deriveTracks(pairSamples(pack, [], MAX_PAIRING_AGE_MS), window, 400)

    expect(tracks.pack.gaps[0]).toEqual({
      from: SAMPLE_EPOCH,
      to: SAMPLE_EPOCH + MAX_SAMPLE_GAP_MS + 1,
    })
  })

  it('draws a stream that never reported as one gap the width of the window', () => {
    const tracks = deriveTracks(pairSamples(packAt([0, 1_000]), [], MAX_PAIRING_AGE_MS), window, 400)

    expect(tracks.solar.gaps).toEqual([window])
    expect(tracks.solar.columns.every((column) => column === null)).toBe(true)
  })

  it('folds three hundred thousand samples without spreading them into a call', () => {
    // Measured on this engine, 100,000 arguments pass a spread and 125,000 throw RangeError. A
    // browsable session is not bounded by ten minutes, so nothing on this path may reduce by
    // spreading a series.
    const rows = 300_000
    const pack: PackSample[] = []
    for (let index = 0; index < rows; index += 1) {
      pack.push(packSample({ at: SAMPLE_EPOCH + index * 1_000, currentA: index % 7 }))
    }
    const wide = { from: SAMPLE_EPOCH, to: SAMPLE_EPOCH + rows * 1_000 }

    const tracks = deriveTracks(pairSamples(pack, [], MAX_PAIRING_AGE_MS), wide, 400)

    expect(tracks.pack.columns).toHaveLength(400)
    expect(tracks.pack.columns[0]!.high).toBe(6)
  })

  it('has an answer for an empty session and a window with no width', () => {
    const empty = deriveTracks([], window, 400)
    expect(empty.pack.columns.every((column) => column === null)).toBe(true)

    const instant = deriveTracks(
      pairSamples(packAt([0]), solarAt([0]), MAX_PAIRING_AGE_MS),
      { from: SAMPLE_EPOCH, to: SAMPLE_EPOCH },
      400,
    )
    expect(instant.columnMs).toBe(0)
    expect(instant.pack.columns.every((column) => column === null)).toBe(true)
  })

  it('drops a sample outside the window rather than pinning it to an edge column', () => {
    const pack = packAt([-10_000, 0, 1_000])
    const tracks = deriveTracks(pairSamples(pack, [], MAX_PAIRING_AGE_MS), window, 4)

    expect(tracks.pack.columns[0]!.count).toBe(2)
  })
})

describe('the two streams do not have to arrive together', () => {
  it('lays a solar-only stretch beside a both-radio stretch on one timeline', () => {
    const pack = packAt([0, 1_000, 2_000])
    const solar = solarSamples(7, { at: SAMPLE_EPOCH })

    const rows = pairSamples(pack, solar, MAX_PAIRING_AGE_MS)

    expect(rows).toHaveLength(7)
    expect(rows.slice(0, 3).every((row) => row.pack !== null)).toBe(true)
    // The bound is inclusive: at exactly three seconds the last pack row still speaks for the
    // instant, and a second later it does not and the pack half is a hole.
    expect(rows[5].pack).not.toBeNull()
    expect(rows[6].pack).toBeNull()
    expect(rows[6].solar).not.toBeNull()
  })
})
