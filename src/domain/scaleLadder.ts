/**
 * Quantised auto-ranging, shared by every instrument that scales itself to its data.
 *
 * A scale recomputed from the data on every sample is not a scale — it renormalises, so the
 * largest bar is always the same length whatever it measures, and a 7 mV spread draws the same
 * picture as an 18 mV one. Snapping to a ladder of round stops fixes the picture between steps,
 * which is what lets the eye compare one moment to the next.
 *
 * Growth is immediate because clipping a real excursion is worse than a rescale. Release waits
 * until the data is comfortably inside a smaller stop, so a signal sitting near a boundary
 * cannot oscillate the axis under itself.
 */

export interface ScaleLadder {
  /** Ascending. The last stop is the ceiling; beyond it the scale pins rather than grows. */
  readonly stops: readonly number[]
  /** Headroom before choosing a stop, so a peak is never drawn on the frame. */
  readonly headroom: number
  /** Fraction of the stop in force the data must fall under before the scale steps down. */
  readonly releaseFraction: number
}

export function nextStop(ladder: ScaleLadder, inForce: number, reach: number): number {
  const wanted = reach * ladder.headroom
  const needed = ladder.stops.find((stop) => stop >= wanted) ?? ladder.stops[ladder.stops.length - 1]

  if (needed > inForce) return needed
  if (wanted < inForce * ladder.releaseFraction) return needed
  return inForce
}

/** Amps, for the centre-zero bus ammeter. */
export const CURRENT_LADDER: ScaleLadder = {
  stops: [5, 10, 20, 40, 80, 160, 320],
  headroom: 1.15,
  releaseFraction: 0.45,
}

/** Millivolts of deviation from the pack mean, for the cell ladder. */
export const CELL_DEVIATION_LADDER: ScaleLadder = {
  stops: [5, 10, 20, 50, 100, 200],
  headroom: 1.2,
  releaseFraction: 0.4,
}

/** Watts, for the two power trend strips. */
export const POWER_LADDER: ScaleLadder = {
  stops: [50, 100, 200, 500, 1000, 2000],
  headroom: 1.15,
  releaseFraction: 0.45,
}
