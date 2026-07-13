import { describe, expect, it } from 'vitest'

import { levelForThresholds, worstOf } from '../src/application/severity'

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
    // MOSFET 72 °C on 55/70/80 is serious; a cell at 66 °C on 45/55/65 is critical. The badge
    // must read the worst of the two, not the hottest reading — which here is the MOSFET.
    const mosfet = levelForThresholds(72, 55, 70, 80)
    const cell = levelForThresholds(66, 45, 55, 65)
    expect(mosfet).toBe('serious')
    expect(cell).toBe('critical')
    expect(worstOf([mosfet, cell])).toBe('critical')
  })
})
