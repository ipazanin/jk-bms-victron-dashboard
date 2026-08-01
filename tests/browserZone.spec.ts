/**
 * The browser zone's standard offset, driven by putting the host in a real zone.
 *
 * `process.env.TZ` is what moves the host: assigning it invalidates the cached zone, so every
 * `Date` built afterwards reads the new one. Each case sets it, and the host's own zone is put back
 * afterwards so nothing that runs later in this worker inherits a zone it did not ask for.
 *
 * The zones below are chosen for the ways this can go wrong rather than for coverage: a northern
 * zone whose summer time is the shipping bug, a southern one whose summer time runs across the new
 * year, one that keeps no summer time and sits on a half hour, one west of UTC where a sign error
 * is loudest, and UTC itself.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { browserStandardUtcOffsetMinutes } from '../src/application/browserZone'

const NORTHERN_SUMMER = Date.UTC(2026, 6, 15)
const NORTHERN_WINTER = Date.UTC(2026, 0, 15)

const hostZone = process.env.TZ

afterEach(() => {
  if (hostZone === undefined) delete process.env.TZ
  else process.env.TZ = hostZone
})

function movingHostTo(zone: string): void {
  process.env.TZ = zone
}

/**
 * What a naive reading gives: the offset in force at one instant, summer time and all. The added
 * zero flattens the −0 that negating UTC's own zero produces, which the helper under test flattens
 * too — an assertion is otherwise comparing signed zeroes rather than offsets.
 */
function liveUtcOffsetMinutesAt(instantMs: number): number {
  return -new Date(instantMs).getTimezoneOffset() + 0
}

const zones = [
  {
    zone: 'Europe/Zagreb',
    standardOffsetMinutes: 60,
    insideSummerTimeMs: NORTHERN_SUMMER,
    summerOffsetMinutes: 120,
  },
  {
    zone: 'Australia/Sydney',
    standardOffsetMinutes: 600,
    insideSummerTimeMs: NORTHERN_WINTER,
    summerOffsetMinutes: 660,
  },
  {
    zone: 'America/New_York',
    standardOffsetMinutes: -300,
    insideSummerTimeMs: NORTHERN_SUMMER,
    summerOffsetMinutes: -240,
  },
  {
    zone: 'Asia/Kolkata',
    standardOffsetMinutes: 330,
    insideSummerTimeMs: NORTHERN_SUMMER,
    summerOffsetMinutes: 330,
  },
  {
    zone: 'UTC',
    standardOffsetMinutes: 0,
    insideSummerTimeMs: NORTHERN_SUMMER,
    summerOffsetMinutes: 0,
  },
] as const

describe('the standard offset of the browser’s own zone', () => {
  zones.forEach((sample) => {
    it(`reads ${sample.zone} as ${sample.standardOffsetMinutes} minutes, asked from either season`, () => {
      movingHostTo(sample.zone)

      expect(browserStandardUtcOffsetMinutes(NORTHERN_WINTER)).toBe(sample.standardOffsetMinutes)
      expect(browserStandardUtcOffsetMinutes(NORTHERN_SUMMER)).toBe(sample.standardOffsetMinutes)
    })

    it(`reads ${sample.zone} the same from every month of the year`, () => {
      movingHostTo(sample.zone)
      const monthStarts = Array.from({ length: 12 }, (_, month) => Date.UTC(2026, month, 1))

      const answers = monthStarts.map((monthStart) => browserStandardUtcOffsetMinutes(monthStart))

      expect(new Set(answers)).toEqual(new Set([sample.standardOffsetMinutes]))
    })

    it(`ignores the offset ${sample.zone} happens to be on at the instant it is asked`, () => {
      movingHostTo(sample.zone)

      expect(liveUtcOffsetMinutesAt(sample.insideSummerTimeMs)).toBe(sample.summerOffsetMinutes)
      expect(browserStandardUtcOffsetMinutes(sample.insideSummerTimeMs)).toBe(sample.standardOffsetMinutes)
    })
  })

  /**
   * The sign, spelled out on the zone where getting it backwards is survivable-looking and wrong:
   * New York stands 300 minutes BEHIND UTC, and `getTimezoneOffset` reports that as +300 because it
   * counts minutes west. A helper that forgot to negate would answer +300 here and pass every
   * European case in this file.
   */
  it('signs a zone west of UTC negative, the opposite way to getTimezoneOffset', () => {
    movingHostTo('America/New_York')

    expect(browserStandardUtcOffsetMinutes(NORTHERN_SUMMER)).toBe(-300)
    expect(new Date(NORTHERN_SUMMER).getTimezoneOffset()).toBeGreaterThan(0)
  })

  /** Summer time is an advance, so the standard offset is the smaller of a zone's two. */
  it('takes the winter offset in a zone that keeps summer time, not the summer one', () => {
    movingHostTo('Europe/Zagreb')

    const standard = browserStandardUtcOffsetMinutes(NORTHERN_SUMMER)

    expect(liveUtcOffsetMinutesAt(NORTHERN_SUMMER) - standard).toBe(60)
    expect(liveUtcOffsetMinutesAt(NORTHERN_WINTER) - standard).toBe(0)
  })

  /** Southern summer time straddles the new year, so a December sample is inside it, not outside. */
  it('finds the standard offset of a southern zone from a midsummer instant', () => {
    movingHostTo('Australia/Sydney')

    expect(browserStandardUtcOffsetMinutes(Date.UTC(2026, 11, 25))).toBe(600)
    expect(liveUtcOffsetMinutesAt(Date.UTC(2026, 11, 25))).toBe(660)
  })
})
