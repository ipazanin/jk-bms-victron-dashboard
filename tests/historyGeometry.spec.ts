import { describe, expect, it } from 'vitest'

import {
  bandPath,
  barFromZero,
  centredAxis,
  clampedPositionOn,
  clockBandFor,
  coverageSegments,
  extentOf,
  ledgerGeometry,
  linearScale,
  maxMagnitudeOf,
  niceStep,
  positionOn,
  signedAxis,
  spanBetween,
  tracePath,
} from '../src/domain/history/geometry'
import type { TracePoint } from '../src/domain/history/geometry'
import { EMPTY_LEDGER } from '../src/domain/history/ledger'
import type { CoverageRun, SessionLedger } from '../src/domain/history/types'

// Two rules separate the archive's marks from the live ones and both are asserted here: a stored
// session's axis is a pure function of that session's own reach, and nothing on this path reduces
// a series by spreading it into a call.

const LEFT = 0
const RIGHT = 1_000

function ledger(overrides: Partial<SessionLedger>): SessionLedger {
  return { ...EMPTY_LEDGER, ...overrides }
}

describe('reading the extent of a series', () => {
  it('has nothing to report when nothing finite arrived', () => {
    // An absent series is not a series of zeroes, and an axis built as though it were would draw
    // a bar at full scale over no data.
    expect(extentOf([])).toBeNull()
    expect(extentOf([null, null])).toBeNull()
    expect(extentOf([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull()
  })

  it('skips the holes and reports what is there', () => {
    expect(extentOf([3, null, -1, 7, Number.NaN])).toEqual({ min: -1, max: 7 })
  })

  it('reads deflection as distance from zero', () => {
    expect(maxMagnitudeOf([3, -12, null, 7])).toBe(12)
    expect(maxMagnitudeOf([])).toBe(0)
  })

  it('handles three hundred thousand values without spreading them into a call', () => {
    // 100,000 arguments pass a spread on this engine and 125,000 throw RangeError. A browsable
    // session is not bounded by ten minutes, so no reduction here may take that shape.
    const values: number[] = []
    for (let index = 0; index < 300_000; index += 1) values.push(index % 97)

    expect(extentOf(values)).toEqual({ min: 0, max: 96 })
    expect(maxMagnitudeOf(values)).toBe(96)
  })
})

describe('choosing an interval', () => {
  it('rounds up to the next round number at any magnitude', () => {
    expect(niceStep(18.92)).toBe(20)
    expect(niceStep(0.03)).toBe(0.05)
    expect(niceStep(1)).toBe(1)
    expect(niceStep(6)).toBe(10)
    expect(niceStep(2_400)).toBe(5_000)
  })

  it('does not climb a stop for floating-point dust', () => {
    // 0.1 + 0.2 lands a hair above 0.3, and an axis that answered 0.5 to that would relabel its
    // whole ladder for a rounding error.
    expect(niceStep(0.1 + 0.2)).toBe(0.5)
    expect(niceStep(2 - 1.9999999999)).toBeGreaterThan(0)
  })

  it('answers something usable for a degenerate ask', () => {
    expect(niceStep(0)).toBe(1)
    expect(niceStep(Number.NaN)).toBe(1)
  })
})

describe('the ledger axis', () => {
  it('spends no width on a half no mark can reach', () => {
    // ∫solar cannot go negative, so a symmetric ±D domain would draw every sunny day at half
    // scale. The domain is the signed extent actually present.
    const axis = signedAxis(extentOf([23.1, 94.6, 0]))

    expect(axis.low).toBe(0)
    expect(axis.high).toBe(100)
    expect(axis.ticks[0]).toBe(0)
  })

  it('always puts zero on a tick, so a bar can be read against the scale', () => {
    expect(signedAxis(extentOf([-38.2, 0.1])).ticks).toContain(0)
    expect(signedAxis(extentOf([23.1, 94.6])).ticks).toContain(0)
  })

  it('ends on a tick, so full deflection reads as full and not as clipped', () => {
    const axis = signedAxis(extentOf([-30, 0]))

    expect(axis.low).toBe(-30)
    expect(axis.high).toBe(0)
    expect(axis.ticks).toEqual([-30, -20, -10, 0])
  })

  it('draws a round ladder rather than a floating-point one', () => {
    // Steps accumulate dust: an axis in tenths must not label a tick 0.30000000000000004.
    expect(signedAxis(extentOf([0, 0.4])).ticks.every((tick) => `${tick}`.length <= 4)).toBe(true)
  })

  it('has an axis for a session that recorded nothing', () => {
    const axis = signedAxis(null)

    expect(axis.ticks).toContain(0)
    expect(axis.high).toBeGreaterThan(axis.low)
  })

  it('centres zero when the quantity is read as deflection either side of it', () => {
    const axis = centredAxis(8.4)

    expect(axis.low).toBe(-axis.high)
    expect(axis.ticks).toContain(0)
    expect(axis.high).toBeGreaterThanOrEqual(8.4)
  })
})

describe('the ledger marks', () => {
  const account = ledger({ packAh: 23.1, solarAh: 94.6 })

  it('roots each bar at zero and runs it the way its value points', () => {
    const geometry = ledgerGeometry(ledger({ packAh: -38.2, solarAh: 0.1 }), LEFT, RIGHT)
    const zero = positionOn(geometry.scale, 0)

    expect(geometry.pack.x + geometry.pack.width).toBeCloseTo(zero, 9)
    expect(geometry.solar.x).toBeCloseTo(zero, 9)
  })

  it('draws the house figure as the span between the two tips, not as a bar', () => {
    // 94.6 − 23.1 = 71.5 is literally that distance, which is why the archive's signature is the
    // ammeter integrated and not a new instrument.
    const geometry = ledgerGeometry(account, LEFT, RIGHT)
    const packTip = positionOn(geometry.scale, account.packAh)
    const solarTip = positionOn(geometry.scale, account.solarAh)

    expect(geometry.house.x).toBeCloseTo(Math.min(packTip, solarTip), 9)
    expect(geometry.house.width).toBeCloseTo(Math.abs(solarTip - packTip), 9)
    expect(geometry.houseAh).toBeCloseTo(71.5, 9)
  })

  it('draws the same span when the two tips sit either side of zero', () => {
    const overnight = ledger({ packAh: -39.2, solarAh: 0.1 })
    const geometry = ledgerGeometry(overnight, LEFT, RIGHT)

    expect(geometry.houseAh).toBeCloseTo(39.3, 9)
    expect(geometry.house.width).toBeGreaterThan(0)
    expect(geometry.house.x).toBeLessThan(positionOn(geometry.scale, 0))
  })

  it('draws the unmeasured-in floor only when there was one', () => {
    expect(ledgerGeometry(account, LEFT, RIGHT).unmeasured).toBeNull()
    expect(ledgerGeometry(ledger({ ...account, foreignAhFloor: 18.4 }), LEFT, RIGHT).unmeasured)
      .not.toBeNull()
  })

  it('puts the unmeasured floor on the same axis, so a large unknown cannot draw small', () => {
    const withForeign = ledger({ packAh: 2, solarAh: 3, foreignAhFloor: 80 })
    const geometry = ledgerGeometry(withForeign, LEFT, RIGHT)

    expect(geometry.axis.high).toBeGreaterThanOrEqual(80)
    expect(geometry.unmeasured!.width).toBeGreaterThan(geometry.solar.width)
  })

  it('is a pure function of the session it is handed, with no hysteresis anywhere', () => {
    // The live ammeter grows fast and releases slowly so its axis does not breathe. In a scrubbed
    // session that would make the scale depend on which way you dragged, and the same instant
    // would read against two different scales.
    const small = ledger({ packAh: 1, solarAh: 2 })
    const alone = ledgerGeometry(small, LEFT, RIGHT)

    ledgerGeometry(ledger({ packAh: 400, solarAh: 900 }), LEFT, RIGHT)
    const afterALargeOne = ledgerGeometry(small, LEFT, RIGHT)

    expect(afterALargeOne).toEqual(alone)
  })
})

describe('placing a value on a scale', () => {
  const scale = linearScale(-10, 10, 0, 100)

  it('maps the domain onto the range', () => {
    expect(positionOn(scale, -10)).toBe(0)
    expect(positionOn(scale, 0)).toBe(50)
    expect(positionOn(scale, 10)).toBe(100)
  })

  it('runs backwards without complaint, because an svg y axis grows downwards', () => {
    const descending = linearScale(0, 100, 200, 0)

    expect(positionOn(descending, 0)).toBe(200)
    expect(positionOn(descending, 100)).toBe(0)
  })

  it('pins a reading past the domain to the limit rather than outside the viewBox', () => {
    // Clipped without a trace is the one way a mark can be wrong and look right.
    expect(clampedPositionOn(scale, 40)).toBe(100)
    expect(clampedPositionOn(scale, -40)).toBe(0)
  })

  it('has an answer for a domain with no width', () => {
    expect(positionOn(linearScale(5, 5, 0, 100), 5)).toBe(0)
  })

  it('draws a bar of no width for a value of zero', () => {
    expect(barFromZero(scale, 0)).toEqual({ x: 50, width: 0 })
    expect(spanBetween(scale, 4, 4).width).toBe(0)
  })
})

describe('the ribbon path', () => {
  const time = linearScale(0, 10, 0, 100)
  const value = linearScale(-10, 10, 100, 0)

  it('breaks rather than bridging a gap', () => {
    // A straight line across an interval that passed with no sample asserts a reading nobody took,
    // which is what a three-minute stall currently draws.
    const points: TracePoint[] = [
      { at: 0, value: 0 },
      { at: 1, value: 5 },
      { at: 2, value: null },
      { at: 3, value: -5 },
      { at: 4, value: 0 },
    ]

    const path = tracePath(points, time, value)

    expect(path.match(/M/g)).toHaveLength(2)
    expect(path.startsWith('M')).toBe(true)
  })

  it('draws one run when nothing is missing', () => {
    const path = tracePath([{ at: 0, value: 1 }, { at: 1, value: 2 }], time, value)

    expect(path.match(/M/g)).toHaveLength(1)
    expect(path.match(/L/g)).toHaveLength(1)
  })

  it('draws nothing at all from nothing', () => {
    expect(tracePath([], time, value)).toBe('')
    expect(tracePath([{ at: 0, value: null }], time, value)).toBe('')
  })

  it('closes the filled house region once per contiguous run', () => {
    const path = bandPath(
      [
        { at: 0, lower: -1, upper: 4 },
        { at: 1, lower: -2, upper: 5 },
        { at: 2, lower: null, upper: 5 },
        { at: 3, lower: 0, upper: 3 },
        { at: 4, lower: 0, upper: 2 },
      ],
      time,
      value,
    )

    expect(path.match(/Z/g)).toHaveLength(2)
  })

  it('draws no sliver for a lone sample between two gaps', () => {
    // One vertex encloses no area, and a zero-width sliver would still be stroked.
    const path = bandPath(
      [
        { at: 0, lower: null, upper: null },
        { at: 1, lower: 0, upper: 4 },
        { at: 2, lower: null, upper: null },
      ],
      time,
      value,
    )

    expect(path).toBe('')
  })
})

describe('the coverage tape', () => {
  const window = { from: 0, to: 1_000 }
  const scale = linearScale(0, 1_000, 0, 100)

  it('lays each run where it falls', () => {
    const runs: readonly CoverageRun[] = [
      { from: 0, to: 500, kind: 'both' },
      { from: 500, to: 1_000, kind: 'pack-only' },
    ]

    expect(coverageSegments(runs, window, scale)).toEqual([
      { kind: 'both', x: 0, width: 50 },
      { kind: 'pack-only', x: 50, width: 50 },
    ])
  })

  it('clips a run to the window and drops one that falls outside it', () => {
    const runs: readonly CoverageRun[] = [
      { from: -500, to: 200, kind: 'both' },
      { from: 2_000, to: 3_000, kind: 'none' },
    ]

    expect(coverageSegments(runs, window, scale)).toEqual([{ kind: 'both', x: 0, width: 20 }])
  })

  it('widens a run the eye could not find, and keeps it inside the tape', () => {
    // Two minutes of silence in a twelve-hour session is a fraction of a unit wide. A gap nobody
    // can see is worse than one drawn a little too generously, so the caller opts in.
    const runs: readonly CoverageRun[] = [{ from: 995, to: 996, kind: 'none' }]

    const [segment] = coverageSegments(runs, window, scale, 4)

    expect(segment.width).toBe(4)
    expect(segment.x + segment.width).toBeLessThanOrEqual(100)
  })
})

describe('the noon-to-noon clock band', () => {
  function localTime(day: number, hour: number, minute: number): number {
    return new Date(2025, 6, day, hour, minute, 0, 0).getTime()
  }

  it('draws an overnight watch as one block through the middle', () => {
    // A midnight-to-midnight band would draw this same watch at both edges, which the eye reads
    // right to left and then wraps, against a ruler that reads left to right and whose two halves
    // are different dates.
    const band = clockBandFor(localTime(11, 19, 2), localTime(12, 6, 40))

    expect(band.clipped).toBe(false)
    expect(band.start).toBeGreaterThan(0)
    expect(band.end).toBeLessThan(1)
    expect(band.start).toBeLessThan(band.end)
  })

  it('anchors on the noon before the watch and runs exactly one local day', () => {
    const band = clockBandFor(localTime(11, 19, 2), localTime(12, 6, 40))

    expect(new Date(band.from).getHours()).toBe(12)
    expect(new Date(band.to).getHours()).toBe(12)
    expect(new Date(band.from).getDate()).toBe(11)
  })

  it('labels the same five hours every time, in reading order across the band', () => {
    const band = clockBandFor(localTime(11, 19, 2), localTime(12, 6, 40))

    expect(band.ticks.map((tick) => tick.hour)).toEqual([12, 18, 0, 6, 12])
    for (let index = 1; index < band.ticks.length; index += 1) {
      expect(band.ticks[index].position).toBeGreaterThan(band.ticks[index - 1].position)
    }
    expect(band.ticks[0].position).toBe(0)
    expect(band.ticks[4].position).toBe(1)
  })

  it('says so when a watch crosses noon and cannot fit a noon-anchored day', () => {
    // No band anchored on noon can hold a watch that crosses noon. Clipping and saying so is
    // honest; wrapping the remainder round to the far edge is the failure the seam exists to stop.
    const band = clockBandFor(localTime(12, 6, 20), localTime(12, 18, 44))

    expect(band.clipped).toBe(true)
    expect(band.start).toBe(0)
    expect(band.end).toBeLessThanOrEqual(1)
  })

  it('clamps a watch longer than a day to the band rather than drawing past its ends', () => {
    const band = clockBandFor(localTime(10, 8, 0), localTime(14, 8, 0))

    expect(band.clipped).toBe(true)
    expect(band.start).toBe(0)
    expect(band.end).toBe(1)
  })

  it('reads a watch whose ends arrived the wrong way round', () => {
    // A session can end before it started when the wall clock is stepped mid-watch. The band is
    // not the place to argue about it.
    const forwards = clockBandFor(localTime(11, 19, 2), localTime(12, 6, 40))
    const backwards = clockBandFor(localTime(12, 6, 40), localTime(11, 19, 2))

    expect(backwards).toEqual(forwards)
  })
})
