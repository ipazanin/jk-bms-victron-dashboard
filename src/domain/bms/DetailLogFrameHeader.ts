/**
 * The paging fields at the front of a frame, read for every frame that lands inside a stored-log
 * read rather than only for the ones that decode.
 *
 * On a type 0x06 frame these are the paging header the detail-log layout specifies, and reading a
 * whole dump's worth of them off one run is how the paging scheme gets established instead of
 * guessed at. On any other frame type they are simply the bytes that sit at those offsets, kept so
 * that a reply which is not a detail log still shows what it was.
 */
export interface DetailLogFrameHeader {
  /** Byte [4]: which frame this is. 0x06 is the stored detail log. */
  readonly frameType: number
  /** Byte [5]: the pack's own counter across the frames of one reply. */
  readonly counter: number
  /** Bytes [6..7], uint16 LE: ring index of the first record the frame carries. */
  readonly firstRecordIndex: number
  /** Byte [8]: how many records the frame claims to carry. */
  readonly recordCount: number
}
