/**
 * Every register this codebase may ask a SmartSolar for, written out one at a time.
 *
 * The list is the safety mechanism, not a description of one. On the 306b tunnel a read and a write
 * are the same frame with one byte changed, over the same register id; 0x1030 sits thirty-one
 * registers below the totals record and is believed to be "clear history". A free integer parameter
 * would put that register one arithmetic slip away from the only copy of the data this whole
 * feature exists to rescue. A frozen tuple of literals puts it out of reach of the type checker,
 * which is a guarantee prose cannot make.
 *
 *   0x104F            the totals record, which carries the day count
 *   0x1050            today — always, so a day changes register at every midnight
 *   0x1051 .. 0x106E  yesterday back thirty days
 *
 * 0x10A0..0x10BE carry per-tracker history on the MPPT-RS. They are absent here deliberately: this
 * is a single-tracker 100/50 and those registers describe a different product's layout.
 */

export const HISTORY_TOTALS_REGISTER = 0x104f

/**
 * Today first, then one register per day of age. The index into this list *is* the age in days,
 * which is why it is a list and not a base plus an offset: the arithmetic that would produce a
 * register is the arithmetic that could produce the wrong one.
 */
export const HISTORY_DAY_REGISTERS = Object.freeze([
  0x1050, 0x1051, 0x1052, 0x1053, 0x1054, 0x1055, 0x1056, 0x1057, 0x1058, 0x1059, 0x105a, 0x105b,
  0x105c, 0x105d, 0x105e, 0x105f, 0x1060, 0x1061, 0x1062, 0x1063, 0x1064, 0x1065, 0x1066, 0x1067,
  0x1068, 0x1069, 0x106a, 0x106b, 0x106c, 0x106d, 0x106e,
] as const)

/** The totals record plus the whole daily backlog, and nothing else is reachable. */
export const SOLAR_HISTORY_REGISTERS = Object.freeze([
  HISTORY_TOTALS_REGISTER,
  ...HISTORY_DAY_REGISTERS,
] as const)

export type SolarHistoryDayRegister = (typeof HISTORY_DAY_REGISTERS)[number]
export type SolarHistoryRegister = (typeof SOLAR_HISTORY_REGISTERS)[number]

export const HISTORY_TODAY_REGISTER: SolarHistoryDayRegister = 0x1050

/** Today plus thirty days back, which is every daily register the controller holds. */
export const MAX_HISTORY_DAYS = HISTORY_DAY_REGISTERS.length

/** The register holding the day `daysAgo` days before today. */
export function historyDayRegister(daysAgo: number): SolarHistoryDayRegister {
  if (!Number.isInteger(daysAgo) || daysAgo < 0 || daysAgo >= MAX_HISTORY_DAYS) {
    throw new Error(`no solar history register for ${daysAgo} days ago`)
  }
  return HISTORY_DAY_REGISTERS[daysAgo]
}
