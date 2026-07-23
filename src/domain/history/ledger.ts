/**
 * The session's energy account: what the pack took, what the panels gave, what the boat used.
 *
 * The identity the live instrument draws survives integration exactly —
 * `∫(solar − pack)dt = ∫solar dt − ∫pack dt` over any common window — so the archive needs no new
 * physics. The whole of the difficulty is the phrase "common window". On a real boat the two
 * radios do not report over the same span, and for part of most days the pack is charged from
 * something neither of them measures.
 *
 * So the account is partitioned rather than averaged. Only intervals in which both radios reported
 * and solar − pack came out non-negative are counted, and they carry the house figure. Intervals
 * in which the pack took more than the panels gave are set aside as the foreign window: an
 * alternator or a shore charger was on the bus, the difference is no longer a house load, and what
 * is reported is a floor on the unmeasured charge rather than a figure pretending to be exact.
 *
 * That partition sits at strict zero and not at dcBus's noise floor. The floor is an allowance for
 * one instantaneous reading and it averages out across an integrated interval, so a
 * floor-independent boundary is the one that keeps a stored ledger valid if the floor is ever
 * changed. It follows that a single sample sitting between the floor and zero is withheld by the
 * instrument and counted by the ledger; both rules are right about their own question.
 *
 * The fold is a monoid — `mergeLedgers` is associative with `EMPTY_LEDGER` as its identity — which
 * is the only reason the ledger cached on a session row can be trusted: the recorder's running
 * total, one interval at a time, and a whole-session rescan produce the same account.
 */

import { MAX_SAMPLE_GAP_MS, pairSamples, solarCurrentOf } from './join'
import type { PairedSample } from './join'
import type {
  CoverageClass,
  CoverageRun,
  PackSample,
  SessionLedger,
  SolarSample,
} from './types'

const MS_PER_HOUR = 3_600_000

/** The identity of the fold, and the account of a session that has recorded nothing yet. */
export const EMPTY_LEDGER: SessionLedger = {
  countedMs: 0,
  foreignMs: 0,
  packAh: 0,
  solarAh: 0,
  houseWh: 0,
  foreignAhFloor: 0,
  packAhWholeSession: 0,
  stateOfChargeFirst: null,
  stateOfChargeLast: null,
  stateOfChargeMin: null,
  remainingCapacityFirstAh: null,
  remainingCapacityLastAh: null,
  pvPowerPeakW: null,
}

/** A ledger and the coverage runs that make its window checkable, folded over the same walk. */
export interface SessionAccount {
  readonly ledger: SessionLedger
  readonly coverage: readonly CoverageRun[]
}

/**
 * Combines two accounts covering adjacent spans, `earlier` first. Order matters only to the
 * first and last readings; every other field is a sum, a minimum or a maximum.
 */
export function mergeLedgers(earlier: SessionLedger, later: SessionLedger): SessionLedger {
  return {
    countedMs: earlier.countedMs + later.countedMs,
    foreignMs: earlier.foreignMs + later.foreignMs,
    packAh: earlier.packAh + later.packAh,
    solarAh: earlier.solarAh + later.solarAh,
    houseWh: earlier.houseWh + later.houseWh,
    foreignAhFloor: earlier.foreignAhFloor + later.foreignAhFloor,
    packAhWholeSession: earlier.packAhWholeSession + later.packAhWholeSession,
    stateOfChargeFirst: earlier.stateOfChargeFirst ?? later.stateOfChargeFirst,
    stateOfChargeLast: later.stateOfChargeLast ?? earlier.stateOfChargeLast,
    stateOfChargeMin: lower(earlier.stateOfChargeMin, later.stateOfChargeMin),
    remainingCapacityFirstAh:
      earlier.remainingCapacityFirstAh ?? later.remainingCapacityFirstAh,
    remainingCapacityLastAh: later.remainingCapacityLastAh ?? earlier.remainingCapacityLastAh,
    pvPowerPeakW: higher(earlier.pvPowerPeakW, later.pvPowerPeakW),
  }
}

/**
 * What one row contributes on its own: the readings that bound the session rather than accumulate
 * across it. Carries no time and no integral, so folding a row twice cannot double-count charge.
 */
export function ledgerOfSample(sample: PairedSample): SessionLedger {
  const stateOfCharge = sample.pack === null ? null : sample.pack.stateOfCharge
  return {
    ...EMPTY_LEDGER,
    stateOfChargeFirst: stateOfCharge,
    stateOfChargeLast: stateOfCharge,
    stateOfChargeMin: stateOfCharge,
    remainingCapacityFirstAh: sample.pack === null ? null : sample.pack.remainingCapacityAh,
    remainingCapacityLastAh: sample.pack === null ? null : sample.pack.remainingCapacityAh,
    pvPowerPeakW: sample.solar === null ? null : sample.solar.pvPowerW,
  }
}

/**
 * What the span between two consecutive rows contributes. Trapezoid throughout: a load swinging
 * either side of zero moves almost no charge however loud either endpoint looks.
 *
 * A span wider than the gap bound contributes nothing at all. Spreading a rate across a hole is
 * the one arithmetic here that could invent charge the radios never reported.
 */
export function ledgerOfInterval(previous: PairedSample, current: PairedSample): SessionLedger {
  const elapsedMs = current.at - previous.at
  if (elapsedMs <= 0 || elapsedMs > MAX_SAMPLE_GAP_MS) return EMPTY_LEDGER

  // A span the pack did not cover contributes nothing, not even to the whole-session pack
  // integral: that integral is the cross-check against the BMS's own coulomb counter, and charge
  // that moved while the BMS was silent is charge neither of them can account for.
  const packBefore = previous.pack
  const packAfter = current.pack
  if (packBefore === null || packAfter === null) return EMPTY_LEDGER

  const packAmps = (packBefore.currentA + packAfter.currentA) / 2
  const packAhWholeSession = ampHoursOver(packAmps, elapsedMs)

  const solarBefore = solarCurrentOf(previous)
  const solarAfter = solarCurrentOf(current)
  if (solarBefore === null || solarAfter === null) {
    return { ...EMPTY_LEDGER, packAhWholeSession }
  }

  const solarAmps = (solarBefore + solarAfter) / 2
  const houseAmps = solarAmps - packAmps
  if (houseAmps < 0) {
    return {
      ...EMPTY_LEDGER,
      foreignMs: elapsedMs,
      foreignAhFloor: ampHoursOver(-houseAmps, elapsedMs),
      packAhWholeSession,
    }
  }

  // Energy integrates the product, not the product of the integrals: the bus voltage sags under
  // exactly the load being measured, so averaging the two apart would overstate a heavy hour.
  const powerBefore = (solarBefore - packBefore.currentA) * packBefore.packVoltageV
  const powerAfter = (solarAfter - packAfter.currentA) * packAfter.packVoltageV

  return {
    ...EMPTY_LEDGER,
    countedMs: elapsedMs,
    packAh: ampHoursOver(packAmps, elapsedMs),
    solarAh: ampHoursOver(solarAmps, elapsedMs),
    houseWh: hoursOf(elapsedMs) * ((powerBefore + powerAfter) / 2),
    packAhWholeSession,
  }
}

/**
 * Which radios spoke for the span between two rows, and whether the identity held across it.
 *
 * Coverage is stated in terms of what could be *computed*, not merely what arrived: an
 * advertisement carrying no battery current cannot enter `house = solar − pack`, so it is not
 * solar coverage. That keeps the tape and the ledger describing one window rather than two —
 * counted milliseconds are exactly the `both` runs, and the foreign window exactly the `foreign`
 * ones.
 */
export function classifyInterval(previous: PairedSample, current: PairedSample): CoverageClass {
  const elapsedMs = current.at - previous.at
  if (elapsedMs <= 0 || elapsedMs > MAX_SAMPLE_GAP_MS) return 'none'

  const packBefore = previous.pack
  const packAfter = current.pack
  const solarBefore = solarCurrentOf(previous)
  const solarAfter = solarCurrentOf(current)

  if (packBefore === null || packAfter === null) {
    return solarBefore !== null && solarAfter !== null ? 'solar-only' : 'none'
  }
  if (solarBefore === null || solarAfter === null) return 'pack-only'

  const packAmps = (packBefore.currentA + packAfter.currentA) / 2
  return (solarBefore + solarAfter) / 2 - packAmps >= 0 ? 'both' : 'foreign'
}

/** Extends the trailing run when the class is unchanged and the spans meet; appends otherwise. */
export function appendCoverage(
  runs: readonly CoverageRun[],
  from: number,
  to: number,
  kind: CoverageClass,
): readonly CoverageRun[] {
  if (to <= from) return runs

  const last = runs[runs.length - 1]
  if (last !== undefined && last.kind === kind && last.to === from) {
    return [...runs.slice(0, -1), { from: last.from, to, kind }]
  }
  return [...runs, { from, to, kind }]
}

/** The whole-session scan the incremental fold must agree with. */
export function foldAccount(samples: readonly PairedSample[]): SessionAccount {
  let ledger = EMPTY_LEDGER
  let coverage: readonly CoverageRun[] = []

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]
    if (index > 0) {
      const previous = samples[index - 1]
      ledger = mergeLedgers(ledger, ledgerOfInterval(previous, sample))
      coverage = appendCoverage(coverage, previous.at, sample.at, classifyInterval(previous, sample))
    }
    ledger = mergeLedgers(ledger, ledgerOfSample(sample))
  }

  return { ledger, coverage }
}

/**
 * Rebuilds both halves of the account from the stored streams. The pairing bound is a parameter
 * rather than a default because a recomputation that used a different bound from the recording
 * would disagree with the cached ledger for a reason nobody could see.
 */
export function recomputeAccount(
  pack: readonly PackSample[],
  solar: readonly SolarSample[],
  maxPairingAgeMs: number,
): SessionAccount {
  return foldAccount(pairSamples(pack, solar, maxPairingAgeMs))
}

export function recomputeLedger(
  pack: readonly PackSample[],
  solar: readonly SolarSample[],
  maxPairingAgeMs: number,
): SessionLedger {
  return recomputeAccount(pack, solar, maxPairingAgeMs).ledger
}

function hoursOf(elapsedMs: number): number {
  return elapsedMs / MS_PER_HOUR
}

function ampHoursOver(amps: number, elapsedMs: number): number {
  return amps * hoursOf(elapsedMs)
}

function lower(left: number | null, right: number | null): number | null {
  if (left === null) return right
  if (right === null) return left
  return Math.min(left, right)
}

function higher(left: number | null, right: number | null): number | null {
  if (left === null) return right
  if (right === null) return left
  return Math.max(left, right)
}
