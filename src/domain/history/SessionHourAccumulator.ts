import { MAX_SAMPLE_GAP_MS } from './join'
import type { PairedSample } from './join'
import {
  EMPTY_LEDGER,
  classifyInterval,
  ledgerOfInterval,
  ledgerOfSample,
  mergeLedgers,
} from './ledger'
import {
  SESSION_HOUR_CALCULATION_VERSION,
  SESSION_HOUR_MS,
  SESSION_HOUR_SCHEMA,
} from './SessionHour'
import type { SessionHour, SessionHourBasis } from './SessionHour'
import { SESSION_HOUR_CURRENTS } from './SessionHourCurrentIntegral'
import type { SessionHourCurrent } from './SessionHourCurrentIntegral'
import { SESSION_HOUR_METRICS } from './SessionHourMetric'
import type { SessionHourMetric } from './SessionHourMetric'
import type { SessionHourMetricSummary } from './SessionHourMetricSummary'
import type { SessionHourMoment, SessionHourMomentReason } from './SessionHourMoment'
import type { CoverageClass, SessionId, SessionLedger } from './types'

type MutableMetric = { -readonly [Key in keyof SessionHourMetricSummary]: SessionHourMetricSummary[Key] }

interface HourFold {
  readonly hourStart: number
  from: number
  to: number
  ledger: SessionLedger
  readonly metrics: Record<SessionHourMetric, MutableMetric>
  readonly currentIntegrals: Record<SessionHourCurrent, { integral: number; observedMs: number }>
  readonly coverageMs: Record<CoverageClass, number>
  packSamples: number
  solarSamples: number
  readonly selected: Map<SessionHourMomentReason, PairedSample>
  clockAdjusted: boolean
  dirty: boolean
  snapshot: SessionHour | null
}

export class SessionHourAccumulator {
  private readonly sessionId: SessionId
  private readonly basis: SessionHourBasis
  private readonly hours = new Map<number, HourFold>()
  private previous: PairedSample | null = null
  private latestObservedAt = Number.NEGATIVE_INFINITY

  constructor(sessionId: SessionId, basis: SessionHourBasis) {
    this.sessionId = sessionId
    this.basis = basis
  }

  push(observation: PairedSample): void {
    const sample = copySample(observation)
    const previous = this.previous
    if (sample.at < this.latestObservedAt) {
      for (const hour of this.hours.values()) {
        if (hour.hourStart + SESSION_HOUR_MS <= sample.at || hour.hourStart > this.latestObservedAt) continue
        hour.clockAdjusted = true
        hour.dirty = true
        hour.snapshot = null
      }
    }
    if (previous !== null && sample.at > previous.at) this.addInterval(previous, sample)

    const hour = this.hourAt(sample.at)
    hour.ledger = mergeLedgers(hour.ledger, ledgerOfSample(sample))
    if (sample.pack !== null && sample.pack.at === sample.at && previous?.pack?.at !== sample.pack.at) {
      hour.packSamples += 1
      selectBoundary(hour, 'pack', sample)
    }
    if (sample.solar !== null && sample.solar.at === sample.at && previous?.solar?.at !== sample.solar.at) {
      hour.solarSamples += 1
      selectBoundary(hour, 'solar', sample)
    }

    const readings = metricReadings(sample)
    for (const metric of SESSION_HOUR_METRICS) {
      const reading = readings[metric]
      if (reading === null) continue
      const summary = hour.metrics[metric]
      summary.observations += 1
      if (summary.minimum === null || reading < summary.minimum ||
        (reading === summary.minimum && sample.at < (summary.minimumAt ?? Infinity))) {
        summary.minimum = reading
        summary.minimumAt = sample.at
        hour.selected.set(`${metric}-minimum`, sample)
      }
      if (summary.maximum === null || reading > summary.maximum ||
        (reading === summary.maximum && sample.at < (summary.maximumAt ?? Infinity))) {
        summary.maximum = reading
        summary.maximumAt = sample.at
        hour.selected.set(`${metric}-maximum`, sample)
      }
    }
    this.previous = sample
    this.latestObservedAt = Math.max(this.latestObservedAt, sample.at)
  }

  updatedHours(): readonly SessionHour[] {
    const changed: SessionHour[] = []
    for (const hour of this.hours.values()) {
      if (!hour.dirty) continue
      if (hour.snapshot === null) hour.snapshot = this.snapshotOf(hour)
      changed.push(hour.snapshot)
    }
    return changed.sort((earlier, later) => earlier.hourStart - later.hourStart)
  }

  acknowledge(saved: readonly SessionHour[]): void {
    for (const snapshot of saved) {
      const hour = this.hours.get(snapshot.hourStart)
      if (hour?.snapshot === snapshot) hour.dirty = false
    }
  }

  private addInterval(previous: PairedSample, sample: PairedSample): void {
    const firstHour = hourStartOf(previous.at)
    const lastHour = hourStartOf(sample.at)
    const boundaries = firstHour === lastHour ? [firstHour] : [firstHour, lastHour]
    const coverage = classifyInterval(previous, sample)
    const contribution = ledgerOfInterval(previous, sample)
    const intervalMs = sample.at - previous.at
    const before = metricReadings(previous)
    const after = metricReadings(sample)

    // Entirely unobserved hours remain absent, including after a large wall-clock jump.
    for (const hourStart of boundaries) {
      const from = Math.max(previous.at, hourStart)
      const to = Math.min(sample.at, hourStart + SESSION_HOUR_MS)
      if (to <= from) continue
      const hour = this.hourAt(from, to)
      hour.coverageMs[coverage] += to - from
      hour.ledger = mergeLedgers(hour.ledger, ledgerFraction(contribution, (to - from) / intervalMs))
      if (intervalMs > MAX_SAMPLE_GAP_MS) continue

      const midpoint = ((from - previous.at) + (to - previous.at)) / (2 * intervalMs)
      for (const metric of SESSION_HOUR_CURRENTS) {
        const first = before[metric]
        const last = after[metric]
        if (first === null || last === null) continue
        const summary = hour.currentIntegrals[metric]
        summary.integral += (first + (last - first) * midpoint) * (to - from)
        summary.observedMs += to - from
      }
    }
  }

  private hourAt(from: number, to = from): HourFold {
    const hourStart = hourStartOf(from)
    let hour = this.hours.get(hourStart)
    if (hour === undefined) {
      hour = emptyHour(hourStart, from)
      this.hours.set(hourStart, hour)
    }
    hour.from = Math.min(hour.from, from)
    hour.to = Math.max(hour.to, to)
    if (from < this.latestObservedAt) hour.clockAdjusted = true
    hour.dirty = true
    hour.snapshot = null
    return hour
  }

  private snapshotOf(hour: HourFold): SessionHour {
    return {
      sessionId: this.sessionId,
      hourStart: hour.hourStart,
      from: hour.from,
      to: hour.to,
      schema: SESSION_HOUR_SCHEMA,
      calculationVersion: SESSION_HOUR_CALCULATION_VERSION,
      basis: this.basis,
      ...(hour.clockAdjusted ? { clockAdjusted: true } : {}),
      ledger: hour.ledger,
      metrics: copyMetrics(hour.metrics),
      currentIntegrals: copyCurrentIntegrals(hour.currentIntegrals),
      coverageMs: { ...hour.coverageMs },
      packSamples: hour.packSamples,
      solarSamples: hour.solarSamples,
      moments: selectedMoments(hour.selected),
    }
  }
}

function hourStartOf(at: number): number {
  return Math.floor(at / SESSION_HOUR_MS) * SESSION_HOUR_MS
}

function emptyHour(hourStart: number, at: number): HourFold {
  const metrics = {} as Record<SessionHourMetric, MutableMetric>
  for (const metric of SESSION_HOUR_METRICS) {
    metrics[metric] = {
      minimum: null,
      minimumAt: null,
      maximum: null,
      maximumAt: null,
      observations: 0,
    }
  }
  return {
    hourStart,
    from: at,
    to: at,
    ledger: EMPTY_LEDGER,
    metrics,
    currentIntegrals: {
      packCurrentA: { integral: 0, observedMs: 0 },
      solarCurrentA: { integral: 0, observedMs: 0 },
      houseCurrentA: { integral: 0, observedMs: 0 },
    },
    coverageMs: { both: 0, foreign: 0, 'pack-only': 0, 'solar-only': 0, none: 0 },
    packSamples: 0,
    solarSamples: 0,
    selected: new Map(),
    clockAdjusted: false,
    dirty: true,
    snapshot: null,
  }
}

function copyMetrics(
  metrics: Readonly<Record<SessionHourMetric, SessionHourMetricSummary>>,
): Record<SessionHourMetric, MutableMetric> {
  const copied = {} as Record<SessionHourMetric, MutableMetric>
  for (const metric of SESSION_HOUR_METRICS) copied[metric] = { ...metrics[metric] }
  return copied
}

function copyCurrentIntegrals(
  currents: SessionHour['currentIntegrals'],
): HourFold['currentIntegrals'] {
  return {
    packCurrentA: { ...currents.packCurrentA },
    solarCurrentA: { ...currents.solarCurrentA },
    houseCurrentA: { ...currents.houseCurrentA },
  }
}

/** Hour seams divide the original interval account uniformly, preserving its accounting class. */
function ledgerFraction(ledger: SessionLedger, fraction: number): SessionLedger {
  return {
    ...ledger,
    countedMs: ledger.countedMs * fraction,
    foreignMs: ledger.foreignMs * fraction,
    packAh: ledger.packAh * fraction,
    solarAh: ledger.solarAh * fraction,
    houseWh: ledger.houseWh * fraction,
    foreignAhFloor: ledger.foreignAhFloor * fraction,
    packAhWholeSession: ledger.packAhWholeSession * fraction,
  }
}

function selectBoundary(hour: HourFold, stream: 'pack' | 'solar', sample: PairedSample): void {
  const first = hour.selected.get(`first-${stream}`)
  if (first === undefined || sample.at < first.at) hour.selected.set(`first-${stream}`, sample)
  const last = hour.selected.get(`last-${stream}`)
  if (last === undefined || sample.at >= last.at) hour.selected.set(`last-${stream}`, sample)
}

function selectedMoments(selected: ReadonlyMap<SessionHourMomentReason, PairedSample>): SessionHourMoment[] {
  const byObservation = new Map<string, { sample: PairedSample; reasons: SessionHourMomentReason[] }>()
  for (const [reason, sample] of selected) {
    const key = JSON.stringify(sample)
    const retained = byObservation.get(key)
    if (retained === undefined) byObservation.set(key, { sample, reasons: [reason] })
    else retained.reasons.push(reason)
  }
  return [...byObservation.values()].sort((earlier, later) => earlier.sample.at - later.sample.at)
}

function copySample(sample: PairedSample): PairedSample {
  return {
    at: sample.at,
    pack: sample.pack === null ? null : { ...sample.pack },
    solar: sample.solar === null ? null : { ...sample.solar },
  }
}

function metricReadings(sample: PairedSample): Record<SessionHourMetric, number | null> {
  const pack = sample.pack
  const solar = sample.solar
  const houseCurrentA = pack === null || solar?.batteryCurrentA == null
    ? null
    : solar.batteryCurrentA - pack.currentA
  return {
    packCurrentA: pack?.currentA ?? null,
    solarCurrentA: solar?.batteryCurrentA ?? null,
    houseCurrentA,
    housePowerW: houseCurrentA === null || pack === null ? null : houseCurrentA * pack.packVoltageV,
    stateOfCharge: pack?.stateOfCharge ?? null,
    cellDeltaV: pack?.cellDeltaV ?? null,
    mosfetTemperatureC: pack?.mosfetTemperatureC ?? null,
    packVoltageV: pack?.packVoltageV ?? null,
    pvPowerW: solar?.pvPowerW ?? null,
  }
}
