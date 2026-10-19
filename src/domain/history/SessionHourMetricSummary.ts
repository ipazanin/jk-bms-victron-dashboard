export interface SessionHourMetricSummary {
  readonly minimum: number | null
  readonly minimumAt: number | null
  readonly maximum: number | null
  readonly maximumAt: number | null
  readonly observations: number
}
