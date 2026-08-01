import type { DetailLogFrameHeader } from './DetailLogFrameHeader'
import type { DetailLogOutcome } from './DetailLogOutcome'
import type { DetailLogRecord } from './detailLog'

/**
 * Everything one stored-log read observed — the measurement, not the data model.
 *
 * A read that decoded nothing is still a result worth carrying, so the counts here are populated
 * whatever the outcome. Nothing in this shape is persisted anywhere.
 */
export interface DetailLogTransfer {
  readonly outcome: DetailLogOutcome
  /**
   * Bytes the characteristic delivered inside the request window, counted before the assembler
   * sees them. This is the decisive figure: assembled frames cannot separate a pack that stayed
   * silent from a burst that arrived and was torn up, and this can.
   */
  readonly notificationBytes: number
  /** How many notifications those bytes came in, which says how the reply was chunked. */
  readonly notificationCount: number
  /**
   * Frames of any type that assembled and verified inside the window. What separates a reply the
   * transport tore up, where nothing assembled at all, from a window in which frames arrived and
   * not one of them was a stored log.
   */
  readonly assembledFrameCount: number
  /**
   * One entry per type 0x06 frame that assembled inside the window, in arrival order. Only that
   * type is listed: the pack streams cell-info unprompted throughout every read, so listing every
   * assembled frame would bury the burst's paging under traffic that says nothing about 0xA7.
   */
  readonly frames: readonly DetailLogFrameHeader[]
  /** Records off the type 0x06 frames. Empty unless the outcome is `records-read`. */
  readonly records: readonly DetailLogRecord[]
  /** Wall-clock time from writing the command to the read settling. */
  readonly elapsedMs: number
}
