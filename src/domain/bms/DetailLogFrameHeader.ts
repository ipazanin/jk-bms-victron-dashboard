/**
 * The paging fields of a type 0x06 frame, read for every one that lands inside a stored-log read
 * rather than only for the ones whose records decode.
 *
 * A whole burst's worth of them off a single run is what shows how the pack chunked its answer.
 * Nothing here says which type of frame it was: the only frames described are stored-log ones, and
 * a header that could only ever read 0x06 would be a constant dressed as a measurement.
 */
export interface DetailLogFrameHeader {
  /**
   * Byte [5]: unidentified. It changes from frame to frame of a burst with no sequence to it, so
   * nothing may order or de-duplicate frames by it. Carried because it is the one header byte whose
   * meaning is still open, and it cannot be studied if it is not surfaced.
   */
  readonly unidentifiedByte: number
  /** Bytes [6..7], uint16 LE: ring index of the first record the frame carries. */
  readonly firstRecordIndex: number
  /** Byte [8]: how many records the frame claims to carry. */
  readonly recordCount: number
}
