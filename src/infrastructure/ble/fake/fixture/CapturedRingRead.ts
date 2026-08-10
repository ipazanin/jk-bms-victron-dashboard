/**
 * One burst of the pack's stored log, kept as the frames arrived.
 *
 * Hex and nothing else: no record split, no counts, no outcome. Those are what the real transport
 * derives, and the fake makes it derive them, so a receipt on screen cannot say something the frames
 * do not support.
 */
export interface CapturedRingRead {
  /**
   * When the burst was read, in epoch milliseconds. The records are timed on the pack's own RTC
   * counter and only become dates when a read instant is put against them, so this is not decoration.
   */
  readonly observedAt: number
  /** Whole 0x06 frames, 300 bytes each as hex, in the order the burst delivered them. */
  readonly frames: readonly string[]
}
