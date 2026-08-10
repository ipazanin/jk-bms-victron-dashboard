import type { DeviceKey } from '../../../../domain/history/types'
import type { CapturedRingRead } from './CapturedRingRead'

/**
 * The pack's stored log as it came off the wire, read twice.
 *
 * Two reads several hours apart, because the ring moves under a reader between them: the overlap,
 * the shift and the records appended since are real here, and every one of them is a filing outcome
 * the archive has to survive. Authoring those by hand would be authoring the very arithmetic the
 * fold is being exercised on.
 *
 * Wire bytes only. What a read amounts to is left to the real transport at playback time, and what a
 * spec expects of it belongs beside the spec.
 */
export interface PackRingWireFixture {
  /** Which capture the bursts came from and what condition the pack was in, in prose. */
  readonly note: string
  /** The demo key both reads are filed under. Never a real device's identity. */
  readonly deviceKey: DeviceKey
  /**
   * Minutes east of UTC that the pack's own clock is set to. Its records carry a counter on that
   * clock and nothing else, so without this a date read off them is off by whatever the pack is.
   */
  readonly packUtcOffsetMinutes: number
  readonly earlier: CapturedRingRead
  readonly later: CapturedRingRead
}
