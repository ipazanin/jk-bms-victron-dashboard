import { describe, expect, it } from 'vitest'

import { CELL_DEVIATION_LADDER, CURRENT_LADDER, nextStop } from '../src/domain/scaleLadder'

describe('nextStop', () => {
  it('grows on the first reading past the stop in force', () => {
    expect(nextStop(CURRENT_LADDER, 10, 9.2)).toBe(20)
  })

  it('holds through a dip that is still comfortably inside the stop in force', () => {
    // 5 A × 1.15 = 5.75, which is 57% of 10 — above the 45% release fraction.
    expect(nextStop(CURRENT_LADDER, 10, 5)).toBe(10)
  })

  it('releases once the reading falls well inside a smaller stop', () => {
    // 3.5 A × 1.15 = 4.03, which is 40% of 10 — below the release fraction.
    expect(nextStop(CURRENT_LADDER, 10, 3.5)).toBe(5)
  })

  it('never returns a stop the reading would overflow', () => {
    for (const reach of [0, 1, 4.4, 5, 12, 39, 100, 250]) {
      const stop = nextStop(CURRENT_LADDER, 5, reach)
      expect(stop).toBeGreaterThanOrEqual(reach * CURRENT_LADDER.headroom)
    }
  })

  it('pins at the top stop rather than growing past the ladder', () => {
    expect(nextStop(CURRENT_LADDER, 320, 5000)).toBe(320)
  })

  it('holds the ammeter axis steady across the observed swing', () => {
    // The boat cycles between roughly 4.4 and 5.0 A of reach. The axis must not breathe.
    let inForce = 10
    for (const reach of [4.4, 5.0, 4.9, 4.3, 4.7, 5.0, 4.1, 4.8]) {
      inForce = nextStop(CURRENT_LADDER, inForce, reach)
      expect(inForce).toBe(10)
    }
  })

  it('steps the cell ladder once and then latches, where the instant would oscillate', () => {
    // Driven by the instant, a 13/7 mV cycle lands either side of the 20 mV release boundary
    // (20 × 0.4 = 8.0 against a wanted 8.4) and flips the scale every other sample. Driven by
    // the window's reach, the reach stays 13 and the ladder holds.
    const cycle = [7, 13, 9, 13, 8, 13, 7, 13]

    let byInstant = 10
    const instantStops = cycle.map((value) => (byInstant = nextStop(CELL_DEVIATION_LADDER, byInstant, value)))
    expect(new Set(instantStops).size).toBeGreaterThan(1)

    let byReach = 10
    const reachStops = cycle.map((_, index) => {
      const reach = Math.max(...cycle.slice(0, index + 1))
      return (byReach = nextStop(CELL_DEVIATION_LADDER, byReach, reach))
    })
    expect(new Set(reachStops.slice(1))).toEqual(new Set([20]))
  })
})
