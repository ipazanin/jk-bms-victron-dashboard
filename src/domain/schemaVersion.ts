/**
 * The shape gate both persistence layers share.
 *
 * The remembered snapshot in localStorage and every session row in the Log store the same two
 * decoded shapes — BatterySnapshot and SolarReading. One constant means a build that adds,
 * removes or renames a field on either of them cannot leave the two stores gating on different
 * numbers and drifting apart in silence.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1
