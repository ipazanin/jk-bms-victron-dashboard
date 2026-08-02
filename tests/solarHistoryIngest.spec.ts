/**
 * What the archive takes from a finished sweep, and when it is worth taking another.
 *
 * The staleness rule is measured against a receipt and never against a stored day's own date, and
 * these cases are what hold that apart: a receipt is a reading of this browser's clock, a day is a
 * calendar entry the controller wrote, and comparing the two would put the calendar's uncertainty
 * inside a decision about radio time.
 */

import { describe, expect, it } from 'vitest'

import {
  SOLAR_HISTORY_STALE_AFTER_MS,
  readOnDateFor,
  solarHistoryDaysBehind,
  solarHistoryReadIsDue,
  solarHistorySnapshotOf,
} from '../src/application/history/solarHistoryIngest'
import { foldSolarHistorySnapshot } from '../src/domain/history/solarLedger'
import { SOLAR_DAY_FORMAT } from '../src/domain/history/StoredRowFormat'
import { MAX_HISTORY_DAYS } from '../src/domain/solar/SolarHistoryRegister'
import type { SolarHistoryReadRow } from '../src/domain/history/SolarHistoryReadRow'
import type { SolarHistoryTransfer } from '../src/domain/solar/SolarHistoryTransfer'
import type { StoredRingLedger } from '../src/application/history/port'
import {
  CAPTURED_DAYS,
  CAPTURE_OBSERVED_AT,
  CAPTURE_READ_ON_DATE,
  SOLAR_DEVICE_KEY,
  capturedDayReadings,
  capturedSolarSnapshot,
  capturedTotals,
} from './support/solarHistoryFixture'

const SWEPT_AT = CAPTURE_OBSERVED_AT

function transfer(overrides: Partial<SolarHistoryTransfer> = {}): SolarHistoryTransfer {
  return {
    outcome: 'days-read',
    totals: capturedTotals,
    days: capturedDayReadings(),
    refusedRegisters: [],
    notificationBytes: 1_984,
    notificationCount: 62,
    controlNotificationCount: 9,
    pduCount: 32,
    unreadableReplyCount: 0,
    elapsedMs: 6_400,
    ...overrides,
  }
}

function receipt(overrides: Partial<SolarHistoryReadRow> = {}): SolarHistoryReadRow {
  return {
    deviceKey: SOLAR_DEVICE_KEY,
    observedAt: SWEPT_AT,
    format: SOLAR_DAY_FORMAT,
    outcome: 'days-read',
    readOnDate: CAPTURE_READ_ON_DATE,
    totals: capturedTotals,
    daysReceived: CAPTURED_DAYS,
    daysAppended: CAPTURED_DAYS,
    daysRevised: 0,
    daysUnchanged: 0,
    daysUnwritten: 0,
    daysRedated: 0,
    refusedRegisters: [],
    notificationBytes: 1_984,
    notificationCount: 62,
    controlNotificationCount: 9,
    pduCount: 32,
    unreadableReplyCount: 0,
    elapsedMs: 6_400,
    ...overrides,
  }
}

function ledgerOf(
  reads: readonly SolarHistoryReadRow[],
  days: number = CAPTURED_DAYS,
): StoredRingLedger {
  return {
    deviceKey: SOLAR_DEVICE_KEY,
    records: [],
    solarDays: foldSolarHistorySnapshot([], capturedSolarSnapshot(), SWEPT_AT).rows.slice(0, days),
    reads: [],
    solarReads: reads,
    device: null,
    retainedFromSeq: null,
  }
}

describe('taking a sweep', () => {
  it('carries the transport figures whatever the sweep established', () => {
    // The receipt is the only evidence about a sweep that came back with nothing, which is exactly
    // the sweep worth keeping.
    const snapshot = solarHistorySnapshotOf(
      transfer({ outcome: 'refused', totals: null, days: [], refusedRegisters: [0x104f] }),
      SOLAR_DEVICE_KEY,
      SWEPT_AT,
      CAPTURE_READ_ON_DATE,
    )

    expect(snapshot.outcome).toBe('refused')
    expect(snapshot.days).toEqual([])
    expect(snapshot.totals).toBeNull()
    expect(snapshot.transport.refusedRegisters).toEqual([0x104f])
    expect(snapshot.transport.notificationBytes).toBe(1_984)
    expect(snapshot.transport.elapsedMs).toBe(6_400)
  })

  it('adds the day it was taken on and no other reading of the clock', () => {
    const snapshot = solarHistorySnapshotOf(
      transfer(),
      SOLAR_DEVICE_KEY,
      SWEPT_AT,
      CAPTURE_READ_ON_DATE,
    )

    expect(snapshot.deviceKey).toBe(SOLAR_DEVICE_KEY)
    expect(snapshot.observedAt).toBe(SWEPT_AT)
    expect(snapshot.readOnDate).toBe(CAPTURE_READ_ON_DATE)
    expect(snapshot.days).toHaveLength(CAPTURED_DAYS)
  })

  it('reads the sweep’s own date off the host clock, at the edge and nowhere else', () => {
    const noon = new Date(2026, 6, 4, 12, 0, 0).getTime()

    expect(readOnDateFor(noon)).toBe('2026-07-04')
  })
})

describe('deciding to sweep again', () => {
  it('is due when this browser has never filed anything for the controller', () => {
    expect(solarHistoryReadIsDue(null, SWEPT_AT)).toBe(true)
  })

  it('is due when every sweep on record came back with no day', () => {
    const barren = ledgerOf([receipt({ outcome: 'no-answer', daysReceived: 0, daysAppended: 0 })], 0)

    expect(solarHistoryReadIsDue(barren, SWEPT_AT + 1_000)).toBe(true)
  })

  it('is not due while the newest answered sweep is inside the window', () => {
    const held = ledgerOf([receipt()])

    expect(solarHistoryReadIsDue(held, SWEPT_AT + SOLAR_HISTORY_STALE_AFTER_MS - 1)).toBe(false)
    expect(solarHistoryReadIsDue(held, SWEPT_AT + SOLAR_HISTORY_STALE_AFTER_MS)).toBe(true)
  })

  it('counts what the ledger is missing against what the controller says it holds', () => {
    const behind = ledgerOf([receipt()], 4)

    expect(solarHistoryDaysBehind(behind)).toBe(capturedTotals.daysAvailable - 4)
    expect(solarHistoryDaysBehind(ledgerOf([receipt()]))).toBe(0)
  })

  it('is behind by the whole backlog and never by more, having never swept', () => {
    // A browser away for a year is not a year behind. It is behind by everything the controller
    // still remembers, which is thirty-one days.
    expect(solarHistoryDaysBehind(null)).toBe(MAX_HISTORY_DAYS)
  })
})
