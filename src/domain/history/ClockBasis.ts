/**
 * Where a resolved instant's correction came from, so the screen can say it.
 *
 * - `owner-pinned`  the owner stated the error; there is nothing left to be uncertain about.
 * - `measured`      a read observed this very segment.
 * - `propagated`    a read observed another segment, and the recorded rewrites connect the two.
 * - `unresolved`    nothing anchors this ledger to a real clock. The record is still counted; it is
 *                   simply never dated, because a guessed day reads exactly like a known one.
 */
export type ClockBasis = 'owner-pinned' | 'measured' | 'propagated' | 'unresolved'
