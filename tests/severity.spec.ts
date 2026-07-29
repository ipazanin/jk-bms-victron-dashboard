import { describe, expect, it } from 'vitest'

import {
  MOSFET_CRITICAL,
  MOSFET_SERIOUS,
  MOSFET_WARNING,
  levelForThresholds,
  worstOf,
} from '../src/application/severity'

describe('the MOSFET bands', () => {
  // Pins the numbers the annunciator and the temperature gauge both grade against, so a band that
  // moves is a deliberate edit here and not a silent regrade of the whole boat. The annunciator's
  // own boundary cases in faults.spec.ts still spell these numbers out as literals, so a band that
  // moves has to move there too — otherwise that file stops testing a boundary and starts testing
  // the middle of a band, and says nothing about the new one.
  it('warn at 55 °C, turn serious at 70 and critical at 80', () => {
    expect([MOSFET_WARNING, MOSFET_SERIOUS, MOSFET_CRITICAL]).toEqual([55, 70, 80])
  })
})

describe('levelForThresholds', () => {
  it('grades a rising measurement against ascending thresholds', () => {
    expect(levelForThresholds(40, 45, 55, 65)).toBe('good')
    expect(levelForThresholds(50, 45, 55, 65)).toBe('warning')
    expect(levelForThresholds(60, 45, 55, 65)).toBe('serious')
    expect(levelForThresholds(70, 45, 55, 65)).toBe('critical')
  })

  it('treats each threshold as inclusive at its boundary', () => {
    expect(levelForThresholds(45, 45, 55, 65)).toBe('warning')
    expect(levelForThresholds(55, 45, 55, 65)).toBe('serious')
    expect(levelForThresholds(65, 45, 55, 65)).toBe('critical')
  })
})

describe('worstOf', () => {
  it('is good when nothing is given', () => {
    expect(worstOf([])).toBe('good')
  })

  it('returns the only level it is given', () => {
    expect(worstOf(['serious'])).toBe('serious')
  })

  it('takes the most severe regardless of position', () => {
    expect(worstOf(['warning', 'critical', 'good'])).toBe('critical')
    expect(worstOf(['critical', 'warning', 'serious'])).toBe('critical')
    expect(worstOf(['good', 'warning'])).toBe('warning')
  })

  it('a serious MOSFET does not mask a critical cell', () => {
    // The MOSFET here is the hotter of the two, and the cooler cell is the worse one: cells run on
    // tighter bands, so 66 °C is past their last one. The badge must read the worst, not the hottest.
    const mosfet = levelForThresholds(72, MOSFET_WARNING, MOSFET_SERIOUS, MOSFET_CRITICAL)
    const cell = levelForThresholds(66, 45, 55, 65)
    expect(mosfet).toBe('serious')
    expect(cell).toBe('critical')
    expect(worstOf([mosfet, cell])).toBe('critical')
  })
})
