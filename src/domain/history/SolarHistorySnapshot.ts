import type { CalendarDate } from './CalendarDate'
import type { SolarHistoryDayReading } from '../solar/SolarHistoryDayReading'
import type { SolarHistoryFetchOutcome } from '../solar/SolarHistoryFetchOutcome'
import type { SolarHistoryTotals } from '../solar/SolarHistoryTotals'
import type { DeviceKey } from './types'

/**
 * One history sweep as the archive takes it: what every register reported, and the day the sweep was
 * taken on.
 *
 * `readOnDate` is the only clock in it, and it is a calendar date rather than an instant on purpose.
 * A day record says how many days ago it is and nothing else, so dating the backlog needs today's
 * date and no other fact about time — no zone, no offset, no correction. Resolving it belongs to
 * whoever performed the sweep, where reading the host zone is a legitimate statement about where the
 * boat is being browsed from; every fold downstream then works from what the sweep was stamped with.
 *
 * The transport figures ride along whatever the outcome, for the same reason a stored-log read's do:
 * the receipt is the only evidence about a sweep that came back with no day at all, and that is the
 * sweep most worth keeping.
 */
export interface SolarHistorySnapshot {
  readonly deviceKey: DeviceKey
  readonly observedAt: number
  readonly readOnDate: CalendarDate
  readonly outcome: SolarHistoryFetchOutcome
  /** Null unless the totals register answered with a payload this build could read. */
  readonly totals: SolarHistoryTotals | null
  /** Every daily register the sweep reached, each carrying the age it was read at. */
  readonly days: readonly SolarHistoryDayReading[]
  /** Everything the receipt needs that is not a day. */
  readonly transport: {
    readonly refusedRegisters: readonly number[]
    readonly notificationBytes: number
    readonly notificationCount: number
    readonly controlNotificationCount: number
    readonly pduCount: number
    readonly unreadableReplyCount: number
    readonly elapsedMs: number
  }
}
