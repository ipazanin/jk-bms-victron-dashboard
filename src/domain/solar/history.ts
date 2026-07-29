/**
 * The history a Victron SmartSolar stores for itself: one record per day, plus a lifetime total.
 *
 * This is the other half of what the controller knows. The Instant Readout advertisement carries
 * only the present instant, so a boat that was not being watched has no series at all — except
 * here, where the controller has been keeping a day a register for as long as it has been powered.
 *
 *   0x104F            the totals record
 *   0x1050            today
 *   0x1051 .. 0x106E  yesterday back thirty days
 *
 * Every multi-byte field in a payload is little-endian. The register *ids* above are not, but that
 * is a property of the link that carries them, and no id is read here.
 *
 * The layouts come from Victron's published register list, not from a capture: the link that would
 * fetch these has never been observed replying, so nothing below has been seen on real bytes.
 */

import { NOT_AVAILABLE_U16, NOT_AVAILABLE_U32 } from './types'
import type { RecentChargerErrors, SolarHistoryDay, SolarHistoryTotals } from './types'

export const HISTORY_TOTALS_REGISTER = 0x104f
export const HISTORY_TODAY_REGISTER = 0x1050
/** Today plus thirty days back, which is every daily register the controller holds. */
export const MAX_HISTORY_DAYS = 31

const DAY_RECORD_LENGTH = 34
const TOTALS_RECORD_LENGTH = 34
/** Firmware before 1.17 stops after the day count, leaving out the battery-voltage minimum. */
const SHORT_TOTALS_RECORD_LENGTH = 19

/** Byte 0 says which of the three kinds of record the payload is. */
const DAY_RECORD_FLAG = 0x00
const TOTALS_RECORD_FLAG = 0x01
const UNWRITTEN_DAY_RECORD_FLAG = 0x04

/** The register holding the day `daysAgo` days before today. */
export function historyDayRegister(daysAgo: number): number {
  if (!Number.isInteger(daysAgo) || daysAgo < 0 || daysAgo >= MAX_HISTORY_DAYS) {
    throw new Error(`no solar history register for ${daysAgo} days ago`)
  }
  return HISTORY_TODAY_REGISTER + daysAgo
}

function describeFlag(flag: number): string {
  return `0x${flag.toString(16).padStart(2, '0')}`
}

function readErrors(payload: Uint8Array, offset: number): RecentChargerErrors {
  return [payload[offset], payload[offset + 1], payload[offset + 2], payload[offset + 3]]
}

export function decodeSolarHistoryDay(payload: Uint8Array): SolarHistoryDay {
  if (payload.length !== DAY_RECORD_LENGTH) {
    throw new Error(`solar history day record must be ${DAY_RECORD_LENGTH} bytes, got ${payload.length}`)
  }

  const flag = payload[0]
  if (flag === UNWRITTEN_DAY_RECORD_FLAG) return { recorded: false }
  if (flag !== DAY_RECORD_FLAG) {
    throw new Error(`not a solar history day record: flag ${describeFlag(flag)}`)
  }

  const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const consumed = data.getUint32(5, true)

  return {
    recorded: true,
    daySequenceNumber: data.getUint16(32, true),
    yieldKwh: data.getUint32(1, true) / 100,
    consumedKwh: consumed === NOT_AVAILABLE_U32 ? null : consumed / 100,
    maxBatteryVoltage: data.getUint16(9, true) / 100,
    minBatteryVoltage: data.getUint16(11, true) / 100,
    errorDatabase: payload[13],
    errors: readErrors(payload, 14),
    minutesInBulk: data.getUint16(18, true),
    minutesInAbsorption: data.getUint16(20, true),
    minutesInFloat: data.getUint16(22, true),
    maxPvPower: data.getUint32(24, true),
    maxBatteryCurrent: data.getUint16(28, true) / 10,
    maxPvVoltage: data.getUint16(30, true) / 100,
  }
}

export function decodeSolarHistoryTotals(payload: Uint8Array): SolarHistoryTotals {
  if (payload.length !== TOTALS_RECORD_LENGTH && payload.length !== SHORT_TOTALS_RECORD_LENGTH) {
    throw new Error(
      `solar history totals record must be ${SHORT_TOTALS_RECORD_LENGTH} or ${TOTALS_RECORD_LENGTH} bytes, ` +
        `got ${payload.length}`,
    )
  }

  const flag = payload[0]
  if (flag !== TOTALS_RECORD_FLAG) {
    throw new Error(`not a solar history totals record: flag ${describeFlag(flag)}`)
  }

  const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  // Reserved bytes read 0xFF, so a short record padded out to full length says nothing here either.
  const batteryMinimum = payload.length === TOTALS_RECORD_LENGTH ? data.getUint16(19, true) : NOT_AVAILABLE_U16

  return {
    errorDatabase: payload[1],
    errors: readErrors(payload, 2),
    resettableYieldKwh: data.getUint32(6, true) / 100,
    systemYieldKwh: data.getUint32(10, true) / 100,
    maxPvVoltage: data.getUint16(14, true) / 100,
    maxBatteryVoltage: data.getUint16(16, true) / 100,
    daysAvailable: payload[18],
    minBatteryVoltage: batteryMinimum === NOT_AVAILABLE_U16 ? null : batteryMinimum / 100,
  }
}
