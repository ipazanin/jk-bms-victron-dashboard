/**
 * How patient one chooser-free reconnect may be, said by the caller because only the caller knows
 * what the page it is running on can hold.
 *
 * The two halves of a rejoin cost different things. The straight attach needs no focus and no radio
 * time: a pack still in the adapter map answers it in one round trip, and a pack the map has
 * forgotten refuses it in milliseconds. Waiting to be heard needs an advertisement watch, and
 * Chromium tears every watch down the moment the tab is hidden or the window loses focus, silently
 * and without firing anything.
 *
 * So this is a statement about the page rather than a switch between two mechanisms. A caller that
 * can hold a watch says so and gets both halves; one that cannot asks for the half that works and
 * is answered either way within seconds.
 *
 * - `wait-for-a-sighting` straight in first, then listen for the pack for as long as the caller's
 *                         signal allows. Only worth asking for with the page in front, because the
 *                         listening half does not survive being behind another window.
 * - `straight-in-only`    the straight attach and nothing behind it. A pack the map has forgotten
 *                         is reported as not there, which is the honest answer while no watch
 *                         could be armed to change it.
 */
export type ReconnectPatience = 'wait-for-a-sighting' | 'straight-in-only'
