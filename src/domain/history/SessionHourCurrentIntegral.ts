export const SESSION_HOUR_CURRENTS = ['packCurrentA', 'solarCurrentA', 'houseCurrentA'] as const

export type SessionHourCurrent = (typeof SESSION_HOUR_CURRENTS)[number]

export interface SessionHourCurrentIntegral {
  /** Amp-milliseconds over observed intervals only. */
  readonly integral: number
  readonly observedMs: number
}
