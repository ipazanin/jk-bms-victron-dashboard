import type { PairedSample } from './join'
import type { SessionHourMetric } from './SessionHourMetric'

export type SessionHourMomentReason =
  | 'first-pack'
  | 'last-pack'
  | 'first-solar'
  | 'last-solar'
  | `${SessionHourMetric}-minimum`
  | `${SessionHourMetric}-maximum`

export interface SessionHourMoment {
  readonly sample: PairedSample
  readonly reasons: readonly SessionHourMomentReason[]
}
