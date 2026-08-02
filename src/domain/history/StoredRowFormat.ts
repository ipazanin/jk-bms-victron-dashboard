/**
 * Which device wrote a row the ring stores hold.
 *
 * Two devices keep history of their own and the archive files both in the same two stores, keyed by
 * device. The pack writes 24-byte ring records on its own RTC counter; the controller writes 34-byte
 * day records on the calendar. Nothing about the two decodes alike, so a row has to say which it is.
 *
 * The pack's format is the one that is NOT written down. Every row already on disk was written
 * before this discriminator existed, and there are tens of thousands of them under a database whose
 * upgrades may only add — so absence has to mean "pack record" whatever else is decided. Given that
 * rule is unavoidable, writing the field on new pack rows too would buy nothing and cost a second
 * representation of the same fact: readers would still have to apply the absence rule, and the store
 * would hold two shapes for one format. So `RingRecordRow` declares the field absent, the type
 * checker keeps it that way, and `formatOfStoredRow` is the single place the default is stated.
 */

/** A pack ring record. Never stored in a row — this is what absence resolves to. */
export const PACK_RECORD_FORMAT = 'pack-record'

/** A Victron day record. Stored verbatim on every such row, because it is the exception. */
export const SOLAR_DAY_FORMAT = 'solar-day'

export type StoredRowFormat = typeof PACK_RECORD_FORMAT | typeof SOLAR_DAY_FORMAT
