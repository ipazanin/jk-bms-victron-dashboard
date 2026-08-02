import type { CalendarDate } from './CalendarDate'
import type { SolarHistoryFetchOutcome } from '../solar/SolarHistoryFetchOutcome'
import type { SolarHistoryTotals } from '../solar/SolarHistoryTotals'
import type { SOLAR_DAY_FORMAT } from './StoredRowFormat'
import type { DeviceKey } from './types'

/**
 * One history sweep of the controller, and what filing it did.
 *
 * Journalled for the reason a stored-log read is: a controller that stops answering the history
 * registers after a firmware update is exactly what a stored history of attempts reveals, and the
 * only evidence about a sweep that came back with nothing is its receipt.
 *
 * The totals record rides along because it is the one part of a sweep that is not a day — lifetime
 * yield, the resettable counter, the extremes since the controller was commissioned, and the day
 * count that bounds the sweep. Keeping it on every receipt turns the journal into a series of those
 * figures across sweeps at no cost, which is the only way this browser will ever see the lifetime
 * counter move.
 */
export interface SolarHistoryReadRow {
  readonly deviceKey: DeviceKey
  readonly observedAt: number
  readonly format: typeof SOLAR_DAY_FORMAT
  readonly outcome: SolarHistoryFetchOutcome
  /**
   * The day this browser believed it was on when the sweep was taken. Every row it filed is dated
   * back from here, so a receipt showing a wrong date explains a whole sweep's worth of wrong days.
   */
  readonly readOnDate: CalendarDate
  readonly totals: SolarHistoryTotals | null
  readonly daysReceived: number
  readonly daysAppended: number
  /** Days whose record changed under a re-read. In practice this is today, and only today. */
  readonly daysRevised: number
  readonly daysUnchanged: number
  /** Registers the controller has not reached yet. They store nothing and are not days. */
  readonly daysUnwritten: number
  /** Days whose stored date disagrees with the one this sweep computed. Reported, never applied. */
  readonly daysRedated: number
  /** Registers answered with a status code instead of a value. Named, because which one is the
   *  whole content of the finding. */
  readonly refusedRegisters: readonly number[]
  readonly notificationBytes: number
  readonly notificationCount: number
  readonly controlNotificationCount: number
  readonly pduCount: number
  readonly unreadableReplyCount: number
  readonly elapsedMs: number
}
