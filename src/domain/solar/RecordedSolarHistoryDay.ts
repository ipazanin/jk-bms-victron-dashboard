import type { RecentChargerErrors } from './RecentChargerErrors'

/**
 * One day the controller has stored. Volts, amps, watts and kilowatt-hours; durations in minutes,
 * which is the unit the register itself counts in.
 */
export interface RecordedSolarHistoryDay {
  readonly recorded: true
  /**
   * What identifies the day, and the only thing that does.
   *
   * The register a day sits in is a position, not a name: today is always 0x1050, so every stored
   * day shifts one register along at midnight. The sequence number travels with the record instead
   * — it advances by one per day and steps by exactly one between adjacent registers across the
   * whole captured backlog — so two reads days apart agree on which day is which only through this.
   * It wraps within a year, so it orders days inside one window and says nothing across two.
   */
  readonly daySequenceNumber: number
  readonly yieldKwh: number
  /** Null on a controller without a load output, which is what this boat's 100/50 reports. */
  readonly consumedKwh: number | null
  readonly maxBatteryVoltage: number
  readonly minBatteryVoltage: number
  readonly errorDatabase: number
  readonly errors: RecentChargerErrors
  readonly minutesInBulk: number
  readonly minutesInAbsorption: number
  readonly minutesInFloat: number
  readonly maxPvPower: number
  readonly maxBatteryCurrent: number
  readonly maxPvVoltage: number
}
