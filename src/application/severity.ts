/**
 * Severity ranking, shared so every badge agrees on which level wins.
 *
 * The order is best-to-worst, so a higher index is strictly more severe. It lives in one place
 * because the reduce below is subtle: when sensors carry different thresholds the hottest
 * reading is not always the worst one, and two independent copies of this logic would be free
 * to drift apart.
 */

export type FaultLevel = 'good' | 'warning' | 'serious' | 'critical'

export const SEVERITY_ORDER: readonly FaultLevel[] = ['good', 'warning', 'serious', 'critical']

/** The most severe level present, or 'good' when none are given. */
export function worstOf(levels: Iterable<FaultLevel>): FaultLevel {
  let worst: FaultLevel = 'good'
  for (const level of levels) {
    if (SEVERITY_ORDER.indexOf(level) > SEVERITY_ORDER.indexOf(worst)) worst = level
  }
  return worst
}

/**
 * Grades a rising measurement against ascending thresholds. A reading at or above a threshold
 * takes that level; below the warning threshold it is 'good'. The bands must be ordered
 * warning ≤ serious ≤ critical.
 */
export function levelForThresholds(value: number, warning: number, serious: number, critical: number): FaultLevel {
  if (value >= critical) return 'critical'
  if (value >= serious) return 'serious'
  if (value >= warning) return 'warning'
  return 'good'
}
