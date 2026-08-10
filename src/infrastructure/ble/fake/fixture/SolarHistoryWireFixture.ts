import type { SolarHistoryDayPayload } from './SolarHistoryDayPayload'

/**
 * A whole sweep of the controller's stored history as it came off the wire.
 *
 * The totals record and all thirty-one daily registers, newest first, in the order a sweep asks for
 * them. Payloads only: the tunnel's session open, its keepalives and its framing are the live link's
 * business, and a fake that replays answers has no session to open.
 *
 * Wire bytes only, for the same reason the pack's ring fixture is — the day count, the outcome and
 * every decoded field are derived by the real decoder at playback time.
 */
export interface SolarHistoryWireFixture {
  /** Which controller and which sweep the payloads came from, in prose. */
  readonly note: string
  /** The totals record: the lifetime figures, and the day count that bounds a sweep. */
  readonly totals: string
  /** Today first, then one register per day of age, as far back as the controller has kept. */
  readonly days: readonly SolarHistoryDayPayload[]
}
