/**
 * Deferred work as a seam, so everything in this layer that waits can be driven by hand.
 *
 * It lives on its own because three unrelated things wait on it — the pack's rejoin loop, the
 * controller's, and the recorder's heartbeat — and none of them should have to reach into another's
 * module to say "later". A spec that hands the same scheduler to all three advances one clock and
 * gets the whole application's sense of time with it, which is the only way two waits that must not
 * collide can be shown not to.
 */

/** Undoes a scheduled run, and does nothing at all once it has already run. */
export type CancelScheduled = () => void

export type Schedule = (run: () => void, delayMs: number) => CancelScheduled

/** `setTimeout` as the port shape, for the page rather than for a spec. */
export function browserSchedule(run: () => void, delayMs: number): CancelScheduled {
  const timer = setTimeout(run, delayMs)
  return () => clearTimeout(timer)
}
