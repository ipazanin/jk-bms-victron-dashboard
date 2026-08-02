import type { SolarHistoryDay } from './SolarHistoryDay'

/**
 * One daily register as a sweep found it: where it was read from, and what it held.
 *
 * The register and the age travel with the record because neither is recoverable from it
 * afterwards. Today is always 0x1050, so a register names a position in the backlog and never a
 * day; the record's own sequence number names the day and says nothing about where it sat. A
 * reading that came back unwritten is kept for the same reason — the controller having nothing at
 * that position is a fact about the sweep, and dropping it would leave a gap indistinguishable
 * from a register the sweep never reached.
 */
export interface SolarHistoryDayReading {
  readonly register: number
  /** 0 is today, 1 yesterday. The index the register was chosen by, carried rather than re-derived. */
  readonly daysAgo: number
  readonly day: SolarHistoryDay
}
