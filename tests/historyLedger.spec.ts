import { describe, expect, it } from 'vitest'

import { MAX_PAIRING_AGE_MS, MAX_SAMPLE_GAP_MS, pairSamples } from '../src/domain/history/join'
import type { PairedSample } from '../src/domain/history/join'
import {
  EMPTY_LEDGER,
  appendCoverage,
  classifyInterval,
  foldAccount,
  ledgerOfInterval,
  mergeLedgers,
  recomputeAccount,
  recomputeLedger,
} from '../src/domain/history/ledger'
import { decodePackChunk, decodeSolarChunk } from '../src/domain/history/columns'
import type { CoverageRun, PackSample, SessionLedger, SolarSample } from '../src/domain/history/types'
import storedSession from './fixtures/storedSession.json'
import { SAMPLE_EPOCH, packChunk, packSample, solarChunk, solarSample } from './support/samples'

// The ledger is a cache of a pure function of the chunks. Everything below exists to keep it one:
// the incremental fold the recorder runs and the whole-session rescan a reader runs have to be the
// same account, or the figure printed on a session row is a second opinion nobody can check.

const HOUR_MS = 3_600_000

function ledger(overrides: Partial<SessionLedger>): SessionLedger {
  return { ...EMPTY_LEDGER, ...overrides }
}

/** One instant of the merged timeline, with whichever halves the case is about. */
function instant(at: number, pack: Partial<PackSample> | null, solar: Partial<SolarSample> | null): PairedSample {
  return {
    at,
    pack: pack === null ? null : packSample({ at, ...pack }),
    solar: solar === null ? null : solarSample({ at, ...solar }),
  }
}

/** Amp-hours a steady current moves over a span, which is what every integral here reduces to. */
function ampHours(amps: number, elapsedMs: number): number {
  return (amps * elapsedMs) / HOUR_MS
}

describe('merging two accounts', () => {
  it('leaves an account alone when merged with the empty one, either way round', () => {
    const account = ledger({ countedMs: 4_000, packAh: 3, solarAh: 8, houseWh: 61, stateOfChargeFirst: 71 })

    expect(mergeLedgers(EMPTY_LEDGER, account)).toEqual(account)
    expect(mergeLedgers(account, EMPTY_LEDGER)).toEqual(account)
  })

  it('associates, so the order the fold happens to run in cannot change the account', () => {
    const first = ledger({ countedMs: 1_000, packAh: 2, solarAh: 5, stateOfChargeFirst: 80, stateOfChargeMin: 80 })
    const second = ledger({ countedMs: 2_000, packAh: 4, foreignMs: 500, stateOfChargeMin: 61 })
    const third = ledger({ countedMs: 3_000, solarAh: 9, stateOfChargeLast: 74, pvPowerPeakW: 151 })

    expect(mergeLedgers(mergeLedgers(first, second), third)).toEqual(
      mergeLedgers(first, mergeLedgers(second, third)),
    )
  })

  it('keeps the first reading first and the last last, whatever the sums do', () => {
    const opening = ledger({ stateOfChargeFirst: 46, stateOfChargeLast: 46, remainingCapacityFirstAh: 128.4 })
    const closing = ledger({ stateOfChargeFirst: 58, stateOfChargeLast: 58, remainingCapacityLastAh: 162.1 })

    const merged = mergeLedgers(opening, closing)

    expect(merged.stateOfChargeFirst).toBe(46)
    expect(merged.stateOfChargeLast).toBe(58)
    expect(merged.remainingCapacityFirstAh).toBe(128.4)
    expect(merged.remainingCapacityLastAh).toBe(162.1)
  })

  it('takes the deepest state of charge and the highest pv power from either side', () => {
    const merged = mergeLedgers(
      ledger({ stateOfChargeMin: 61, pvPowerPeakW: 168 }),
      ledger({ stateOfChargeMin: 41, pvPowerPeakW: 92 }),
    )

    expect(merged.stateOfChargeMin).toBe(41)
    expect(merged.pvPowerPeakW).toBe(168)
  })
})

describe('what one interval contributes', () => {
  it('counts the window where both radios reported and the panels covered the pack', () => {
    const elapsed = 4_000
    const contribution = ledgerOfInterval(
      instant(SAMPLE_EPOCH, { currentA: -8, packVoltageV: 13 }, { batteryCurrentA: 8 }),
      instant(SAMPLE_EPOCH + elapsed, { currentA: -8, packVoltageV: 13 }, { batteryCurrentA: 8 }),
    )

    expect(contribution.countedMs).toBe(elapsed)
    expect(contribution.foreignMs).toBe(0)
    expect(contribution.packAh).toBeCloseTo(ampHours(-8, elapsed), 12)
    expect(contribution.solarAh).toBeCloseTo(ampHours(8, elapsed), 12)
    // house = solar − pack = 8 − (−8) = 16 A at 13 V.
    expect(contribution.houseWh).toBeCloseTo((16 * 13 * elapsed) / HOUR_MS, 12)
  })

  it('sets the window aside when the pack took more than the panels gave', () => {
    // An alternator or a shore charger was on the bus. The difference is no longer a house load,
    // so nothing is counted and what is reported is a floor on the charge nobody measured.
    const elapsed = 4_000
    const contribution = ledgerOfInterval(
      instant(SAMPLE_EPOCH, { currentA: 10 }, { batteryCurrentA: 2 }),
      instant(SAMPLE_EPOCH + elapsed, { currentA: 10 }, { batteryCurrentA: 2 }),
    )

    expect(contribution.countedMs).toBe(0)
    expect(contribution.foreignMs).toBe(elapsed)
    expect(contribution.packAh).toBe(0)
    expect(contribution.solarAh).toBe(0)
    expect(contribution.houseWh).toBe(0)
    expect(contribution.foreignAhFloor).toBeCloseTo(ampHours(8, elapsed), 12)
    // The pack integral is the cross-check against the BMS's own counter and spans both windows.
    expect(contribution.packAhWholeSession).toBeCloseTo(ampHours(10, elapsed), 12)
  })

  it('never reports a negative floor on unmeasured charge', () => {
    const contribution = ledgerOfInterval(
      instant(SAMPLE_EPOCH, { currentA: -8 }, { batteryCurrentA: 8 }),
      instant(SAMPLE_EPOCH + 4_000, { currentA: -8 }, { batteryCurrentA: 8 }),
    )

    expect(contribution.foreignAhFloor).toBe(0)
  })

  it('counts an interval sitting exactly on the partition as counted, not foreign', () => {
    // The boundary is strict zero rather than the instantaneous noise floor, so a stored ledger
    // stays valid if that floor is ever corrected.
    const contribution = ledgerOfInterval(
      instant(SAMPLE_EPOCH, { currentA: 4 }, { batteryCurrentA: 4 }),
      instant(SAMPLE_EPOCH + 4_000, { currentA: 4 }, { batteryCurrentA: 4 }),
    )

    expect(contribution.countedMs).toBe(4_000)
    expect(contribution.foreignMs).toBe(0)
  })

  it('contributes nothing across a span longer than the gap bound', () => {
    // A sample describes the instant it was taken, not the span after it. Spreading a rate across
    // a hole is the one arithmetic here that could invent charge no radio reported.
    const contribution = ledgerOfInterval(
      instant(SAMPLE_EPOCH, { currentA: -8 }, { batteryCurrentA: 8 }),
      instant(SAMPLE_EPOCH + MAX_SAMPLE_GAP_MS + 1, { currentA: -8 }, { batteryCurrentA: 8 }),
    )

    expect(contribution).toEqual(EMPTY_LEDGER)
  })

  it('counts a span sitting exactly on the gap bound', () => {
    const contribution = ledgerOfInterval(
      instant(SAMPLE_EPOCH, { currentA: -8 }, { batteryCurrentA: 8 }),
      instant(SAMPLE_EPOCH + MAX_SAMPLE_GAP_MS, { currentA: -8 }, { batteryCurrentA: 8 }),
    )

    expect(contribution.countedMs).toBe(MAX_SAMPLE_GAP_MS)
  })

  it('leaves the pack integral alone across a span the BMS did not cover', () => {
    // Charge that moved while the BMS was silent is charge neither radio can account for, so it
    // stays out of the figure the cross-check is made from.
    const contribution = ledgerOfInterval(
      instant(SAMPLE_EPOCH, null, { batteryCurrentA: 8 }),
      instant(SAMPLE_EPOCH + 4_000, { currentA: -8 }, { batteryCurrentA: 8 }),
    )

    expect(contribution).toEqual(EMPTY_LEDGER)
  })

  it('keeps the pack integral across a span the controller did not cover', () => {
    const contribution = ledgerOfInterval(
      instant(SAMPLE_EPOCH, { currentA: -8 }, null),
      instant(SAMPLE_EPOCH + 4_000, { currentA: -8 }, null),
    )

    expect(contribution.countedMs).toBe(0)
    expect(contribution.packAhWholeSession).toBeCloseTo(ampHours(-8, 4_000), 12)
  })

  it('integrates a swing through zero as the charge it actually moved', () => {
    // A load alternating ±5 A is loud on every sample and moves almost nothing. The trapezoid is
    // what says so.
    const contribution = ledgerOfInterval(
      instant(SAMPLE_EPOCH, { currentA: -5 }, { batteryCurrentA: 6 }),
      instant(SAMPLE_EPOCH + 4_000, { currentA: 5 }, { batteryCurrentA: 6 }),
    )

    expect(contribution.packAh).toBe(0)
    expect(contribution.solarAh).toBeCloseTo(ampHours(6, 4_000), 12)
  })
})

describe('classifying an interval', () => {
  const bothReported = [
    instant(SAMPLE_EPOCH, { currentA: -8 }, { batteryCurrentA: 8 }),
    instant(SAMPLE_EPOCH + 1_000, { currentA: -8 }, { batteryCurrentA: 8 }),
  ] as const

  it('calls it both when the identity held across it', () => {
    expect(classifyInterval(bothReported[0], bothReported[1])).toBe('both')
  })

  it('calls it foreign when the pack took more than the panels gave', () => {
    expect(
      classifyInterval(
        instant(SAMPLE_EPOCH, { currentA: 10 }, { batteryCurrentA: 2 }),
        instant(SAMPLE_EPOCH + 1_000, { currentA: 10 }, { batteryCurrentA: 2 }),
      ),
    ).toBe('foreign')
  })

  it('calls it pack-only when the advertisement carried no battery current', () => {
    // Coverage is what could be computed, not what merely arrived: a reading with no current
    // cannot enter house = solar − pack, so it is not solar coverage.
    expect(
      classifyInterval(
        instant(SAMPLE_EPOCH, { currentA: -8 }, { batteryCurrentA: null }),
        instant(SAMPLE_EPOCH + 1_000, { currentA: -8 }, { batteryCurrentA: null }),
      ),
    ).toBe('pack-only')
  })

  it('calls it solar-only when the pack was silent', () => {
    expect(
      classifyInterval(
        instant(SAMPLE_EPOCH, null, { batteryCurrentA: 8 }),
        instant(SAMPLE_EPOCH + 1_000, null, { batteryCurrentA: 8 }),
      ),
    ).toBe('solar-only')
  })

  it('calls it none when neither radio spoke, and again when the span is a hole', () => {
    expect(
      classifyInterval(instant(SAMPLE_EPOCH, null, null), instant(SAMPLE_EPOCH + 1_000, null, null)),
    ).toBe('none')
    expect(classifyInterval(bothReported[0], instant(SAMPLE_EPOCH + MAX_SAMPLE_GAP_MS + 1, { currentA: -8 }, { batteryCurrentA: 8 }))).toBe('none')
  })
})

describe('coverage runs', () => {
  it('extends the trailing run rather than repeating its class', () => {
    let runs: readonly CoverageRun[] = []
    runs = appendCoverage(runs, 0, 1_000, 'both')
    runs = appendCoverage(runs, 1_000, 2_000, 'both')
    runs = appendCoverage(runs, 2_000, 3_000, 'both')

    expect(runs).toEqual([{ from: 0, to: 3_000, kind: 'both' }])
  })

  it('appends when the class changes and again when it changes back', () => {
    let runs: readonly CoverageRun[] = []
    runs = appendCoverage(runs, 0, 1_000, 'both')
    runs = appendCoverage(runs, 1_000, 2_000, 'pack-only')
    runs = appendCoverage(runs, 2_000, 3_000, 'both')

    expect(runs).toEqual([
      { from: 0, to: 1_000, kind: 'both' },
      { from: 1_000, to: 2_000, kind: 'pack-only' },
      { from: 2_000, to: 3_000, kind: 'both' },
    ])
  })

  it('starts a new run when the spans do not meet, so no run covers time it did not', () => {
    let runs: readonly CoverageRun[] = []
    runs = appendCoverage(runs, 0, 1_000, 'both')
    runs = appendCoverage(runs, 5_000, 6_000, 'both')

    expect(runs).toEqual([
      { from: 0, to: 1_000, kind: 'both' },
      { from: 5_000, to: 6_000, kind: 'both' },
    ])
  })

  it('ignores an empty or inverted span', () => {
    expect(appendCoverage([], 1_000, 1_000, 'both')).toEqual([])
    expect(appendCoverage([], 2_000, 1_000, 'both')).toEqual([])
  })

  it('lays a session down as runs that touch end to end and never overlap', () => {
    const rows: PairedSample[] = []
    for (let index = 0; index < 12; index += 1) {
      const at = SAMPLE_EPOCH + index * 1_000
      // Both radios, then the controller goes quiet, then it comes back charging less than the
      // pack is taking.
      if (index < 4) rows.push(instant(at, { currentA: -8 }, { batteryCurrentA: 8 }))
      else if (index < 8) rows.push(instant(at, { currentA: -8 }, null))
      else rows.push(instant(at, { currentA: 10 }, { batteryCurrentA: 2 }))
    }

    const { coverage, ledger: account } = foldAccount(rows)

    expect(coverage.map((run) => run.kind)).toEqual(['both', 'pack-only', 'foreign'])
    for (let index = 1; index < coverage.length; index += 1) {
      expect(coverage[index].from).toBe(coverage[index - 1].to)
    }
    // The counted window is exactly the both runs and the foreign window exactly the foreign ones,
    // so the tape below the figure makes the sentence above it checkable.
    expect(account.countedMs).toBe(3_000)
    expect(account.foreignMs).toBe(3_000)
  })
})

describe('the fold and the rescan', () => {
  /** A watch with both radios, a controller dropout, and an unmeasured charger on the bus. */
  function watch(): { pack: PackSample[]; solar: SolarSample[] } {
    const pack: PackSample[] = []
    const solar: SolarSample[] = []
    for (let index = 0; index < 40; index += 1) {
      const at = SAMPLE_EPOCH + index * 1_000
      pack.push(packSample({ at, currentA: index < 24 ? -5.037 + index * 0.1 : 9.4, stateOfCharge: 98 - index }))
      if (index >= 12 && index < 18) continue
      solar.push(solarSample({ at, batteryCurrentA: index < 24 ? 7.9 : 2.1, pvPowerW: 151 - index }))
    }
    return { pack, solar }
  }

  it('survives the wire scales, so the stored account is the recorded one', () => {
    const { pack, solar } = watch()
    const live = foldAccount(pairSamples(pack, solar, MAX_PAIRING_AGE_MS)).ledger

    // The same rows after a trip through the columns. Every figure sits at a scale its radio
    // transmits, so the account a reader recomputes is the account the recorder folded.
    const rescanned = recomputeLedger(
      decodePackChunk(packChunk(pack)),
      decodeSolarChunk(solarChunk(solar)),
      MAX_PAIRING_AGE_MS,
    )

    expect(rescanned).toEqual(live)
  })

  it('splits anywhere and merges back to the same account', () => {
    // This is the property the recorder's running total depends on: it folds one interval at a
    // time and never sees the whole session at once.
    const { pack, solar } = watch()
    const rows = pairSamples(pack, solar, MAX_PAIRING_AGE_MS)
    const whole = foldAccount(rows).ledger

    for (const cut of [1, 7, 19, rows.length - 1]) {
      const split = mergeLedgers(
        foldAccount(rows.slice(0, cut + 1)).ledger,
        foldAccount(rows.slice(cut)).ledger,
      )
      // Floating-point addition is not associative, so the law holds to the precision the sums
      // carry rather than bit for bit. Twelve decimals on an amp-hour is a nanoamp-hour.
      expect(split.countedMs).toBe(whole.countedMs)
      expect(split.foreignMs).toBe(whole.foreignMs)
      expect(split.packAh).toBeCloseTo(whole.packAh, 12)
      expect(split.solarAh).toBeCloseTo(whole.solarAh, 12)
      expect(split.houseWh).toBeCloseTo(whole.houseWh, 9)
      expect(split.foreignAhFloor).toBeCloseTo(whole.foreignAhFloor, 12)
      expect(split.packAhWholeSession).toBeCloseTo(whole.packAhWholeSession, 12)
      expect(split.stateOfChargeFirst).toBe(whole.stateOfChargeFirst)
      expect(split.stateOfChargeLast).toBe(whole.stateOfChargeLast)
      expect(split.stateOfChargeMin).toBe(whole.stateOfChargeMin)
      expect(split.pvPowerPeakW).toBe(whole.pvPowerPeakW)
    }
  })

  it('has nothing to say about a session with no samples', () => {
    expect(foldAccount([])).toEqual({ ledger: EMPTY_LEDGER, coverage: [] })
    expect(recomputeLedger([], [], MAX_PAIRING_AGE_MS)).toEqual(EMPTY_LEDGER)
  })
})

describe('the session seeded into a real browser', () => {
  // `scripts/visual-check.mjs` writes this same document into IndexedDB and then asserts the page
  // draws it. Validating it here as well is what makes it one source of truth: a change to the
  // column layout or to the account breaks the check and this spec together, rather than leaving
  // the visual check quietly asserting against a shape the app no longer writes.

  const VIEWS = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array }

  /**
   * JSON carries no typed arrays, so each column is widened back to the width the archive stores
   * it at. The widths ride in the fixture rather than being restated here: a column that changed
   * scale has to fail as a decoded value, not as a lookup nobody updated.
   */
  function rehydrate(chunk: (typeof storedSession.chunks)[number]): PackSample[] | SolarSample[] {
    const types = storedSession.columnTypes[chunk.stream as 'pack' | 'solar'] as Record<string, string>
    const rebuilt: Record<string, unknown> = { ...chunk }
    for (const [name, width] of Object.entries(types)) {
      rebuilt[name] = new VIEWS[width as keyof typeof VIEWS](rebuilt[name] as number[])
    }
    return chunk.stream === 'pack'
      ? decodePackChunk(rebuilt as unknown as Parameters<typeof decodePackChunk>[0])
      : decodeSolarChunk(rebuilt as unknown as Parameters<typeof decodeSolarChunk>[0])
  }

  const pack = rehydrate(storedSession.chunks[0]) as PackSample[]
  const solar = rehydrate(storedSession.chunks[1]) as SolarSample[]

  it('holds the rows its session row claims', () => {
    expect(pack).toHaveLength(storedSession.session.packSamples)
    expect(solar).toHaveLength(storedSession.session.solarSamples)
    expect(storedSession.meta.totalSamples).toBe(pack.length + solar.length)
  })

  it('carries an account its own chunks reproduce exactly', () => {
    expect(recomputeAccount(pack, solar, MAX_PAIRING_AGE_MS)).toEqual({
      ledger: storedSession.session.ledger,
      coverage: storedSession.session.coverage,
    })
  })

  it('covers every class the tape has to draw, so the legend is never asserted over nothing', () => {
    expect(storedSession.session.coverage.map((run) => run.kind)).toEqual([
      'both',
      'pack-only',
      'foreign',
      'both',
    ])
  })
})
