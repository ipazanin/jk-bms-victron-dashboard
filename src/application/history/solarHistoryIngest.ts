/**
 * What the history sweep hands the archive, and when it is worth going and getting one.
 *
 * A sweep is a window onto the controller's own memory, and the archive takes what the registers
 * reported rather than a summary of it. Everything here is a pure function over a finished transfer:
 * nothing stores, and the one fact about time it adds is the calendar date the sweep happened on —
 * which is the whole of what dating a backlog needs, because a day record states its age in days and
 * nothing else about when it was.
 *
 * That date is a parameter rather than a reading of the host clock taken here. The caller is the
 * connection, which knows when it ran; a module that reached for `Date.now()` would make every
 * snapshot untestable and would put a clock inside a fold.
 */

import { calendarDateNow } from '../../domain/history/calendarDays'
import { MAX_HISTORY_DAYS } from '../../domain/solar/SolarHistoryRegister'
import type { CalendarDate } from '../../domain/history/CalendarDate'
import type { SolarHistorySnapshot } from '../../domain/history/SolarHistorySnapshot'
import type { SolarHistoryTransfer } from '../../domain/solar/SolarHistoryTransfer'
import type { DeviceKey } from '../../domain/history/types'
import type { StoredRingLedger } from './port'

/**
 * How long the controller's stored history may go unswept before a connection fetches it by itself.
 *
 * A day, against a backlog that holds thirty-one: far enough inside the margin that a boat visited
 * monthly loses nothing, and far enough outside a day that two connections on the same afternoon do
 * not both take the radio. The controller accepts exactly one BLE client at a time and changes its
 * advertising while connected, which silently interrupts the Instant Readout feed the dashboard
 * already runs on — so a sweep is not a thing to repeat for the sake of it.
 */
export const SOLAR_HISTORY_STALE_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * One sweep as the archive takes it.
 *
 * The transport figures ride along whatever the outcome, because a sweep that came back with no day
 * at all is exactly the one whose receipt is the only evidence it ever happened.
 */
export function solarHistorySnapshotOf(
  transfer: SolarHistoryTransfer,
  deviceKey: DeviceKey,
  observedAt: number,
  readOnDate: CalendarDate,
): SolarHistorySnapshot {
  return {
    deviceKey,
    observedAt,
    readOnDate,
    outcome: transfer.outcome,
    totals: transfer.totals,
    days: transfer.days,
    transport: {
      refusedRegisters: transfer.refusedRegisters,
      notificationBytes: transfer.notificationBytes,
      notificationCount: transfer.notificationCount,
      controlNotificationCount: transfer.controlNotificationCount,
      pduCount: transfer.pduCount,
      unreadableReplyCount: transfer.unreadableReplyCount,
      elapsedMs: transfer.elapsedMs,
    },
  }
}

/** The date a sweep taken at `observedAt` files its days back from, in the host's own zone. */
export function readOnDateFor(observedAt: number): CalendarDate {
  return calendarDateNow(observedAt)
}

/**
 * Whether this browser's copy of the controller's backlog has fallen far enough behind to be worth
 * another sweep.
 *
 * Measured against the newest sweep that came back with a day, and never against a stored day's own
 * date. A sweep always carries today, so the newest stored day is at most one day older than the
 * sweep that filed it — which makes the receipt's `observedAt`, a reading of this browser's clock,
 * the same quantity as the backlog's age without borrowing the calendar's uncertainty to state it.
 *
 * A ledger nothing has ever been filed under, and one whose sweeps all came back empty, are both
 * due: there is nothing here that the controller has not got.
 */
export function solarHistoryReadIsDue(ledger: StoredRingLedger | null, now: number): boolean {
  const answered = ledger?.solarReads.find((read) => read.daysReceived > 0)
  if (answered === undefined) return true
  return now - answered.observedAt >= SOLAR_HISTORY_STALE_AFTER_MS
}

/**
 * How many days the ledger is missing off the end of the controller's backlog, given what the newest
 * sweep said it holds. Zero when this browser is level with it.
 *
 * Bounded by the backlog rather than by the ledger: a browser that has been away for a year is not
 * behind by a year, it is behind by everything the controller still remembers.
 */
export function solarHistoryDaysBehind(ledger: StoredRingLedger | null): number {
  const held = ledger?.solarDays.length ?? 0
  const available = ledger?.solarReads[0]?.totals?.daysAvailable ?? MAX_HISTORY_DAYS
  return Math.max(0, Math.min(available, MAX_HISTORY_DAYS) - held)
}
