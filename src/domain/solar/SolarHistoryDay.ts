import type { RecordedSolarHistoryDay } from './RecordedSolarHistoryDay'
import type { UnwrittenSolarHistoryDay } from './UnwrittenSolarHistoryDay'

/**
 * What a daily history register holds: a day, or the fact that no day has been written there.
 *
 * Discriminated on `recorded` so a caller cannot read a yield off a register the controller never
 * filled in without first saying which of the two it is holding.
 */
export type SolarHistoryDay = RecordedSolarHistoryDay | UnwrittenSolarHistoryDay
