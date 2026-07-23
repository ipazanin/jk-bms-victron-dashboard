/**
 * Reconciling the two radios.
 *
 * The charge controller reports the current it delivers. The BMS reports the pack's net
 * current, signed, positive when charging. Everything else on the bus is the difference:
 *
 *     house = solar - pack        e.g.  7.9 - (-8.4) = 16.3 A
 *
 * This is the figure neither vendor app can show, and it normally requires a shunt.
 * It holds only while no other source is charging the bank — with the engine running,
 * the alternator contributes an unmeasured term and the result is not a house load.
 */

import type { BatterySnapshot } from './bms/types'
import type { Reach } from './reach'
import type { SolarReading } from './solar/types'

/** Volts. Wider than a sense-wire drop means the two devices disagree about the bus. */
const VOLTAGE_AGREEMENT_TOLERANCE = 0.3

/**
 * Amps. A real house load only draws current, so house = solar − pack cannot go meaningfully
 * negative. The two radios measure independently — the controller quantises its current to
 * 0.1 A and the BMS carries its own offset — so a true-zero load can read a couple of tenths
 * below zero from noise alone. Beyond this floor the pack is taking more than the panels give,
 * which means an unmeasured charger (alternator, shore) is on the bus and the difference is no
 * longer a house load at all.
 */
const HOUSE_LOAD_NOISE_FLOOR = 0.5

export interface BusReconciliation {
  readonly solarCurrent: number
  readonly packCurrent: number
  readonly houseCurrent: number
  readonly housePower: number
  /** False when houseCurrent sinks past the noise floor: another source is charging the bank. */
  readonly houseLoadPlausible: boolean
  readonly voltageDelta: number
  readonly voltagesAgree: boolean
}

export interface HouseLoad {
  readonly currentA: number
  readonly powerW: number
  /** False when currentA sinks past the noise floor: another source is charging the bank. */
  readonly plausible: boolean
}

/**
 * The house load from three numbers, taking no snapshot and no reading.
 *
 * Two samples pulled out of an archive reach this by the same arithmetic the live instrument
 * uses, so the two can never drift. The result is derived on every read and never stored: a
 * correction to the noise floor corrects every recording already on disk.
 */
export function deriveHouse(
  packCurrentA: number,
  solarCurrentA: number,
  packVoltageV: number,
): HouseLoad {
  const currentA = solarCurrentA - packCurrentA
  return {
    currentA,
    powerW: currentA * packVoltageV,
    plausible: currentA >= -HOUSE_LOAD_NOISE_FLOOR,
  }
}

export function reconcile(battery: BatterySnapshot, solar: SolarReading): BusReconciliation | null {
  if (solar.batteryCurrent === null || solar.batteryVoltage === null) return null

  const house = deriveHouse(battery.current, solar.batteryCurrent, battery.packVoltage)
  const voltageDelta = solar.batteryVoltage - battery.packVoltage

  return {
    solarCurrent: solar.batteryCurrent,
    packCurrent: battery.current,
    houseCurrent: house.currentA,
    housePower: house.powerW,
    houseLoadPlausible: house.plausible,
    voltageDelta,
    voltagesAgree: Math.abs(voltageDelta) <= VOLTAGE_AGREEMENT_TOLERANCE,
  }
}

/**
 * Hours until the pack reaches its nominal capacity at `current`, or null when that current is
 * not charging. The rate is a parameter rather than `battery.current` because the snapshot's own
 * current is an instant, and an instant cannot answer a question measured in hours.
 */
export function hoursToFull(battery: BatterySnapshot, current: number): number | null {
  if (current <= 0.05) return null
  const deficit = battery.nominalCapacity - battery.remainingCapacity
  if (deficit <= 0) return 0
  return deficit / current
}

/** Hours until empty at `current`, or null when that current is not discharging. */
export function hoursToEmpty(battery: BatterySnapshot, current: number): number | null {
  if (current >= -0.05) return null
  return battery.remainingCapacity / Math.abs(current)
}

/** Amps. Below this net rate the pack is holding and no projection from it is honest. */
const HOLDING_ENTER = 0.15
/** Amps. The wider edge, so a rate parked on the boundary cannot flip the verdict every second. */
const HOLDING_LEAVE = 0.25
/** A window shorter than this describes the last few seconds, which is not a rate worth extending
 *  over hours. Both bounds must be met: thirty samples can arrive inside a single noisy second. */
const PROJECTION_MIN_SAMPLES = 30
const PROJECTION_MIN_SPAN_MS = 60_000

export type Projection =
  | { readonly kind: 'collecting' }
  | { readonly kind: 'holding'; readonly overMs: number }
  | { readonly kind: 'toFull' | 'toEmpty'; readonly hours: number; readonly overMs: number }

/**
 * A projection in hours is a claim about a sustained current, never about the latest sample.
 * Dividing capacity by an instant asserts that the instant holds for the hours the answer names,
 * and on a boat whose load cycles through zero that assertion is false twice a minute.
 *
 * The basis is the window's time-weighted mean, because runtime is an integral and the mean is
 * its only unbiased estimator. Not the median, which reads hundreds of hours on a window that is
 * ten samples at 1 A and two at 9 A; and not a gate on the samples agreeing in sign, which on a
 * cycling load withholds forever. A pack swinging ±5 A around a net −0.5 A has a real time to
 * empty and it is printed.
 *
 * `wasHolding` is the previous verdict's kind, held by the caller: the holding band is entered
 * and left at different rates, so a pack sitting on the boundary settles instead of chattering.
 */
export function project(
  battery: BatterySnapshot,
  reach: Reach | null,
  wasHolding: boolean,
): Projection {
  if (!reach || reach.count < PROJECTION_MIN_SAMPLES || reach.spanMs < PROJECTION_MIN_SPAN_MS) {
    return { kind: 'collecting' }
  }

  const floor = wasHolding ? HOLDING_LEAVE : HOLDING_ENTER
  if (Math.abs(reach.net) < floor) return { kind: 'holding', overMs: reach.spanMs }

  const charging = reach.net > 0
  const hours = charging ? hoursToFull(battery, reach.net) : hoursToEmpty(battery, reach.net)
  // Unreachable while the holding floor sits above the two deadbands, and cheaper to honour than
  // to prove: a widened deadband must withhold the figure, never print a null through toFixed.
  if (hours === null) return { kind: 'holding', overMs: reach.spanMs }

  return { kind: charging ? 'toFull' : 'toEmpty', hours, overMs: reach.spanMs }
}
