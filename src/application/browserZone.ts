/**
 * The browser's own time zone, reduced to the one figure the pack's stored log needs.
 *
 * Everything here is signed the way a zone is written — Central European time is +60, New York is
 * −300 — which is the opposite sign to `Date.prototype.getTimezoneOffset`, the only reader of the
 * host zone underneath. That negation lives in one function so that no caller has to remember it.
 */

const MONTHS_IN_YEAR = 12

/** How far ahead of UTC this browser's zone stood at an instant, summer time included. */
function utcOffsetMinutesAt(instantMs: number): number {
  return -new Date(instantMs).getTimezoneOffset()
}

/**
 * The standard offset of the browser's own zone: the one it keeps outside summer time, in force
 * the year round.
 *
 * Nothing exposes a zone's standard offset directly, so it is derived. Summer time is always an
 * advance on standard time, which makes the smallest offset a zone takes across a whole year its
 * standard one. Sampling the start of every month is enough to find it: no summer-time period
 * spans a full twelve months, southern-hemisphere summer time running across the new year is
 * covered by the mid-year samples, and a zone that keeps no summer time at all answers with the
 * same offset twelve times over.
 *
 * The year is taken from the instant so that a browser sampling its own zone samples the year it
 * is actually in — zones do change their rules, and last year's answer is not automatically this
 * year's.
 */
export function browserStandardUtcOffsetMinutes(instantMs: number): number {
  const year = new Date(instantMs).getFullYear()
  const monthStarts = Array.from({ length: MONTHS_IN_YEAR }, (_, month) => Date.UTC(year, month, 1))
  const standardOffsetMinutes = Math.min(...monthStarts.map((monthStart) => utcOffsetMinutesAt(monthStart)))
  // Negating UTC's own zero gives −0: arithmetically the same offset, but it prints as '-0' and
  // fails an identity comparison against the zero every other reader means. Adding zero flattens it.
  return standardOffsetMinutes + 0
}
