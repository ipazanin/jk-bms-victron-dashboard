import type { DeviceKey } from './types'

/**
 * One record out of the pack's own ring, as the pack wrote it.
 *
 * The 24 bytes are stored verbatim rather than decoded into fields. That keeps the row exactly
 * lossless at the wire scale — the rule `PackChunk` already follows — lets the merge compare two
 * reads byte for byte, and lets the reader reuse the decoder in `detailLog.ts` instead of growing a
 * second one. A correction to any decoded field then reinterprets every stored row for free.
 *
 * No resolved timestamp is stored. `recordedAt` is a function of a zone the pack never states and of
 * a clock error this browser only ever bounds; storing it would bake today's guess into the archive.
 *
 * The store it lives in also holds the controller's day records, and this row is the format that
 * says nothing about itself: every pack row written before that was true is still on disk, so
 * absence has to mean "pack record" whatever else is decided. `format` is therefore declared present
 * and undefined rather than left off — the type checker then refuses a pack row that carries one,
 * and `storedRows.ts` states the default in the one place it is read.
 */
export interface RingRecordRow {
  readonly deviceKey: DeviceKey
  /** Never written. See `StoredRowFormat`. */
  readonly format?: undefined
  /** Monotone per device, assigned when the record is first seen. A row's seq never changes. */
  readonly seq: number
  /** The pack's RTC counter, seconds. Invariant: equals the little-endian uint32 at bytes[0..3].
   *  Denormalised off the bytes so a range fold can order and window without decoding every row. */
  readonly packClockSeconds: number
  readonly bytes: Uint8Array
  /** Wall clock of the read that first stored this row. Provenance; never revised. */
  readonly firstReadAt: number
  /** True when this row's predecessor is missing: the ring had already dropped it, or pruning cut
   *  the head here. Exactly one row per contiguity break carries it. */
  readonly followsGap: boolean
}
