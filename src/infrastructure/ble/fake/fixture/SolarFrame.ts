import type { SolarReading } from '../../../../domain/solar/types'

/**
 * One decoded Victron advertisement at the moment the capture saw it.
 *
 * The reading is the production type verbatim, for the same reason a pack frame's snapshot is: it
 * goes to the reading handler as it stands. The rows were distilled from the plaintext the boat
 * capture already held, so producing this fixture reads no advertisement key and decrypts nothing.
 */
export interface SolarFrame {
  /** Milliseconds on the scenario's time base, the one the pack stream is rebased onto. */
  readonly atMs: number
  /** dBm, and negative. Zero is not a weak signal — the UI reads it as no signal to show. */
  readonly rssi: number
  readonly reading: SolarReading
}
