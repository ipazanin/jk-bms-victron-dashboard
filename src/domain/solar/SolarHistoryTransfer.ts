import type { SolarHistoryDayReading } from './SolarHistoryDayReading'
import type { SolarHistoryFetchOutcome } from './SolarHistoryFetchOutcome'
import type { SolarHistoryTotals } from './SolarHistoryTotals'

/**
 * Everything one sweep of the controller's stored history observed — the measurement, not just the
 * data.
 *
 * A sweep that came back with nothing is still a result, so every count here is populated whatever
 * the outcome. That is what makes the failures readable: a controller that stayed silent, one whose
 * replies the link tore up, and one that answered a status code instead of a record are three
 * different findings, and the counts are the only thing that tells them apart after the session has
 * been closed.
 */
export interface SolarHistoryTransfer {
  readonly outcome: SolarHistoryFetchOutcome
  /** Null unless the totals register answered with a payload this build could read. */
  readonly totals: SolarHistoryTotals | null
  /** Newest first, because the sweep walks outward from today. */
  readonly days: readonly SolarHistoryDayReading[]
  /**
   * Registers the controller answered for without a value. Named rather than counted: which
   * register was refused is the whole content of the finding.
   */
  readonly refusedRegisters: readonly number[]
  /**
   * Bytes the command and bulk characteristics delivered from the first read request onward,
   * counted before the reassembler saw them. Session-open chatter is not in here — the question
   * this figure answers is whether the controller said anything about the registers asked for.
   */
  readonly notificationBytes: number
  /** How many notifications those bytes arrived in, which says how the replies were chunked. */
  readonly notificationCount: number
  /**
   * Notifications on the control characteristic, which carries session chatter and no registers.
   * A sweep with control traffic and no command traffic had a live tunnel and an unanswered read;
   * one with neither never really opened a session.
   */
  readonly controlNotificationCount: number
  /** PDUs that parsed out of the stream, including any addressed to registers nobody asked for. */
  readonly pduCount: number
  /** Replies that arrived whole and that the record decoder refused. */
  readonly unreadableReplyCount: number
  /** Wall-clock time from the first read request to the sweep settling. */
  readonly elapsedMs: number
}
