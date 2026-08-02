import type { DetailLogOutcome } from '../bms/DetailLogOutcome'
import type { RingRun } from './RingRun'
import type { DeviceKey } from './types'

/**
 * One stored-log read, immutable and in ring order.
 *
 * The transport figures ride along because the receipt is the only evidence about a read that
 * carried no record at all, and a read that answered with nothing is exactly the one worth keeping.
 */
export interface RingSnapshot {
  readonly deviceKey: DeviceKey
  readonly observedAt: number
  readonly outcome: DetailLogOutcome
  readonly runs: readonly RingRun[]
  /** Everything the receipt needs that is not a record. */
  readonly transport: {
    readonly notificationBytes: number
    readonly notificationCount: number
    readonly assembledFrameCount: number
    readonly logFrameCount: number
    readonly elapsedMs: number
  }
}
