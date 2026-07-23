import { describe, expect, it } from 'vitest'

import { TrailingWindow, reachOf } from '../src/domain/reach'

/** Six consecutive pack currents observed on the boat, one second apart. */
const OBSERVED = [-4.7, 2.9, -2.9, -3.0, 2.9, 2.6]

function seconds(values: readonly number[]) {
  return values.map((value, index) => ({ at: index * 1000, value }))
}

describe('reachOf', () => {
  it('has nothing to say about an empty window', () => {
    expect(reachOf([])).toBeNull()
  })

  it('collapses to the single sample it has', () => {
    const reach = reachOf([{ at: 0, value: 4.2 }])!
    expect(reach.low).toBe(4.2)
    expect(reach.high).toBe(4.2)
    expect(reach.latest).toBe(4.2)
    expect(reach.net).toBe(4.2)
    expect(reach.spanMs).toBe(0)
  })

  it('spans the observed swing and reports a net rate near zero', () => {
    const reach = reachOf(seconds(OBSERVED))!
    expect(reach.low).toBe(-4.7)
    expect(reach.high).toBe(2.9)
    expect(reach.latest).toBe(2.6)
    expect(reach.count).toBe(6)
    expect(reach.spanMs).toBe(5000)
    // The pack swings ±5 A yet moves almost no charge: that is the whole point of the rate.
    expect(Math.abs(reach.net)).toBeLessThan(0.5)
  })

  it('weights the rate by time, not by sample count', () => {
    // Two seconds at 10 A then eight seconds at 0 A is 2 A on average, not 5 A.
    const reach = reachOf([
      { at: 0, value: 10 },
      { at: 2000, value: 10 },
      { at: 2001, value: 0 },
      { at: 10_000, value: 0 },
    ])!
    expect(reach.net).toBeCloseTo(2, 1)
  })
})

describe('TrailingWindow', () => {
  it('drops samples that have aged out', () => {
    const window = new TrailingWindow(5000)
    window.observe(0, 100)
    window.observe(1000, 1)
    window.observe(2000, 2)
    window.observe(7000, 3)

    // A five-second window read at t=7000 covers [2000, 7000], so the 100 at t=0 and the 1 at
    // t=1000 are both outside it.
    const reach = window.read(7000)!
    expect(reach.high).toBe(3)
    expect(reach.low).toBe(2)
    expect(reach.count).toBe(2)
  })

  it('ages on read as well as on observe, so a stale window makes no claim', () => {
    const window = new TrailingWindow(30_000)
    window.observe(0, -4.9)
    window.observe(1000, 4.3)

    expect(window.read(2000)).not.toBeNull()
    // The link has gone quiet for two minutes. A band labelled "the last 30 seconds" drawn over
    // these samples would be a lie, so there is nothing to draw.
    expect(window.read(120_000)).toBeNull()
  })

  it('refuses a non-finite reading rather than poisoning low, high and net at once', () => {
    const window = new TrailingWindow(10_000)
    window.observe(0, 1)
    window.observe(1000, Number.NaN)
    window.observe(2000, 3)

    const reach = window.read(2000)!
    expect(reach.count).toBe(2)
    expect(reach.low).toBe(1)
    expect(reach.high).toBe(3)
  })

  it('clears completely, so one pack never inherits another pack’s window', () => {
    const window = new TrailingWindow(10_000)
    window.observe(0, 42)
    window.clear()
    expect(window.read(0)).toBeNull()
  })
})
