/**
 * One daily register's answer, as the controller sent it.
 *
 * The register travels with the bytes because it is the only thing that says how old the day is:
 * the record carries a sequence number and a yield, never a date, and its age is its position in the
 * register list. Separating the two would leave 34 bytes that cannot be placed on a calendar.
 */
export interface SolarHistoryDayPayload {
  /** 0x1050 for today, one register per day of age after it. */
  readonly register: number
  /** The record's payload as hex, without the tunnel framing that carried it. */
  readonly bytes: string
}
