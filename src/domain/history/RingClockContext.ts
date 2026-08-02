import type { PackClockCalibration } from './PackClockCalibration'
import type { RingClockSegment } from './RingClockSegment'
import type { RingReadRow } from './RingReadRow'

/**
 * Everything one pack's ledger knows about its own clock, gathered once so a range fold resolving
 * thousands of records walks the calibrations once rather than per record.
 */
export interface RingClockContext {
  readonly packUtcOffsetMinutes: number
  /** True when the offset above is the browser's guess rather than the owner's answer. */
  readonly offsetIsGuessed: boolean
  readonly segments: readonly RingClockSegment[]
  readonly calibrations: readonly PackClockCalibration[]
  readonly unpairedCalibrations: number
  readonly reads: readonly RingReadRow[]
  readonly ownerAheadSeconds: number | null
}
