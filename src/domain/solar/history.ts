/**
 * The history a Victron SmartSolar stores for itself: one record per day, plus a lifetime total.
 *
 * This is the other half of what the controller knows. The Instant Readout advertisement carries
 * only the present instant, so a boat nobody was watching has no series at all — except here, where
 * the controller has been writing a day a register for as long as it has been powered.
 *
 * The layouts below are settled on real bytes, not on a published register list. A SmartSolar MPPT
 * 100/50 answered the totals register and all thirty-one daily registers over the 306b tunnel, and
 * VictronConnect exported the same controller's history to CSV from the same session. Decoded this
 * way, every one of the 232 field comparisons against that export agrees exactly — yield, both
 * battery-voltage extremes, peak panel power and panel voltage, and all three charge-stage
 * durations, over twenty-nine days. The payloads and the export are checked in as
 * `tests/fixtures/solarHistoryWire.json`, and the spec re-derives every number from them.
 *
 *   0x104F            the totals record
 *   0x1050            today
 *   0x1051 .. 0x106E  yesterday back thirty days
 *
 * Every multi-byte field in a payload is little-endian. The register ids are not, but that belongs
 * to the link that carries them and no id is read here.
 *
 * What bounds a fetch is `daysAvailable` out of the totals record — not the capability word in
 * register 0x0140. The controller does answer 0x0140, with 0x0809EF76 and the history bit set, so
 * gating on it would happen to work; it is still the wrong instrument. A capability word is a
 * second opinion about whether the data exists, and a negative one is indistinguishable from a
 * misread bit, a firmware quirk or a wrong register — which is how a controller that serves every
 * record asked of it gets written off as refusing history. Read the totals register, trust the day
 * count it reports, and let an unwritten register say so for itself.
 */

import { NOT_AVAILABLE_U16, NOT_AVAILABLE_U32 } from './types'
import type { RecentChargerErrors } from './RecentChargerErrors'
import type { SolarHistoryDay } from './SolarHistoryDay'
import type { SolarHistoryTotals } from './SolarHistoryTotals'

const DAY_RECORD_LENGTH = 34
const TOTALS_RECORD_LENGTH = 34
/** Firmware before 1.17 stops after the day count, leaving out the battery-voltage minimum. */
const SHORT_TOTALS_RECORD_LENGTH = 19

/** Byte 0 says which of the three kinds of record the payload is. */
const RECORD_FLAG_OFFSET = 0
const DAY_RECORD_FLAG = 0x00
const TOTALS_RECORD_FLAG = 0x01
const UNWRITTEN_DAY_RECORD_FLAG = 0x04

const DAY_YIELD_OFFSET = 1
const DAY_CONSUMED_OFFSET = 5
const DAY_MAX_BATTERY_VOLTAGE_OFFSET = 9
const DAY_MIN_BATTERY_VOLTAGE_OFFSET = 11
const DAY_ERROR_DATABASE_OFFSET = 13
const DAY_ERRORS_OFFSET = 14
const DAY_MINUTES_IN_BULK_OFFSET = 18
const DAY_MINUTES_IN_ABSORPTION_OFFSET = 20
const DAY_MINUTES_IN_FLOAT_OFFSET = 22
const DAY_MAX_PV_POWER_OFFSET = 24
const DAY_MAX_BATTERY_CURRENT_OFFSET = 28
const DAY_MAX_PV_VOLTAGE_OFFSET = 30
const DAY_SEQUENCE_NUMBER_OFFSET = 32

const TOTALS_ERROR_DATABASE_OFFSET = 1
const TOTALS_ERRORS_OFFSET = 2
const TOTALS_RESETTABLE_YIELD_OFFSET = 6
const TOTALS_SYSTEM_YIELD_OFFSET = 10
const TOTALS_MAX_PV_VOLTAGE_OFFSET = 14
const TOTALS_MAX_BATTERY_VOLTAGE_OFFSET = 16
const TOTALS_DAYS_AVAILABLE_OFFSET = 18
const TOTALS_MIN_BATTERY_VOLTAGE_OFFSET = 19

/**
 * The register's own units. Energy counts in hundredths of a kilowatt-hour, so a day of 990 Wh
 * arrives as 99; both voltage extremes count in hundredths of a volt; battery current counts in
 * tenths of an amp, alone among the fields here.
 *
 * Divisors, not reciprocal multipliers. Scaling by 0.01 lands 95 on 0.9500000000000001, which the
 * vendor's own export then disagrees with in the last place on a fifth of the captured days.
 */
const HUNDREDTHS_PER_KWH = 100
const CENTIVOLTS_PER_VOLT = 100
const DECIAMPS_PER_AMP = 10

function describeFlag(flag: number): string {
  return `0x${flag.toString(16).padStart(2, '0')}`
}

function readErrors(payload: Uint8Array, offset: number): RecentChargerErrors {
  return [payload[offset], payload[offset + 1], payload[offset + 2], payload[offset + 3]]
}

/**
 * One daily register's payload.
 *
 * Byte 0 decides between a day and a register the controller has not reached yet; every other byte
 * is read only once that has been settled, so an unwritten register can never contribute a zero to
 * a chart. A payload carrying any other flag is not a day record at all and throws: the totals
 * record read through these offsets reports four gigawatts of panel power off its reserved tail.
 */
export function decodeSolarHistoryDay(payload: Uint8Array): SolarHistoryDay {
  if (payload.length !== DAY_RECORD_LENGTH) {
    throw new Error(`solar history day record must be ${DAY_RECORD_LENGTH} bytes, got ${payload.length}`)
  }

  const flag = payload[RECORD_FLAG_OFFSET]
  if (flag === UNWRITTEN_DAY_RECORD_FLAG) return { recorded: false }
  if (flag !== DAY_RECORD_FLAG) {
    throw new Error(`not a solar history day record: flag ${describeFlag(flag)}`)
  }

  const record = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const consumedEnergy = record.getUint32(DAY_CONSUMED_OFFSET, true)

  return {
    recorded: true,
    daySequenceNumber: record.getUint16(DAY_SEQUENCE_NUMBER_OFFSET, true),
    yieldKwh: record.getUint32(DAY_YIELD_OFFSET, true) / HUNDREDTHS_PER_KWH,
    consumedKwh: consumedEnergy === NOT_AVAILABLE_U32 ? null : consumedEnergy / HUNDREDTHS_PER_KWH,
    maxBatteryVoltage: record.getUint16(DAY_MAX_BATTERY_VOLTAGE_OFFSET, true) / CENTIVOLTS_PER_VOLT,
    minBatteryVoltage: record.getUint16(DAY_MIN_BATTERY_VOLTAGE_OFFSET, true) / CENTIVOLTS_PER_VOLT,
    errorDatabase: payload[DAY_ERROR_DATABASE_OFFSET],
    errors: readErrors(payload, DAY_ERRORS_OFFSET),
    minutesInBulk: record.getUint16(DAY_MINUTES_IN_BULK_OFFSET, true),
    minutesInAbsorption: record.getUint16(DAY_MINUTES_IN_ABSORPTION_OFFSET, true),
    minutesInFloat: record.getUint16(DAY_MINUTES_IN_FLOAT_OFFSET, true),
    maxPvPower: record.getUint32(DAY_MAX_PV_POWER_OFFSET, true),
    maxBatteryCurrent: record.getUint16(DAY_MAX_BATTERY_CURRENT_OFFSET, true) / DECIAMPS_PER_AMP,
    maxPvVoltage: record.getUint16(DAY_MAX_PV_VOLTAGE_OFFSET, true) / CENTIVOLTS_PER_VOLT,
  }
}

/**
 * The totals register's payload.
 *
 * Two lengths arrive from the field, and the length alone decides which fields exist: firmware
 * before 1.17 ends the record at the day count. Byte 0 is not consulted for that — it says what
 * kind of record this is, never how much of one there is, and a decoder that inferred the shorter
 * layout from a flag would misread the day a Victron firmware update changes it.
 */
export function decodeSolarHistoryTotals(payload: Uint8Array): SolarHistoryTotals {
  if (payload.length !== TOTALS_RECORD_LENGTH && payload.length !== SHORT_TOTALS_RECORD_LENGTH) {
    throw new Error(
      `solar history totals record must be ${SHORT_TOTALS_RECORD_LENGTH} or ${TOTALS_RECORD_LENGTH} bytes, ` +
        `got ${payload.length}`,
    )
  }

  const flag = payload[RECORD_FLAG_OFFSET]
  if (flag !== TOTALS_RECORD_FLAG) {
    throw new Error(`not a solar history totals record: flag ${describeFlag(flag)}`)
  }

  const record = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  // Bytes 21 upward are reserved and read 0xFF on the captured record, so a short record padded out
  // to full length says nothing at offset 19 either.
  const batteryMinimum =
    payload.length === TOTALS_RECORD_LENGTH
      ? record.getUint16(TOTALS_MIN_BATTERY_VOLTAGE_OFFSET, true)
      : NOT_AVAILABLE_U16

  return {
    errorDatabase: payload[TOTALS_ERROR_DATABASE_OFFSET],
    errors: readErrors(payload, TOTALS_ERRORS_OFFSET),
    resettableYieldKwh: record.getUint32(TOTALS_RESETTABLE_YIELD_OFFSET, true) / HUNDREDTHS_PER_KWH,
    systemYieldKwh: record.getUint32(TOTALS_SYSTEM_YIELD_OFFSET, true) / HUNDREDTHS_PER_KWH,
    maxPvVoltage: record.getUint16(TOTALS_MAX_PV_VOLTAGE_OFFSET, true) / CENTIVOLTS_PER_VOLT,
    maxBatteryVoltage: record.getUint16(TOTALS_MAX_BATTERY_VOLTAGE_OFFSET, true) / CENTIVOLTS_PER_VOLT,
    daysAvailable: payload[TOTALS_DAYS_AVAILABLE_OFFSET],
    minBatteryVoltage: batteryMinimum === NOT_AVAILABLE_U16 ? null : batteryMinimum / CENTIVOLTS_PER_VOLT,
  }
}
