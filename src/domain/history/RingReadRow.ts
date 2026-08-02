import type { DetailLogOutcome } from '../bms/DetailLogOutcome'
import type { DeviceKey } from './types'

/**
 * One stored-log read, and what filing it did.
 *
 * A failed read is worth journaling: a pack that stops answering 0xA7 after a firmware change is
 * exactly what a stored history of attempts reveals. `newestSampleCounter` is the clock anchor —
 * it, with `observedAt`, is the only measurement of how far the pack's clock runs ahead, and the
 * estimate narrows for free as reads accumulate.
 */
export interface RingReadRow {
  readonly deviceKey: DeviceKey
  /** Never written: absence is what marks a receipt as a pack read. See `StoredRowFormat`. */
  readonly format?: undefined
  readonly observedAt: number
  readonly outcome: DetailLogOutcome
  readonly notificationBytes: number
  readonly notificationCount: number
  readonly assembledFrameCount: number
  readonly logFrameCount: number
  /** Ring indices the read covered, or null when it carried no record. */
  readonly indexSpan: { readonly from: number; readonly to: number } | null
  readonly recordsReceived: number
  readonly recordsAppended: number
  /** Records that matched the stored ledger. Zero opens a ledger or declares a gap. */
  readonly overlap: number
  /**
   * How many stored rows sit below this read's ring index 0 — the distance the ring's oldest
   * position has travelled away from the ledger's own origin. Differencing two journal rows gives
   * the movement between them, and on a ledger opened by a whole-ring read the first difference is
   * the movement since that read. Null when nothing aligned and there was nothing to compare.
   */
  readonly ringShift: number | null
  readonly gapDeclared: boolean
  readonly runsDiscarded: number
  /** Newest scheduled (event code 0) counter the read carried. Null when it carried none. */
  readonly newestSampleCounter: number | null
  /** Seq of the ledger row that counter landed on, so a later rewrite can be told from an older
   *  observation. Null when nothing was appended or matched. */
  readonly newestSampleSeq: number | null
  readonly elapsedMs: number
}
