import { describe, expect, it } from 'vitest'

import {
  JOINT_SERIOUS,
  JOINT_WARNING,
  STEP_EXCLUSION_A,
  deviationsMv,
  gradeBalance,
  theilSen,
} from '../src/domain/cellBalance'
import type { BalanceSample } from '../src/domain/cellBalance'
import timeline from './fixtures/recordedTimeline.json'

/**
 * The load is modelled as DWELLING, not alternating every frame, because that is what the
 * recorded timeline does: its runs of near-constant current are up to eighteen frames long. A
 * pure frame-by-frame square wave would be excluded wholesale by STEP_EXCLUSION_A — every frame
 * straddles a step — and the estimator would correctly refuse to fit anything at all. Testing
 * against that waveform would prove nothing except that the guard works.
 */
function dwellingLoad(frames: number, dwell = 8, low = -4.9, high = 4.3): number[] {
  return Array.from({ length: frames }, (_, index) =>
    Math.floor(index / dwell) % 2 === 0 ? low : high,
  )
}

interface Pack {
  /** Millivolts of load-independent divergence per cell. Should sum to zero. */
  readonly offsetsMv: readonly number[]
  /** Milliohms of path resistance per cell, relative to the pack mean. Should sum to zero. */
  readonly slopesMilliohm: readonly number[]
}

function samplesFor(pack: Pack, currents: readonly number[], skewMv = 0): BalanceSample[] {
  return currents.map((current, index) => {
    const straddlesStep = index > 0 && Math.abs(current - currents[index - 1]) > STEP_EXCLUSION_A
    const deviations = pack.offsetsMv.map((offset, cell) => {
      const modelled = offset + pack.slopesMilliohm[cell] * current
      // Scan skew only appears on frames captured across a step, which is exactly the population
      // the exclusion filter drops. Alternating the sign keeps the artefact off the pack mean.
      return straddlesStep ? modelled + (cell % 2 === 0 ? skewMv : -skewMv) : modelled
    })
    return {
      at: index * 1000,
      current,
      deviationsMv: deviations,
      cellDelta: (Math.max(...deviations) - Math.min(...deviations)) / 1000,
    }
  })
}

/** The owner's bank: cell 1 reads −7 mV at rest and sags to −13 mV at −4.9 A. */
const OWNERS_PACK: Pack = {
  offsetsMv: [-7.0, 2.333, 2.333, 2.334],
  slopesMilliohm: [1.2, -0.4, -0.4, -0.4],
}

describe('deviationsMv', () => {
  it('returns deviations from the pack mean in millivolts', () => {
    expect(deviationsMv([3.4, 3.4, 3.4, 3.4])).toEqual([0, 0, 0, 0])
    const spread = deviationsMv([3.395, 3.405, 3.4, 3.4])
    expect(spread[0]).toBeCloseTo(-5, 6)
    expect(spread[1]).toBeCloseTo(5, 6)
  })

  it('has no opinion about an empty pack', () => {
    expect(deviationsMv([])).toEqual([])
  })
})

describe('theilSen', () => {
  it('recovers a planted slope and intercept', () => {
    const points = [-6, -4, -2, 0, 2, 4, 6].map(
      (current) => [current, 3 + 1.5 * current] as const,
    )
    const fit = theilSen(points)
    expect(fit).not.toBeNull()
    expect(fit!.offsetMv).toBeCloseTo(3, 6)
    expect(fit!.resistance).toBeCloseTo(0.0015, 9)
  })

  it('refuses a window whose points are too close together to give leverage', () => {
    // Every pair is under MIN_PAIR_SEPARATION_A apart, so no slope is identifiable.
    const points = [0, 0.5, 1.0, 1.5].map((current) => [current, current] as const)
    expect(theilSen(points)).toBeNull()
  })

  it('survives an outlier that would drag a least-squares fit', () => {
    const clean = [-6, -4, -2, 2, 4, 6].map((current) => [current, 1 + 0.5 * current] as const)
    const contaminated = [...clean, [0, 400] as const]
    const fit = theilSen(contaminated)
    expect(fit!.resistance).toBeCloseTo(0.0005, 9)
  })
})

describe('gradeBalance separates divergence from path resistance', () => {
  it("reports the owner's pack as balanced, with the sag attributed to the joint", () => {
    const verdict = gradeBalance(samplesFor(OWNERS_PACK, dwellingLoad(120), 6), null)

    expect(verdict.kind).toBe('fitted')
    if (verdict.kind !== 'fitted') return
    // Planted divergence is 2.334 − (−7.0) = 9.334 mV, under the 10 mV trigger: silent.
    expect(verdict.balanceSpreadMv).toBeCloseTo(9.334, 1)
    // Planted joint spread is 1.2 − (−0.4) = 1.6 mΩ, under JOINT_WARNING: silent.
    expect(verdict.jointSpread).toBeCloseTo(0.0016, 4)
    expect(verdict.jointSpread).toBeLessThan(JOINT_WARNING)
    expect(verdict.worstJointCell).toBe(1)
  })

  it('still fires on a genuine divergence under the identical cycling load', () => {
    const diverged: Pack = {
      offsetsMv: [-12, 4, 4, 4],
      slopesMilliohm: OWNERS_PACK.slopesMilliohm,
    }
    const verdict = gradeBalance(samplesFor(diverged, dwellingLoad(120), 6), null)

    expect(verdict.kind).toBe('fitted')
    if (verdict.kind !== 'fitted') return
    expect(verdict.balanceSpreadMv).toBeCloseTo(16, 1)
    expect(verdict.balanceSpreadMv).toBeGreaterThan(10)
    expect(verdict.lowestOffsetCell).toBe(1)
  })

  it('catches a loosening terminal, which is only visible under load', () => {
    const looseJoint: Pack = {
      offsetsMv: [0, 0, 0, 0],
      slopesMilliohm: [-2, -2, 6, -2],
    }
    const verdict = gradeBalance(samplesFor(looseJoint, dwellingLoad(120)), null)

    expect(verdict.kind).toBe('fitted')
    if (verdict.kind !== 'fitted') return
    expect(verdict.balanceSpreadMv).toBeCloseTo(0, 1)
    expect(verdict.jointSpread).toBeCloseTo(0.008, 4)
    expect(verdict.jointSpread).toBeGreaterThan(JOINT_SERIOUS)
    expect(verdict.worstJointCell).toBe(3)
  })

  it('degrades to the raw comparison under a dead-steady load, never to silence', () => {
    const steady = Array.from({ length: 60 }, () => -4.9)
    const samples = samplesFor(OWNERS_PACK, steady)
    const verdict = gradeBalance(samples, null)

    expect(verdict.kind).toBe('uncorrected')
    if (verdict.kind !== 'uncorrected') return
    expect(verdict.rawSpreadMv).toBeCloseTo(samples[samples.length - 1].cellDelta * 1000, 6)
    expect(verdict.current).toBe(-4.9)
  })

  it('uses held slopes to stay corrected when the present window cannot identify one', () => {
    const steady = Array.from({ length: 60 }, () => -4.9)
    const held = OWNERS_PACK.slopesMilliohm.map((milliohm) => milliohm / 1000)
    const verdict = gradeBalance(samplesFor(OWNERS_PACK, steady), held)

    expect(verdict.kind).toBe('fitted')
    if (verdict.kind !== 'fitted') return
    expect(verdict.balanceSpreadMv).toBeCloseTo(9.334, 1)
  })

  it('has no verdict at all for an empty window', () => {
    expect(gradeBalance([], null).kind).toBe('uncorrected')
  })
})

describe('gradeBalance against the recorded timeline', () => {
  const samples: BalanceSample[] = timeline.samples.map((sample, index) => ({
    at: index * timeline.intervalSeconds * 1000,
    current: sample.battery.current,
    deviationsMv: deviationsMv(sample.battery.cellVoltages),
    cellDelta:
      Math.max(...sample.battery.cellVoltages) - Math.min(...sample.battery.cellVoltages),
  }))

  it('reports a real, quiet verdict on a recording where a rest gate would report nothing', () => {
    // Not one of the ninety frames sits within ±2 A of rest, so a gate that only assesses at rest
    // would withhold a verdict for the entire recording.
    expect(samples.every((sample) => Math.abs(sample.current) > 2)).toBe(true)

    const verdict = gradeBalance(samples, null)
    expect(verdict.kind).toBe('fitted')
    if (verdict.kind !== 'fitted') return
    expect(verdict.balanceSpreadMv).toBeLessThan(2)
    expect(verdict.jointSpread).toBeLessThan(JOINT_WARNING)
    expect(verdict.pairs).toBeGreaterThan(100)
  })

  it('excludes the one frame whose spread is an artefact of a current step', () => {
    const worst = samples.reduce((best, sample) => (sample.cellDelta > best.cellDelta ? sample : best))
    const worstIndex = samples.indexOf(worst)
    expect(worst.cellDelta * 1000).toBeCloseTo(13, 0)
    expect(Math.abs(worst.current - samples[worstIndex - 1].current)).toBeGreaterThan(STEP_EXCLUSION_A)
  })
})
