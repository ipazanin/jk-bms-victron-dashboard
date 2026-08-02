import type { CalendarDate } from './CalendarDate'
import type { RecordedSolarHistoryDay } from '../solar/RecordedSolarHistoryDay'
import type { SOLAR_DAY_FORMAT } from './StoredRowFormat'
import type { DeviceKey } from './types'

/**
 * One day out of the controller's own history, as the archive holds it.
 *
 * The record is stored decoded, where a pack ring record is stored as bytes. The difference is not
 * an inconsistency but the reason the two exist: the pack's merge compares two reads byte for byte
 * because nothing else about a ring record is unique, and its layout is settled on inference — so
 * the bytes are kept and a correction reinterprets every stored row. A Victron day is identified by
 * a sequence number the controller itself writes, so nothing here ever compares payloads to place
 * one; and the layout is settled field by field against VictronConnect's own export of the same
 * registers, 232 comparisons with no divergence. Keeping thirteen named scalars is what that
 * evidence buys.
 *
 * `date` is the only field the controller did not supply, and the only one this browser fixes.
 */
export interface SolarDayRow {
  readonly deviceKey: DeviceKey
  /** Present on every solar row. Its absence is what says a row is a pack record instead. */
  readonly format: typeof SOLAR_DAY_FORMAT
  /** Monotone per device, assigned when the day is first seen. A row's seq never changes. */
  readonly seq: number
  /**
   * Which day this is, on the wall calendar.
   *
   * The record carries no date: today is always register 0x1050 and a day walks one register along
   * at every midnight, so the date is the read's own date minus the register's age in days. Fixed at
   * first sight and never revised — a later read computing a different date for the same day is a
   * disagreement to report rather than a correction to apply, because the two reads cannot both be
   * right and there is nothing in either to say which one is.
   */
  readonly date: CalendarDate
  /**
   * The controller's record. `day.daySequenceNumber` is what identifies the day across two reads:
   * it advances by one per day and steps by exactly one between adjacent registers, so a day keeps
   * it as it ages out of one register into the next. It wraps within a year, which is why it
   * identifies a day only among rows already dated nearby.
   */
  readonly day: RecordedSolarHistoryDay
  /** Wall clock of the read that first stored this day. Provenance; never revised. */
  readonly firstReadAt: number
  /**
   * Wall clock of the read this record came from. Equal to `firstReadAt` until a re-read replaces
   * it, which happens for one day only: today's record is still being written, and a controller read
   * twice in an afternoon reports two different amounts of it.
   */
  readonly revisedAt: number
}
