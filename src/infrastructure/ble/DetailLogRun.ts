/**
 * One stored-log read, while it is happening.
 *
 * The instrument is the raw byte count, not the record count. A pack that ignores 0xA7 and a reply
 * whose frames the transport tore up both end with nothing decoded and look identical from above,
 * so every notification is counted here before the assembler is ever given it.
 *
 * The read ends on silence, because the protocol has no end-of-stream marker — the vendor app just
 * lets a timer expire. Silence means no type 0x06 frame, and nothing weaker than that: the pack
 * streams cell-info of its own accord several times a second, before, during and after a dump, so
 * neither raw traffic nor a frame of another type is evidence that the burst is still running. Two
 * silences mean different things and are timed differently. Before the first stored-log frame the
 * pack may still be preparing the dump, so it gets a long grace; once they are flowing, a much
 * shorter gap means the burst is over. A ceiling bounds both, so a pack that trickles forever still
 * yields a measurement rather than hanging the UI.
 */

import { decodeDetailLog, detailLogOutcome, readDetailLogHeader } from '../../domain/bms/detailLog'
import type { DetailLogRecord } from '../../domain/bms/detailLog'
import type { DetailLogFrameHeader } from '../../domain/bms/DetailLogFrameHeader'
import type { DetailLogTransfer } from '../../domain/bms/DetailLogTransfer'
import { FRAME_DETAIL_LOG, frameType } from '../../domain/bms/protocol'

/**
 * How long the pack has to produce its first stored-log frame before the read is called unanswered.
 * Generous, because calling a slow pack silent is the one mistake this diagnostic must not make:
 * the whole question is whether the opcode produces anything at all.
 */
const FIRST_ANSWER_MS = 8_000

/**
 * A gap this long between stored-log frames ends the read. Back-to-back 300-byte frames arrive
 * orders of magnitude faster than this at any MTU, so two seconds without one is the burst
 * finishing.
 */
const QUIET_GAP_MS = 2_000

/**
 * The hard bound. Set past the 25 s the vendor app waits, so a reply that runs the vendor's whole
 * window still ends on its own quiet gap and is reported complete rather than cut off by us.
 */
const CEILING_MS = 30_000

export class DetailLogRun {
  private readonly packUtcOffsetMinutes: number
  private readonly startedAt = Date.now()
  private readonly headers: DetailLogFrameHeader[] = []
  private readonly records: DetailLogRecord[] = []
  private notificationBytes = 0
  private notificationCount = 0
  private assembledFrameCount = 0
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private ceilingTimer: ReturnType<typeof setTimeout> | null = null
  private settle: ((transfer: DetailLogTransfer) => void) | null = null

  /** Resolves once, with whatever arrived. It never rejects: a read that found nothing is a result. */
  readonly transfer: Promise<DetailLogTransfer>

  constructor(packUtcOffsetMinutes: number) {
    this.packUtcOffsetMinutes = packUtcOffsetMinutes
    this.transfer = new Promise<DetailLogTransfer>((resolve) => {
      this.settle = resolve
    })
    this.rearmSilence(FIRST_ANSWER_MS)
    this.ceilingTimer = setTimeout(this.stop, CEILING_MS)
  }

  /** Every notification in the window, counted before assembly — this is the decisive measurement. */
  noteNotification(chunk: Uint8Array): void {
    if (this.settle === null) return
    this.notificationBytes += chunk.length
    this.notificationCount += 1
  }

  /**
   * Every frame that assembled in the window. All of them are counted, because frames arriving with
   * no stored log among them is a different finding from nothing assembling at all; only a
   * stored-log frame is described, and only one of those holds the read open.
   */
  noteFrame(frame: Uint8Array): void {
    if (this.settle === null) return
    this.assembledFrameCount += 1
    if (frameType(frame) !== FRAME_DETAIL_LOG) return
    this.headers.push(readDetailLogHeader(frame))
    this.rearmSilence(QUIET_GAP_MS)
  }

  /** Throws on a frame whose layout is not what the decoder was written for; the caller reports it. */
  readRecordsFrom(frame: Uint8Array): void {
    if (this.settle === null) return
    const decoded = decodeDetailLog(frame, { packUtcOffsetMinutes: this.packUtcOffsetMinutes })
    this.records.push(...decoded)
  }

  /**
   * Ends the read now with what it has. Called by both timers, by the client when the write itself
   * failed, and when the link goes away part-way through — a measurement interrupted by a drop is
   * still worth reporting, and is a very different finding from one that timed out in silence.
   */
  readonly stop = (): void => {
    const settle = this.settle
    if (settle === null) return
    this.settle = null
    this.clearTimer(this.silenceTimer)
    this.clearTimer(this.ceilingTimer)
    this.silenceTimer = null
    this.ceilingTimer = null
    settle({
      outcome: detailLogOutcome({
        notificationBytes: this.notificationBytes,
        assembledFrameCount: this.assembledFrameCount,
        storedLogFrameCount: this.headers.length,
      }),
      notificationBytes: this.notificationBytes,
      notificationCount: this.notificationCount,
      assembledFrameCount: this.assembledFrameCount,
      frames: [...this.headers],
      records: [...this.records],
      elapsedMs: Date.now() - this.startedAt,
    })
  }

  private rearmSilence(delayMs: number): void {
    this.clearTimer(this.silenceTimer)
    this.silenceTimer = setTimeout(this.stop, delayMs)
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer !== null) clearTimeout(timer)
  }
}
