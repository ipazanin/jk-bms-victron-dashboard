import { describe, expect, it } from 'vitest'

import { dailyTotals, startOfLocalDay } from '../src/application/history/daily'
import { EMPTY_LEDGER } from '../src/domain/history/ledger'
import type { SessionLedger } from '../src/domain/history/types'
import { sessionRecord } from './support/samples'

/** A local wall-clock instant, so day bucketing is deterministic whatever the runner's timezone. */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month, day, hour, minute, 0).getTime()
}

function ledger(overrides: Partial<SessionLedger>): SessionLedger {
  return { ...EMPTY_LEDGER, ...overrides }
}

describe('dailyTotals', () => {
  it('buckets sessions by local day and folds their ledgers', () => {
    const records = [
      sessionRecord({
        id: 'a',
        startedAt: at(2025, 0, 1, 8),
        ledger: ledger({ packAh: 10, solarAh: 20, houseWh: 100, stateOfChargeMin: 80, pvPowerPeakW: 150 }),
      }),
      sessionRecord({
        id: 'b',
        startedAt: at(2025, 0, 1, 20),
        ledger: ledger({ packAh: -5, solarAh: 5, houseWh: 60, stateOfChargeMin: 70, pvPowerPeakW: 90 }),
      }),
      sessionRecord({
        id: 'c',
        startedAt: at(2025, 0, 2, 9),
        ledger: ledger({ packAh: 3, solarAh: 8, houseWh: 40, stateOfChargeMin: 90, pvPowerPeakW: 120 }),
      }),
    ]

    const days = dailyTotals(records, at(2025, 0, 3, 0))

    expect(days).toHaveLength(2)
    // Newest first.
    expect(days[0].day).toBe(startOfLocalDay(at(2025, 0, 2, 0)))

    const first = days[1]
    expect(first.sessions).toBe(2)
    expect(first.packAh).toBe(5) // 10 + (−5)
    expect(first.solarAh).toBe(25)
    expect(first.houseWh).toBe(160)
    expect(first.deepestSoc).toBe(70) // min(80, 70)
    expect(first.pvPeakW).toBe(150) // max(150, 90)
  })

  it('attributes a session that crosses midnight to the day it began', () => {
    const record = sessionRecord({
      startedAt: at(2025, 0, 1, 23, 30),
      endedAt: at(2025, 0, 2, 1, 0),
      ledger: ledger({ packAh: 2 }),
    })

    const days = dailyTotals([record], at(2025, 0, 3, 0))

    expect(days).toHaveLength(1)
    expect(days[0].day).toBe(startOfLocalDay(at(2025, 0, 1, 0)))
  })

  it('leaves deepest SOC null on a day whose sessions counted no pack sample', () => {
    const record = sessionRecord({ startedAt: at(2025, 0, 1, 8), ledger: ledger({ solarAh: 4 }) })

    const [day] = dailyTotals([record], at(2025, 0, 3, 0))

    expect(day.deepestSoc).toBeNull()
    expect(day.solarAh).toBe(4)
  })

  it('has nothing to show for an empty archive', () => {
    expect(dailyTotals([], at(2025, 0, 3, 0))).toEqual([])
  })
})
