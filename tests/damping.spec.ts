import { describe, expect, it } from 'vitest'

import { BusReadoutMeter, REPAINT_INTERVAL_MS } from '../src/domain/damping'

/**
 * A load cycling through zero, which is the case the readout exists for: the latest sample is
 * useless as a rate and the mean is the answer. Amps of pack current, one second apart.
 */
const CYCLING = [-4.7, 2.9, -2.9, -3.0, 2.9, 2.6, -4.4, 3.1, -3.3, -2.8]

const VOLTAGE = 13.2

function feed(
  meter: BusReadoutMeter,
  values: readonly number[],
  options: { readonly from?: number; readonly solar?: number | null } = {},
) {
  const from = options.from ?? 0
  values.forEach((value, index) => {
    meter.observe(from + index * 1000, value, VOLTAGE, options.solar ?? null, null)
  })
  return from + (values.length - 1) * 1000
}

describe('BusReadoutMeter', () => {
  it('has nothing to say before a pack sample lands', () => {
    expect(new BusReadoutMeter().read(0)).toBeNull()
  })

  it('publishes the first sample it sees, so a card never waits on the gate', () => {
    const meter = new BusReadoutMeter()
    meter.observe(0, -8.4, VOLTAGE, 7.9, 104)
    const readout = meter.read(0)!
    expect(readout.packCurrentA).toBe(-8.4)
    expect(readout.solarCurrentA).toBe(7.9)
    expect(readout.spanMs).toBe(0)
  })

  it('reads a cycling load as its mean rather than as whichever sample arrived last', () => {
    const meter = new BusReadoutMeter()
    const at = feed(meter, CYCLING)
    const readout = meter.read(at)!
    // The last sample is −2.8 A; the pack is in fact moving almost no charge.
    expect(Math.abs(readout.packCurrentA)).toBeLessThan(1)
  })

  it('holds the published figures between repaints, handing back the same object', () => {
    const meter = new BusReadoutMeter()
    meter.observe(0, -20, VOLTAGE, null, null)
    const first = meter.read(0)!

    meter.observe(1000, -21, VOLTAGE, null, null)
    expect(meter.read(1000)).toBe(first)

    meter.observe(2000, -19, VOLTAGE, null, null)
    expect(meter.read(2000)).toBe(first)
  })

  it('republishes once the repaint interval has passed', () => {
    const meter = new BusReadoutMeter()
    meter.observe(0, -20, VOLTAGE, null, null)
    const first = meter.read(0)!

    meter.observe(REPAINT_INTERVAL_MS, -21, VOLTAGE, null, null)
    const second = meter.read(REPAINT_INTERVAL_MS)!
    expect(second).not.toBe(first)
    expect(second.packCurrentA).toBeCloseTo(-20.5, 1)
  })

  it('does not wait out the interval when the bus genuinely moves', () => {
    const meter = new BusReadoutMeter()
    meter.observe(0, -5, VOLTAGE, null, null)
    const resting = meter.read(0)!

    // A windlass. The mean is dragged far past the noise fraction inside one sample.
    meter.observe(500, -180, VOLTAGE, null, null)
    const pulled = meter.read(500)!
    expect(pulled).not.toBe(resting)
    expect(pulled.packCurrentA).toBeLessThan(-80)
  })

  it('publishes immediately when a radio arrives, whatever the interval says', () => {
    const meter = new BusReadoutMeter()
    meter.observe(0, -8, VOLTAGE, null, null)
    const packOnly = meter.read(0)!
    expect(packOnly.solarCurrentA).toBeNull()

    meter.observe(500, -8, VOLTAGE, 7.9, 104)
    const withSolar = meter.read(500)!
    expect(withSolar).not.toBe(packOnly)
    expect(withSolar.solarCurrentA).toBe(7.9)
    expect(withSolar.pvPowerW).toBe(104)
  })

  it('takes each side of the boat load over the same window, so the two reconcile', () => {
    const meter = new BusReadoutMeter()
    // Solar steady at 8 A against a pack cycling about a −8 A mean: the boat is drawing 16 A.
    const at = feed(meter, [-4, -12, -4, -12, -4, -12, -4, -12], { solar: 8 })
    const readout = meter.read(at)!
    expect(readout.solarCurrentA! - readout.packCurrentA).toBeCloseTo(16, 1)
  })

  it('drops everything on clear, including the held publication', () => {
    const meter = new BusReadoutMeter()
    meter.observe(0, -8.4, VOLTAGE, 7.9, 104)
    expect(meter.read(0)).not.toBeNull()

    meter.clear()
    expect(meter.read(0)).toBeNull()
  })

  it('withholds a readout once the window has aged out, rather than holding a stale one', () => {
    const meter = new BusReadoutMeter()
    meter.observe(0, -8.4, VOLTAGE, 7.9, 104)
    expect(meter.read(0)).not.toBeNull()
    expect(meter.read(120_000)).toBeNull()
  })
})
