/**
 * Why a chooser-free reconnect never reached the radio at all.
 *
 * Both answers are about permission, never about presence, and that is the whole point of naming
 * them apart from a pack that is merely out of range: an owner who must tap the chooser and an
 * owner who must simply wait need different things said to them, and only one of the three is worth
 * interrupting for.
 *
 * - `permission-gone`       the browser lists the devices this origin may talk to, and the last
 *                           pack is not among them. `getDevices()` reports permission, not range,
 *                           so no amount of patience brings it back — one chooser tap does.
 * - `browser-cannot-rejoin` the browser has no `getDevices()` at all, so every visit needs the
 *                           chooser however close the pack is.
 */
export type ReconnectRefusal = 'permission-gone' | 'browser-cannot-rejoin'
