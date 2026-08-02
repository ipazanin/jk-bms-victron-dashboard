import type { RingReadRow } from './RingReadRow'
import type { SolarHistoryReadRow } from './SolarHistoryReadRow'

/**
 * A row of the `ringReads` store, whichever device the read was against.
 *
 * Both are receipts keyed `[deviceKey, observedAt]`, both are capped per device, and both exist so a
 * read that came back with nothing still leaves evidence. What they hold has almost nothing in
 * common, which is why this is a union and not a widened row full of fields one side always leaves
 * null.
 */
export type StoredRingRead = RingReadRow | SolarHistoryReadRow
