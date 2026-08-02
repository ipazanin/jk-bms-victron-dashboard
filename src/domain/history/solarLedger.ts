/**
 * Folding a history sweep into the controller's own ledger.
 *
 * This is deliberately not `ringLedger.ts`, and the reason is worth stating because the two problems
 * look alike and are not. The pack's records carry no usable key: the ring index is a position that
 * moved 42 places in four hours, the RTC counter repeats, and adjacent records are byte-identical
 * nine times in one read — so placing a read against the ledger means searching for the shift at
 * which their bytes agree, and everything about that machinery exists to make an unidentifiable
 * record identifiable. A Victron day record identifies itself. It carries a sequence number the
 * controller advances once a day, stepping by exactly one between adjacent registers across the
 * whole captured backlog, and the register it arrived in states its age in days. Running such a
 * record through an alignment search would be answering a question it already answers, and would
 * make a day's identity depend on the bytes beside it — which for today's record, rewritten as the
 * afternoon goes on, is the one thing that changes under a re-read.
 *
 * So a day is matched by its own sequence number, and the match is scoped by date. Neither key does
 * the job alone. The sequence number wraps within a year, so a ledger holding more than a year of
 * days could match a new day onto one twelve months old and overwrite it; the date is computed from
 * this browser's clock, so a host clock a day out would split one day into two. Scoping the match to
 * rows already dated within one backlog's width of the incoming day closes both: the counter cannot
 * wrap inside 31 days, and a clock a day out still lands inside the neighbourhood.
 *
 * Two rules the pack's fold also lives by carry over unchanged. A row's seq is handed out on first
 * sight and never revised. And nothing is invented: a register the controller has not written yet
 * stores nothing at all, because a boat under cover produces recorded days of 0.14 kWh and a
 * fabricated zero would be indistinguishable from one.
 *
 * This module decides; it never stores.
 */

import { calendarDateBefore, calendarDaysBetween } from './calendarDays'
import { MAX_HISTORY_DAYS } from '../solar/SolarHistoryRegister'
import { SOLAR_DAY_FORMAT } from './StoredRowFormat'
import type { RecordedSolarHistoryDay } from '../solar/RecordedSolarHistoryDay'
import type { SolarDayRow } from './SolarDayRow'
import type { SolarHistorySnapshot } from './SolarHistorySnapshot'
import type { SolarMergeOutcome } from './SolarMergeOutcome'

/**
 * How far either side of an incoming day a stored row may sit and still be the same day.
 *
 * One whole backlog: no sweep can carry a day older than this, so a row further out than one backlog
 * from the day being filed is a different day whatever its sequence number says.
 */
export const SAME_DAY_DATE_TOLERANCE_DAYS = MAX_HISTORY_DAYS

/**
 * Places one sweep against the ledger and says which rows to write.
 *
 * Oldest day first, so a ledger opened by one sweep comes out with seq ascending in calendar order —
 * the order it was first seen in, which for a backlog read in one go is the order it happened in.
 * Later sweeps append only what is newer, so the property holds for the life of the ledger.
 *
 * `now` stamps the provenance of the rows this fold creates and revises; the snapshot's own
 * `observedAt` is what the journal row carries.
 */
export function foldSolarHistorySnapshot(
  stored: readonly SolarDayRow[],
  snapshot: SolarHistorySnapshot,
  now: number,
): { readonly rows: readonly SolarDayRow[]; readonly merge: SolarMergeOutcome } {
  const known = [...stored]
  const rows: SolarDayRow[] = []

  let nextSeq = known.reduce((highest, row) => Math.max(highest, row.seq + 1), 0)
  let appended = 0
  let revised = 0
  let unchanged = 0
  let unwritten = 0
  let redated = 0

  const oldestFirst = [...snapshot.days].sort((left, right) => right.daysAgo - left.daysAgo)

  for (const reading of oldestFirst) {
    if (!reading.day.recorded) {
      unwritten += 1
      continue
    }

    const date = calendarDateBefore(snapshot.readOnDate, reading.daysAgo)
    const held = sameDayIn(known, reading.day, date)

    if (held === null) {
      const row: SolarDayRow = {
        deviceKey: snapshot.deviceKey,
        format: SOLAR_DAY_FORMAT,
        seq: nextSeq,
        date,
        day: reading.day,
        firstReadAt: now,
        revisedAt: now,
      }
      nextSeq += 1
      appended += 1
      rows.push(row)
      known.push(row)
      continue
    }

    if (held.date !== date) redated += 1

    if (sameRecordedDay(held.day, reading.day)) {
      unchanged += 1
      continue
    }

    // The date and the seq are the row's identity and survive the revision; only what the controller
    // said about the day changes, which for today's record it does all afternoon.
    const revisedRow: SolarDayRow = { ...held, day: reading.day, revisedAt: now }
    revised += 1
    rows.push(revisedRow)
    known[known.indexOf(held)] = revisedRow
  }

  return { rows, merge: { appended, revised, unchanged, unwritten, redated } }
}

/**
 * The stored row holding the same day, or null.
 *
 * The sequence number decides and the date bounds where it is allowed to decide, for the reasons the
 * module header sets out. A day whose stored row sits further away than one backlog is a different
 * day that happens to share a counter twelve months later.
 */
function sameDayIn(
  rows: readonly SolarDayRow[],
  day: RecordedSolarHistoryDay,
  date: string,
): SolarDayRow | null {
  for (const row of rows) {
    if (row.day.daySequenceNumber !== day.daySequenceNumber) continue
    if (Math.abs(calendarDaysBetween(row.date, date)) > SAME_DAY_DATE_TOLERANCE_DAYS) continue
    return row
  }
  return null
}

/**
 * Whether two readings of one day say the same thing.
 *
 * Field by field rather than through a serialisation: `errors` is a fixed four-element tuple and
 * `consumedKwh` is null on this product, and both of those survive a hand-written comparison and
 * neither survives an assumption about key order.
 */
export function sameRecordedDay(
  left: RecordedSolarHistoryDay,
  right: RecordedSolarHistoryDay,
): boolean {
  return (
    left.daySequenceNumber === right.daySequenceNumber &&
    left.yieldKwh === right.yieldKwh &&
    left.consumedKwh === right.consumedKwh &&
    left.maxBatteryVoltage === right.maxBatteryVoltage &&
    left.minBatteryVoltage === right.minBatteryVoltage &&
    left.errorDatabase === right.errorDatabase &&
    left.errors.every((code, position) => code === right.errors[position]) &&
    left.minutesInBulk === right.minutesInBulk &&
    left.minutesInAbsorption === right.minutesInAbsorption &&
    left.minutesInFloat === right.minutesInFloat &&
    left.maxPvPower === right.maxPvPower &&
    left.maxBatteryCurrent === right.maxBatteryCurrent &&
    left.maxPvVoltage === right.maxPvVoltage
  )
}
