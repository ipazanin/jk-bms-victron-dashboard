/**
 * What one sweep of the controller's stored history established.
 *
 * Named apart rather than folded into a success flag, because each answer points at a different
 * fix and because two of them look identical from above. A controller that never answered a read
 * and a controller whose replies the transport tore up both end with no days; only the raw
 * notification bytes separate them, which is why the transfer counts those before parsing anything.
 *
 * - `no-answer`     not one byte crossed the tunnel after the first read request. The session
 *                   opened and the controller then ignored the registers.
 * - `torn-stream`   bytes arrived and not one PDU parsed out of them. The controller answers; the
 *                   link mangled the reply, so the fix is in the transport.
 * - `stalled`       the tunnel spoke, but never about the registers asked for — either the totals
 *                   register went unanswered, or it answered and then the day sweep dried up.
 * - `refused`       the controller answered the totals register with a status code instead of a
 *                   value. It will not serve history at all.
 * - `empty-history` the totals record decoded and reports zero stored days. Nothing to read, and
 *                   that is the answer rather than a failure to get one.
 * - `days-read`     at least one daily register came back. Whether the whole backlog did is a
 *                   separate question the transfer's day count against `daysAvailable` answers.
 */
export type SolarHistoryFetchOutcome =
  | 'no-answer'
  | 'torn-stream'
  | 'stalled'
  | 'refused'
  | 'empty-history'
  | 'days-read'
