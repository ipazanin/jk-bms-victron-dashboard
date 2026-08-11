import { describe, expect, it } from 'vitest'

import {
  ampHoursSigned,
  amps,
  aperture,
  clockTimeWithSeconds,
  groupedCount,
  relativeAge,
  storedWattHours,
  wattsSigned,
} from '../src/application/format'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function ago(ms: number): string {
  const now = 1_000_000_000_000
  return relativeAge(now - ms, now)
}

describe('amps', () => {
  it('signs a genuine reading', () => {
    expect(amps(5.9)).toBe('+5.9 A')
    expect(amps(-10)).toBe('−10.0 A')
  })

  it('decides the sign after rounding, so a rounded-to-zero reading is unsigned', () => {
    // A current that rounds to zero has no direction; it must never read '−0.0 A' or '+0.0 A'.
    expect(amps(-0.04)).toBe('0.0 A')
    expect(amps(0.04)).toBe('0.0 A')
    expect(amps(0)).toBe('0.0 A')
  })

  it('keeps the sign once the magnitude rounds away from zero', () => {
    expect(amps(-0.06)).toBe('−0.1 A')
    expect(amps(0.06)).toBe('+0.1 A')
  })
})

describe('wattsSigned', () => {
  it('signs a genuine reading', () => {
    expect(wattsSigned(151)).toBe('+151 W')
    expect(wattsSigned(-1190.4)).toBe('−1190 W')
  })

  it('decides the sign after rounding, so a rounded-to-zero reading is unsigned', () => {
    expect(wattsSigned(-0.4)).toBe('0 W')
    expect(wattsSigned(0.4)).toBe('0 W')
    expect(wattsSigned(0)).toBe('0 W')
    expect(wattsSigned(-0)).toBe('0 W')
  })

  it('keeps the sign once the magnitude rounds away from zero', () => {
    expect(wattsSigned(-0.6)).toBe('−1 W')
    expect(wattsSigned(0.6)).toBe('+1 W')
  })
})

describe('ampHoursSigned', () => {
  it('signs a genuine reading', () => {
    expect(ampHoursSigned(12.34)).toBe('+12.3 Ah')
    expect(ampHoursSigned(-8)).toBe('−8.0 Ah')
  })

  it('decides the sign after rounding, so a rounded-to-zero reading is unsigned', () => {
    expect(ampHoursSigned(-0.04)).toBe('0.0 Ah')
    expect(ampHoursSigned(0.04)).toBe('0.0 Ah')
    expect(ampHoursSigned(0)).toBe('0.0 Ah')
  })

  it('rounds to the digits requested, as the energy bars call it with none', () => {
    expect(ampHoursSigned(12.6, 0)).toBe('+13 Ah')
    expect(ampHoursSigned(-0.4, 0)).toBe('0 Ah')
  })
})

describe('clockTimeWithSeconds', () => {
  it('appends zero-padded seconds to the minute clock', () => {
    const at = new Date(2024, 0, 1, 9, 5, 3).getTime()
    expect(clockTimeWithSeconds(at)).toBe('09:05:03')
  })
})

describe('groupedCount', () => {
  it('carries no separator under four digits', () => {
    expect(groupedCount(999)).toBe('999')
  })

  it('separates a four-digit count with a non-breaking space', () => {
    expect(groupedCount(1234)).toBe('1 234')
  })
})

describe('aperture', () => {
  it('says so rather than printing seconds while the window is still filling', () => {
    expect(aperture(0)).toBe('over <1 min')
    expect(aperture(45 * SECOND)).toBe('over <1 min')
  })

  it('floors, so a window never rounds itself up into a wider claim', () => {
    expect(aperture(MINUTE)).toBe('over 1 min')
    expect(aperture(90 * SECOND)).toBe('over 1 min')
    expect(aperture(5 * MINUTE - SECOND)).toBe('over 4 min')
    expect(aperture(5 * MINUTE)).toBe('over 5 min')
  })
})

describe('storedWattHours', () => {
  it('reads a full bank in tenths of a kilowatt-hour', () => {
    // A 4S 315 Ah bank at 12.8 V nominal is 4 032 Wh; two significant figures is all it earns.
    expect(storedWattHours(4032)).toBe('4.0 kWh')
    expect(storedWattHours(2614)).toBe('2.6 kWh')
  })

  it('reads what is left of a flat bank in tens of watt-hours', () => {
    expect(storedWattHours(844)).toBe('840 Wh')
    expect(storedWattHours(6)).toBe('10 Wh')
    expect(storedWattHours(0)).toBe('0 Wh')
  })

  it('crosses to kilowatt-hours before the watt-hour form grows a fourth digit', () => {
    expect(storedWattHours(994)).toBe('990 Wh')
    expect(storedWattHours(996)).toBe('1.0 kWh')
  })
})

describe('relativeAge', () => {
  it('reads under a minute as moments ago', () => {
    expect(ago(0)).toBe('moments ago')
    expect(ago(59 * SECOND)).toBe('moments ago')
  })

  it('switches to minutes at exactly one minute', () => {
    expect(ago(60 * SECOND)).toBe('1 min ago')
    expect(ago(59 * MINUTE)).toBe('59 min ago')
  })

  it('switches to hours at exactly one hour', () => {
    expect(ago(60 * MINUTE)).toBe('1 h ago')
    expect(ago(23 * HOUR)).toBe('23 h ago')
  })

  it('reads a full day as yesterday', () => {
    expect(ago(24 * HOUR)).toBe('yesterday')
  })

  it('reads two days and beyond in days', () => {
    expect(ago(48 * HOUR)).toBe('2 days ago')
    expect(ago(9 * DAY)).toBe('9 days ago')
  })

  it('never reports a negative age for a future timestamp', () => {
    expect(ago(-5 * MINUTE)).toBe('moments ago')
  })
})
