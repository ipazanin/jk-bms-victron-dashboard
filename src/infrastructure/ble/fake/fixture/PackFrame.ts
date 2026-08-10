import type { BatterySnapshot } from '../../../../domain/bms/types'

/**
 * One decoded pack frame at the moment the capture saw it.
 *
 * The snapshot is the production type verbatim, so a played frame is handed to the snapshot handler
 * untouched. There is no rehydration step and therefore no place for a unit to change meaning on the
 * way in — the alternative, a compact integer encoding, is smaller and puts millivolts where volts
 * belong the first time a field moves.
 *
 * The timestamp is rebased so a scenario starts at zero, and the gaps between frames are the pack's
 * own — uneven, around four a second. Replaying on a fixed interval instead would hide exactly the
 * jitter the dashboard has to absorb.
 */
export interface PackFrame {
  /** Milliseconds from the first frame of the scenario. Strictly increasing. */
  readonly atMs: number
  /** Rounded to the precision the wire carries: 3 dp volts and amps, 2 dp watts, 1 dp °C. */
  readonly battery: BatterySnapshot
}
