import type { BmsSettings, DeviceInfo } from '../../../../domain/bms/types'
import type { LogbookEvent } from '../../../../domain/bms/logbook'
import type { PlaybackScenario } from './PlaybackScenario'

/**
 * Everything the fake radios replay, distilled from the boat captures into one checked-in file.
 *
 * It holds the live streams only. The two devices' stored histories — the pack's ring and the
 * controller's daily registers — are wire bytes and are kept as their own fixtures, because the fake
 * feeds those back through the real transports rather than replaying decoded rows.
 *
 * Nothing here identifies a real device: the pack's serial is replaced with a demo value at distill
 * time, and the solar rows come from plaintext the capture already held, so producing this file
 * reads no advertisement key.
 */
export interface PlaybackFixture {
  /**
   * What was captured and what it leaves out, in prose, for whoever opens the JSON: which conditions
   * are here, which scenario is short enough that the panel loops it, and that no key was involved.
   */
  readonly note: string
  /**
   * The sentinel a production bundle must never contain. The build greps `dist/` for it, so a fake
   * that failed to shake out of a real build fails that build instead of shipping quietly.
   */
  readonly marker: string
  readonly device: DeviceInfo
  readonly settings: BmsSettings
  /** The pack's event log, in the order the frame carried it, timed from its first power-on. */
  readonly logbook: readonly LogbookEvent[]
  readonly scenarios: readonly PlaybackScenario[]
}
