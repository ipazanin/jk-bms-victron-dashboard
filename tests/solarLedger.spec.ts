/**
 * Folding the controller's own history into a ledger.
 *
 * Every payload here is the one a SmartSolar MPPT 100/50 actually answered with, and every date is
 * VictronConnect's, off its own export of the same registers. So the dating case is a real check:
 * the fold is handed the capture with nothing but the day the sweep ran on, and what it produces is
 * compared against a date somebody else's software printed for the same record.
 *
 * The cases that matter are the ones a second sweep creates, because a day is not a fixed thing. It
 * moves one register along at every midnight, and the newest one is still being written all
 * afternoon — so "the same day" has to survive both, and "a different day" has to survive a sequence
 * number that comes round again a year later.
 */

import { describe, expect, it } from 'vitest'

import { calendarDateBefore } from '../src/domain/history/calendarDays'
import { SAME_DAY_DATE_TOLERANCE_DAYS, foldSolarHistorySnapshot } from '../src/domain/history/solarLedger'
import { PACK_RECORD_FORMAT, SOLAR_DAY_FORMAT } from '../src/domain/history/StoredRowFormat'
import {
  formatOfStoredRow,
  packRecordsIn,
  solarDaysIn,
} from '../src/domain/history/storedRows'
import type { SolarDayRow } from '../src/domain/history/SolarDayRow'
import { ringRecordRow } from './support/samples'
import {
  CAPTURED_DAYS,
  CAPTURE_READ_ON_DATE,
  SOLAR_DEVICE_KEY,
  capturedDayBytes,
  capturedSolarSnapshot,
  dayReading,
  decodedSequence,
  laterSolarSnapshot,
  unwrittenDayBytes,
  withDaySequenceNumber,
  withYield,
} from './support/solarHistoryFixture'
import wire from './fixtures/solarHistoryWire.json'

const FILED_AT = Date.UTC(2026, 7, 2, 9, 15)
const HUNDREDTHS_PER_KWH = 100
const WATT_HOURS_PER_KWH = 1_000

/** The whole capture folded into an empty ledger, which is where most cases start. */
function openedLedger(): readonly SolarDayRow[] {
  return foldSolarHistorySnapshot([], capturedSolarSnapshot(), FILED_AT).rows
}

function rowOn(rows: readonly SolarDayRow[], date: string): SolarDayRow {
  const found = rows.find((row) => row.date === date)
  if (found === undefined) throw new Error(`no row on ${date}`)
  return found
}

describe('what a stored row says it is', () => {
  it('reads a row carrying no format as a pack record', () => {
    // Every pack row on disk was written before the discriminator existed, and an upgrade may only
    // add. Absence is the format, permanently.
    const legacy = ringRecordRow()

    expect('format' in legacy).toBe(false)
    expect(formatOfStoredRow(legacy)).toBe(PACK_RECORD_FORMAT)
  })

  it('reads a row carrying the solar format as a day record', () => {
    const [day] = openedLedger()

    expect(day.format).toBe(SOLAR_DAY_FORMAT)
    expect(formatOfStoredRow(day)).toBe(SOLAR_DAY_FORMAT)
  })

  it('separates one store’s rows without consulting the device key', () => {
    const mixed = [ringRecordRow(), ...openedLedger()]

    expect(packRecordsIn(mixed)).toHaveLength(1)
    expect(solarDaysIn(mixed)).toHaveLength(CAPTURED_DAYS)
  })
})

describe('opening a ledger from one sweep', () => {
  it('files every written register as its own day', () => {
    const { rows, merge } = foldSolarHistorySnapshot([], capturedSolarSnapshot(), FILED_AT)

    expect(rows).toHaveLength(CAPTURED_DAYS)
    expect(merge).toEqual({
      appended: CAPTURED_DAYS,
      revised: 0,
      unchanged: 0,
      unwritten: 0,
      redated: 0,
    })
  })

  it('dates the backlog exactly as the vendor’s own export dates it', () => {
    // The fold is given one fact about time — the day the sweep ran on — and nothing else. Every
    // date below is VictronConnect's, printed by VictronConnect for the same record.
    const rows = openedLedger()

    for (const exported of wire.expectedFromVendorExport) {
      const row = rowOn(rows, exported.date)
      expect(row.day.yieldKwh * WATT_HOURS_PER_KWH).toBeCloseTo(exported.yieldWh, 6)
      expect(row.day.maxPvPower).toBe(exported.maxPvPowerW)
      expect(row.day.minutesInFloat).toBe(exported.minutesInFloat)
    }
  })

  it('hands out seq oldest day first, so write order is calendar order', () => {
    const rows = openedLedger()

    expect(rows.map((row) => row.seq)).toEqual(rows.map((_row, position) => position))
    const dates = rows.map((row) => row.date)
    expect([...dates].sort()).toEqual(dates)
    expect(rows[rows.length - 1].date).toBe(CAPTURE_READ_ON_DATE)
  })

  it('stamps every row with the sweep that first stored it', () => {
    const rows = openedLedger()

    for (const row of rows) {
      expect(row.deviceKey).toBe(SOLAR_DEVICE_KEY)
      expect(row.firstReadAt).toBe(FILED_AT)
      expect(row.revisedAt).toBe(FILED_AT)
    }
  })

  it('stores nothing at all for a register the controller has not written', () => {
    // A recorded day of zero yield is a different thing — the capture holds days down to 0.14 kWh —
    // so an unwritten register may never contribute a row a chart would draw as a flat zero.
    const swept = capturedSolarSnapshot({
      days: [dayReading(0, unwrittenDayBytes(0)), dayReading(1)],
    })

    const { rows, merge } = foldSolarHistorySnapshot([], swept, FILED_AT)

    expect(rows).toHaveLength(1)
    expect(merge.unwritten).toBe(1)
    expect(merge.appended).toBe(1)
  })
})

describe('sweeping the same controller again', () => {
  it('recognises every day it already holds, and writes nothing', () => {
    const stored = openedLedger()

    const { rows, merge } = foldSolarHistorySnapshot(
      stored,
      capturedSolarSnapshot({ observedAt: FILED_AT + 3_600_000 }),
      FILED_AT + 3_600_000,
    )

    expect(rows).toEqual([])
    expect(merge.unchanged).toBe(CAPTURED_DAYS)
    expect(merge.appended).toBe(0)
    expect(merge.revised).toBe(0)
  })

  it('keeps a day’s seq and date as it ages one register along', () => {
    // The register is a position, not a name: yesterday's record is read from 0x1051 today and from
    // 0x1052 tomorrow. Only the sequence number travels with the day.
    const stored = openedLedger()
    const wasToday = rowOn(stored, CAPTURE_READ_ON_DATE)

    const { rows, merge } = foldSolarHistorySnapshot(stored, laterSolarSnapshot(1), FILED_AT + 86_400_000)

    expect(merge.appended).toBe(1)
    expect(merge.unchanged).toBe(CAPTURED_DAYS - 1)
    expect(merge.redated).toBe(0)
    expect(rows[0].date).toBe(calendarDateBefore(CAPTURE_READ_ON_DATE, -1))
    expect(rows[0].seq).toBe(CAPTURED_DAYS)
    // The row it used to be is untouched: same seq, same date, nothing rewritten.
    expect(rowOn(stored, CAPTURE_READ_ON_DATE)).toEqual(wasToday)
  })

  it('replaces today’s record in place while the day is still being written', () => {
    const stored = openedLedger()
    const held = rowOn(stored, CAPTURE_READ_ON_DATE)
    const grownYield = held.day.yieldKwh * HUNDREDTHS_PER_KWH + 40
    const laterInTheDay = FILED_AT + 4 * 3_600_000

    const { rows, merge } = foldSolarHistorySnapshot(
      stored,
      capturedSolarSnapshot({
        observedAt: laterInTheDay,
        days: [dayReading(0, withYield(capturedDayBytes(0), grownYield))],
      }),
      laterInTheDay,
    )

    expect(merge).toEqual({ appended: 0, revised: 1, unchanged: 0, unwritten: 0, redated: 0 })
    expect(rows).toHaveLength(1)
    expect(rows[0].seq).toBe(held.seq)
    expect(rows[0].date).toBe(held.date)
    expect(rows[0].firstReadAt).toBe(held.firstReadAt)
    expect(rows[0].revisedAt).toBe(laterInTheDay)
    expect(rows[0].day.yieldKwh).toBeCloseTo(grownYield / HUNDREDTHS_PER_KWH, 6)
  })

  it('reports a disagreement about a day’s date and keeps the date it filed', () => {
    // A host clock a day out re-dates a whole sweep. The stored date stands — the two reads cannot
    // both be right and there is nothing in either to say which one is — and the receipt says so.
    const stored = openedLedger()

    const { rows, merge } = foldSolarHistorySnapshot(
      stored,
      capturedSolarSnapshot({ readOnDate: calendarDateBefore(CAPTURE_READ_ON_DATE, -1) }),
      FILED_AT + 86_400_000,
    )

    expect(merge.redated).toBe(CAPTURED_DAYS)
    expect(merge.appended).toBe(0)
    expect(rows).toEqual([])
    expect(rowOn(stored, CAPTURE_READ_ON_DATE).date).toBe(CAPTURE_READ_ON_DATE)
  })

  it('files a day whose sequence number has come round again as a new day', () => {
    // The counter wraps within a year. Matching on it alone would let a day twelve months later
    // overwrite the only copy of an old one, which is the data loss this whole feature exists to
    // prevent.
    const stored = openedLedger()
    const aYearOn = calendarDateBefore(CAPTURE_READ_ON_DATE, -(SAME_DAY_DATE_TOLERANCE_DAYS + 1))

    const { rows, merge } = foldSolarHistorySnapshot(
      stored,
      capturedSolarSnapshot({
        readOnDate: aYearOn,
        days: [dayReading(0, withDaySequenceNumber(capturedDayBytes(0), decodedSequence(0)))],
      }),
      FILED_AT,
    )

    expect(merge.appended).toBe(1)
    expect(merge.revised).toBe(0)
    expect(rows[0].date).toBe(aYearOn)
    expect(rows[0].seq).toBe(CAPTURED_DAYS)
  })

  it('hands out a seq above everything the ledger ever held', () => {
    const trimmed = openedLedger().slice(-4)

    const { rows } = foldSolarHistorySnapshot(trimmed, laterSolarSnapshot(1), FILED_AT + 86_400_000)

    expect(rows[0].seq).toBe(CAPTURED_DAYS)
  })
})
