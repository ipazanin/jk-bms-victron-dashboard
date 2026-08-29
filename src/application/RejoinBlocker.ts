import type { ReconnectRefusal } from '../infrastructure/ble/ReconnectRefusal'

/**
 * Why automatic rejoin has stopped trying, when the answer is one the owner has to act on.
 *
 * A pack that is merely out of range is not in here, and that is the point: the supervisor retries
 * that one for as long as the page is in front, in silence. These three no amount of patience
 * fixes — the chooser has to be tapped, the radio switched on, or the browser changed — so they
 * are the only stand-downs worth putting on screen.
 *
 * The two permission answers are the radio's own vocabulary, taken as they are rather than
 * restated: whoever reads this and whoever reads a `ReconnectRefusedError` must not drift apart.
 */
export type RejoinBlocker = ReconnectRefusal | 'radio-off'
