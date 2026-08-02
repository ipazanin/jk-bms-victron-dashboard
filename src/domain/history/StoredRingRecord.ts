import type { RingRecordRow } from './RingRecordRow'
import type { SolarDayRow } from './SolarDayRow'

/**
 * A row of the `ringRecords` store, whichever device wrote it.
 *
 * One store rather than two: both are a device's own memory read back over the radio, both are keyed
 * `[deviceKey, seq]`, both live outside the sample budget and inside the ring budget, and a device
 * key belongs to exactly one of the two kinds — so no ledger ever holds a mixture. Splitting them
 * would have bought a second prune plan, a second budget and a second sweep to keep in step, for a
 * distinction the discriminator already makes at zero cost.
 */
export type StoredRingRecord = RingRecordRow | SolarDayRow
