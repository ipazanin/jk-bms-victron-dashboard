import { MAX_PAIRING_AGE_MS } from '../history/join'
import type { PairedSample } from '../history/join'
import { MAX_SESSION_HOUR_MOMENTS, SESSION_HOUR_CALCULATION_VERSION, SESSION_HOUR_MS, SESSION_HOUR_SCHEMA } from '../history/SessionHour'
import type { SessionHour } from '../history/SessionHour'
import { SESSION_HOUR_METRICS } from '../history/SessionHourMetric'
import { CHARGE_STATES } from '../solar/types'
import type { ArchiveValidationRule } from './ArchiveValidationRule'
import { sessionLedger } from './recordValidation'
import { boolean, bounded, byte, choice, count, fields, finite, identity, list, nullable, optional, requireArchive, shape, timestamp } from './validation'

const packSample = shape({
  at: timestamp,
  ...fields('currentA packVoltageV remainingCapacityAh cellDeltaV mosfetTemperatureC temperatureSensor1C temperatureSensor2C', finite),
  stateOfCharge: bounded(0, 100),
  highestCell: bounded(0, 32, true), lowestCell: bounded(0, 32, true),
  chargingEnabled: boolean, dischargingEnabled: boolean,
}, true)

const solarSample = shape({
  at: timestamp, chargeState: choice(...Object.values(CHARGE_STATES), 'unknown'), chargerError: byte,
  ...fields('batteryVoltageV batteryCurrentA yieldTodayKwh pvPowerW loadCurrentA', nullable(finite)),
  rssi: finite,
}, true)

const pairedSample: ArchiveValidationRule = (input, path) => {
  shape({ at: timestamp, pack: nullable(packSample), solar: nullable(solarSample) }, true)(input, path)
  const paired = input as PairedSample
  for (const observed of [paired.pack, paired.solar]) {
    if (observed !== null) requireArchive(observed.at <= paired.at && paired.at - observed.at <= MAX_PAIRING_AGE_MS, path, 'reading exceeds pairing age')
  }
}

const metricSummary = shape({
  minimum: nullable(finite), minimumAt: nullable(timestamp),
  maximum: nullable(finite), maximumAt: nullable(timestamp), observations: count,
}, true)
const nonnegativeDuration = bounded(0, Number.MAX_SAFE_INTEGER)
const currentIntegral = shape({ integral: finite, observedMs: nonnegativeDuration }, true)
const momentReasons = [
  'first-pack', 'last-pack', 'first-solar', 'last-solar',
  ...SESSION_HOUR_METRICS.flatMap((metric) => [`${metric}-minimum`, `${metric}-maximum`]),
]

export const sessionHour: ArchiveValidationRule = (input, path) => {
  shape({
    sessionId: identity, hourStart: timestamp, from: timestamp, to: timestamp,
    schema: choice(SESSION_HOUR_SCHEMA), calculationVersion: choice(SESSION_HOUR_CALCULATION_VERSION),
    basis: choice('recorded', 'reconstructed'), clockAdjusted: optional(boolean), ledger: sessionLedger,
    metrics: shape(Object.fromEntries(SESSION_HOUR_METRICS.map((metric) => [metric, metricSummary])), true),
    currentIntegrals: shape({ packCurrentA: currentIntegral, solarCurrentA: currentIntegral, houseCurrentA: currentIntegral }, true),
    coverageMs: shape(fields('both pack-only solar-only foreign none', nonnegativeDuration), true),
    packSamples: count, solarSamples: count,
    moments: list(shape({ sample: pairedSample, reasons: list(choice(...momentReasons)) }, true)),
  }, true)(input, path)
  const hour = input as SessionHour
  requireArchive(hour.hourStart % SESSION_HOUR_MS === 0, path, 'hour must start on a UTC boundary')
  requireArchive(hour.hourStart <= hour.from && hour.from <= hour.to && hour.to <= hour.hourStart + SESSION_HOUR_MS, path, 'observed range exceeds hour')
  if (!hour.clockAdjusted) {
    requireArchive(Object.values(hour.coverageMs).reduce((sum, duration) => sum + duration, 0) <= SESSION_HOUR_MS + 0.001, path, 'coverage exceeds hour')
    requireArchive(hour.ledger.countedMs + hour.ledger.foreignMs <= SESSION_HOUR_MS + 0.001, path, 'ledger duration exceeds hour')
    for (const current of Object.values(hour.currentIntegrals)) requireArchive(current.observedMs <= SESSION_HOUR_MS + 0.001, path, 'current duration exceeds hour')
  }
  for (const summary of Object.values(hour.metrics)) {
    const empty = summary.observations === 0
    requireArchive(empty === (summary.minimum === null && summary.maximum === null && summary.minimumAt === null && summary.maximumAt === null), path, 'extrema disagree with observations')
    if (!empty) {
      requireArchive(summary.minimum !== null && summary.maximum !== null && summary.minimum <= summary.maximum, path, 'inverted extrema')
      for (const at of [summary.minimumAt, summary.maximumAt]) requireArchive(at !== null && at >= hour.from && at <= hour.to, path, 'extremum exceeds observed range')
    }
  }
  requireArchive(hour.moments.length <= MAX_SESSION_HOUR_MOMENTS, path, 'too many selected moments')
  const reasons = new Set<string>()
  let previousAt = hour.from
  for (const moment of hour.moments) {
    requireArchive(moment.sample.at >= previousAt && moment.sample.at <= hour.to, path, 'selected moments exceed observed range or order')
    requireArchive(moment.reasons.length > 0, path, 'selected moment needs a reason')
    for (const reason of moment.reasons) {
      requireArchive(!reasons.has(reason), path, 'duplicate selected moment reason')
      reasons.add(reason)
    }
    previousAt = moment.sample.at
  }
}
