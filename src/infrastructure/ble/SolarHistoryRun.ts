/**
 * One sweep of the controller's stored history, while it is happening.
 *
 * The run owns two things the client cannot: the clock, and the pairing of a reply to the request
 * that is waiting for it. Both exist because the tunnel has no correlation id. A reply carries the
 * register it answers and nothing else, so the only sound way to know which request a PDU belongs
 * to is to have exactly one outstanding — `awaitAnswerFor` refuses a second, and a PDU naming any
 * other register is session chatter that resolves nothing. The `07 00 03 00` the controller sends
 * during every session open is exactly that case, which is why it needs no special handling.
 *
 * Three bounds, for three different silences. Before the first reply the controller may still be
 * waking its tunnel up, so it gets a long grace; once replies are flowing a much shorter gap means
 * it has stopped answering; and a ceiling bounds the whole sweep, because a session holds the
 * controller's single connection slot and blocks the advertisement feed the dashboard runs on. Any
 * of the three ends the run with what it has. None of them is an error: a sweep that found nothing
 * is a result, and `transfer` resolves in every case and rejects in none.
 *
 * Modelled on `DetailLogRun`, which does the same job for the pack's stored log, with one
 * difference worth naming: that read is a single burst nobody drives, and this one is thirty-one
 * request-reply round trips. So the timers here are re-armed by an answer to a register we asked
 * for, never by traffic in general — keepalives and control chatter would otherwise hold a dead
 * sweep open indefinitely.
 */

import type { SolarHistoryDayReading } from '../../domain/solar/SolarHistoryDayReading'
import type { SolarHistoryFetchOutcome } from '../../domain/solar/SolarHistoryFetchOutcome'
import type { SolarHistoryRegister } from '../../domain/solar/SolarHistoryRegister'
import type { SolarHistoryTotals } from '../../domain/solar/SolarHistoryTotals'
import type { SolarHistoryTransfer } from '../../domain/solar/SolarHistoryTransfer'
import type { TunnelPdu } from '../../domain/solar/tunnel/TunnelPdu'

/**
 * How long the controller has to answer the first read before the sweep is called unanswered.
 * Generous, because calling a slow controller silent is the mistake this measurement must not make.
 */
const FIRST_ANSWER_MS = 6_000

/**
 * A gap this long between answers ends the sweep. Every captured round trip is two notifications
 * and a few tens of milliseconds, so three seconds without one is the controller having stopped.
 */
const QUIET_GAP_MS = 3_000

/**
 * The hard bound on a whole sweep. Thirty-one round trips at the captured pace finish inside two
 * seconds; this leaves an order of magnitude of headroom and still ends the session long before a
 * boat notices its solar readings have gone quiet.
 */
const CEILING_MS = 45_000

/** One outstanding read, and the resolver waiting for the reply that answers it. */
interface AwaitedAnswer {
  readonly register: number
  readonly resolve: (pdu: TunnelPdu | null) => void
}

export class SolarHistoryRun {
  private readonly startedAt = Date.now()
  private readonly days: SolarHistoryDayReading[] = []
  private readonly refusedRegisters: number[] = []
  private totals: SolarHistoryTotals | null = null
  private notificationBytes = 0
  private notificationCount = 0
  private controlNotificationCount = 0
  private pduCount = 0
  private unreadableReplyCount = 0
  private awaited: AwaitedAnswer | null = null
  private quietTimer: ReturnType<typeof setTimeout> | null = null
  private ceilingTimer: ReturnType<typeof setTimeout> | null = null
  private settle: ((transfer: SolarHistoryTransfer) => void) | null = null

  /** Resolves once, with whatever the sweep gathered. It never rejects. */
  readonly transfer: Promise<SolarHistoryTransfer>

  constructor() {
    this.transfer = new Promise<SolarHistoryTransfer>((resolve) => {
      this.settle = resolve
    })
    this.rearmQuiet(FIRST_ANSWER_MS)
    this.ceilingTimer = setTimeout(this.stop, CEILING_MS)
  }

  /** False once any of the three bounds has ended the sweep, or the client has closed it. */
  get running(): boolean {
    return this.settle !== null
  }

  /**
   * Arms the run for the one register about to be requested. The caller must arm before it writes:
   * a reply can arrive before the write promise settles, and an unarmed run would drop it.
   *
   * Resolves null when the run ends before an answer arrives, so the caller's loop unwinds instead
   * of hanging on a controller that has stopped talking.
   */
  awaitAnswerFor(register: SolarHistoryRegister): Promise<TunnelPdu | null> {
    if (this.settle === null) return Promise.resolve(null)
    if (this.awaited !== null) {
      throw new Error(`register 0x${this.awaited.register.toString(16)} is still outstanding`)
    }
    return new Promise<TunnelPdu | null>((resolve) => {
      this.awaited = { register, resolve }
    })
  }

  /** Bytes off the command and bulk characteristics, counted before the reassembler sees them. */
  noteNotification(chunk: Uint8Array): void {
    if (this.settle === null) return
    this.notificationBytes += chunk.length
    this.notificationCount += 1
  }

  /** Traffic on the control characteristic, which proves the session is alive and nothing else. */
  noteControlNotification(): void {
    if (this.settle === null) return
    this.controlNotificationCount += 1
  }

  /**
   * Every PDU the stream yielded. Only one addressed to the outstanding register answers a request
   * and re-arms the quiet gap; anything else is counted and dropped.
   */
  notePdu(pdu: TunnelPdu): void {
    if (this.settle === null) return
    this.pduCount += 1

    const awaited = this.awaited
    if (awaited === null || awaited.register !== pdu.register) return
    this.awaited = null
    this.rearmQuiet(QUIET_GAP_MS)
    awaited.resolve(pdu)
  }

  recordTotals(totals: SolarHistoryTotals): void {
    if (this.settle === null) return
    this.totals = totals
  }

  recordDay(reading: SolarHistoryDayReading): void {
    if (this.settle === null) return
    this.days.push(reading)
  }

  /** A register the controller answered for with a status code rather than a record. */
  noteRefusal(register: number): void {
    if (this.settle === null) return
    this.refusedRegisters.push(register)
  }

  /** A reply that arrived whole and that the record decoder would not read. */
  noteUnreadableReply(): void {
    if (this.settle === null) return
    this.unreadableReplyCount += 1
  }

  /**
   * Ends the sweep now with what it has. Called by both timers, by the client when its loop
   * finishes, and when the link goes away part-way through — a sweep cut short by a drop still
   * measured something, and it is a different finding from one that timed out in silence.
   */
  readonly stop = (): void => {
    const settle = this.settle
    if (settle === null) return
    this.settle = null
    this.clearTimer(this.quietTimer)
    this.clearTimer(this.ceilingTimer)
    this.quietTimer = null
    this.ceilingTimer = null

    // Before the transfer settles, so a caller still inside its sweep unwinds and stops asking.
    const awaited = this.awaited
    this.awaited = null
    awaited?.resolve(null)

    settle({
      outcome: this.outcome(),
      totals: this.totals,
      days: [...this.days],
      refusedRegisters: [...this.refusedRegisters],
      notificationBytes: this.notificationBytes,
      notificationCount: this.notificationCount,
      controlNotificationCount: this.controlNotificationCount,
      pduCount: this.pduCount,
      unreadableReplyCount: this.unreadableReplyCount,
      elapsedMs: Date.now() - this.startedAt,
    })
  }

  /**
   * Ordered from the most specific finding outward, so a sweep that got somewhere is never
   * described by how it ended. A single day back is `days-read` whatever happened afterwards,
   * because the day count against `daysAvailable` says how far it got and the outcome does not.
   */
  private outcome(): SolarHistoryFetchOutcome {
    // A register that answered carrying the unwritten flag is a reply and not a day. Counting it
    // as one would report `days-read` to a controller that has kept nothing — the state a freshly
    // commissioned charger is in, and the one where saying "read" would be a lie about the archive.
    if (this.days.some((reading) => reading.day.recorded)) return 'days-read'
    if (this.totals !== null) return this.days.length > 0 ? 'empty-history' : 'stalled'
    if (this.refusedRegisters.length > 0) return 'refused'
    if (this.notificationBytes === 0) return 'no-answer'
    if (this.pduCount === 0) return 'torn-stream'
    return 'stalled'
  }

  private rearmQuiet(delayMs: number): void {
    this.clearTimer(this.quietTimer)
    this.quietTimer = setTimeout(this.stop, delayMs)
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer !== null) clearTimeout(timer)
  }
}
