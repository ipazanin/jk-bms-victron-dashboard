import type { RecentChargerErrors } from './RecentChargerErrors'

/** The lifetime record that sits alongside the daily backlog, in register 0x104F. */
export interface SolarHistoryTotals {
  readonly errorDatabase: number
  readonly errors: RecentChargerErrors
  /** Yield since the owner last reset the counter in VictronConnect. */
  readonly resettableYieldKwh: number
  /** Yield over the controller's whole life, which nothing resets. */
  readonly systemYieldKwh: number
  readonly maxPvVoltage: number
  readonly maxBatteryVoltage: number
  /**
   * How many daily registers hold data. This is what bounds a fetch: read it first and the sweep
   * stops where the controller's own memory does, without polling the whole backlog blindly and
   * without asking a capability register whether history exists at all.
   */
  readonly daysAvailable: number
  /** Null on firmware that stops the record after the day count. */
  readonly minBatteryVoltage: number | null
}
