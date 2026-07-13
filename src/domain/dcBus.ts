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

export function reconcile(battery: BatterySnapshot, solar: SolarReading): BusReconciliation | null {
  if (solar.batteryCurrent === null || solar.batteryVoltage === null) return null

  const houseCurrent = solar.batteryCurrent - battery.current
  const voltageDelta = solar.batteryVoltage - battery.packVoltage

  return {
    solarCurrent: solar.batteryCurrent,
    packCurrent: battery.current,
    houseCurrent,
    housePower: houseCurrent * battery.packVoltage,
    houseLoadPlausible: houseCurrent >= -HOUSE_LOAD_NOISE_FLOOR,
    voltageDelta,
    voltagesAgree: Math.abs(voltageDelta) <= VOLTAGE_AGREEMENT_TOLERANCE,
  }
}

/** Hours until the pack reaches its nominal capacity, or null when not charging. */
export function hoursToFull(battery: BatterySnapshot): number | null {
  if (battery.current <= 0.05) return null
  const deficit = battery.nominalCapacity - battery.remainingCapacity
  if (deficit <= 0) return 0
  return deficit / battery.current
}

/** Hours until empty at the present draw, or null when not discharging. */
export function hoursToEmpty(battery: BatterySnapshot): number | null {
  if (battery.current >= -0.05) return null
  return battery.remainingCapacity / Math.abs(battery.current)
}
