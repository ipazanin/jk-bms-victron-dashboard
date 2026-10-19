import type { SessionHourMetric } from './SessionHourMetric'
import type { SessionHourCurrent, SessionHourCurrentIntegral } from './SessionHourCurrentIntegral'
import type { SessionHourMetricSummary } from './SessionHourMetricSummary'
import type { SessionHourMoment } from './SessionHourMoment'
import type { CoverageClass, SessionId, SessionLedger } from './types'

export const SESSION_HOUR_SCHEMA = 1
export const SESSION_HOUR_CALCULATION_VERSION = 1
export const SESSION_HOUR_MS = 3_600_000
export const MAX_SESSION_HOUR_MOMENTS = 22

export type SessionHourBasis = 'recorded' | 'reconstructed'

export interface SessionHour {
  readonly sessionId: SessionId
  readonly hourStart: number
  readonly from: number
  readonly to: number
  readonly schema: typeof SESSION_HOUR_SCHEMA
  readonly calculationVersion: typeof SESSION_HOUR_CALCULATION_VERSION
  readonly basis: SessionHourBasis
  readonly clockAdjusted?: boolean
  readonly ledger: SessionLedger
  readonly metrics: Readonly<Record<SessionHourMetric, SessionHourMetricSummary>>
  readonly currentIntegrals: Readonly<Record<SessionHourCurrent, SessionHourCurrentIntegral>>
  readonly coverageMs: Readonly<Record<CoverageClass, number>>
  readonly packSamples: number
  readonly solarSamples: number
  readonly moments: readonly SessionHourMoment[]
}
