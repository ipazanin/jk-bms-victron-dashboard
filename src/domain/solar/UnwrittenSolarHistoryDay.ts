/**
 * A daily register the controller has not written yet.
 *
 * A recorded day of zero yield is a different thing — a boat under cover produces those, and the
 * captured backlog holds days down to 0.14 kWh — so the two never share a shape. Flattening them
 * would put a fabricated zero into a yield chart on every register the controller has not reached.
 */
export interface UnwrittenSolarHistoryDay {
  readonly recorded: false
}
