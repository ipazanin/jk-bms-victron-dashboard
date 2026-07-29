/**
 * Decoding the history a SmartSolar stores for itself, checked against a real export.
 *
 * Every expected number here was exported from the controller whose registers these are — a
 * SmartSolar MPPT 100/50, product 0xA057, thirty-one days ending 2026-07-04. The payloads are not
 * real: the spec encodes each exported row into the documented register layout and asserts the
 * decoder reads the exported values back out.
 *
 * What that establishes: the offsets, the scales, the little-endian reads and the not-available
 * sentinels are consistent and reproduce vendor-exported values — including the ten-to-one relation
 * between the export's Wh and the register's 0.01 kWh unit, which is the easiest thing in the whole
 * layout to get wrong by three orders of magnitude.
 *
 * What it does not establish: that a controller emits this layout. No history payload has ever been
 * captured off the radio; the layout comes from Victron's published register list, and the link that
 * would carry it is not implemented. A test encoded from the same document that produced the decoder
 * cannot catch that document being wrong — only a capture can.
 */

import { describe, expect, it } from 'vitest'

import { hexToBytes } from './support/bytes'
import {
  HISTORY_TODAY_REGISTER,
  MAX_HISTORY_DAYS,
  decodeSolarHistoryDay,
  decodeSolarHistoryTotals,
  historyDayRegister,
} from '../src/domain/solar/history'
import { NOT_AVAILABLE_U32 } from '../src/domain/solar/types'
import type { RecentChargerErrors, RecordedSolarHistoryDay } from '../src/domain/solar/types'
import exported from './fixtures/solarHistoryDays.json'

type ExportedDay = (typeof exported.days)[number]

const DAY_RECORD_LENGTH = 34

/** The day record's fields at the register's own integer scales, before any byte is written. */
interface DayRegisterFields {
  readonly flag: number
  readonly yieldHundredthKwh: number
  readonly consumedHundredthKwh: number
  readonly maxBatteryCentivolts: number
  readonly minBatteryCentivolts: number
  readonly errorDatabase: number
  readonly errors: RecentChargerErrors
  readonly minutesInBulk: number
  readonly minutesInAbsorption: number
  readonly minutesInFloat: number
  readonly maxPvWatts: number
  readonly maxBatteryDeciamps: number
  readonly maxPvCentivolts: number
  readonly daySequenceNumber: number
}

/** A controller with no load output, which is what this one is, reports consumption as absent. */
const DAY_DEFAULTS: DayRegisterFields = {
  flag: 0x00,
  yieldHundredthKwh: 0,
  consumedHundredthKwh: NOT_AVAILABLE_U32,
  maxBatteryCentivolts: 0,
  minBatteryCentivolts: 0,
  errorDatabase: 0,
  errors: [0, 0, 0, 0],
  minutesInBulk: 0,
  minutesInAbsorption: 0,
  minutesInFloat: 0,
  maxPvWatts: 0,
  maxBatteryDeciamps: 0,
  maxPvCentivolts: 0,
  daySequenceNumber: 0,
}

interface TotalsRegisterFields {
  readonly flag: number
  readonly errorDatabase: number
  readonly errors: RecentChargerErrors
  readonly resettableHundredthKwh: number
  readonly systemHundredthKwh: number
  readonly maxPvCentivolts: number
  readonly maxBatteryCentivolts: number
  readonly daysAvailable: number
  readonly minBatteryCentivolts: number
}

const TOTALS_DEFAULTS: TotalsRegisterFields = {
  flag: 0x01,
  errorDatabase: 0,
  errors: [0, 0, 0, 0],
  resettableHundredthKwh: 0,
  systemHundredthKwh: 0,
  maxPvCentivolts: 0,
  maxBatteryCentivolts: 0,
  daysAvailable: 0,
  minBatteryCentivolts: 0,
}

/** A day record laid out the way the controller lays one out: little-endian, at register scales. */
function encodeHistoryDay(overrides: Partial<DayRegisterFields> = {}): Uint8Array {
  const fields = { ...DAY_DEFAULTS, ...overrides }
  const payload = new Uint8Array(DAY_RECORD_LENGTH)
  const data = new DataView(payload.buffer)

  payload[0] = fields.flag
  data.setUint32(1, fields.yieldHundredthKwh, true)
  data.setUint32(5, fields.consumedHundredthKwh, true)
  data.setUint16(9, fields.maxBatteryCentivolts, true)
  data.setUint16(11, fields.minBatteryCentivolts, true)
  payload[13] = fields.errorDatabase
  payload.set(fields.errors, 14)
  data.setUint16(18, fields.minutesInBulk, true)
  data.setUint16(20, fields.minutesInAbsorption, true)
  data.setUint16(22, fields.minutesInFloat, true)
  data.setUint32(24, fields.maxPvWatts, true)
  data.setUint16(28, fields.maxBatteryDeciamps, true)
  data.setUint16(30, fields.maxPvCentivolts, true)
  data.setUint16(32, fields.daySequenceNumber, true)

  return payload
}

/** The full 34-byte totals record; its reserved tail reads 0xFF the way the controller writes it. */
function encodeHistoryTotals(overrides: Partial<TotalsRegisterFields> = {}): Uint8Array {
  const fields = { ...TOTALS_DEFAULTS, ...overrides }
  const payload = new Uint8Array(34)
  payload.fill(0xff, 21)
  const data = new DataView(payload.buffer)

  payload[0] = fields.flag
  payload[1] = fields.errorDatabase
  payload.set(fields.errors, 2)
  data.setUint32(6, fields.resettableHundredthKwh, true)
  data.setUint32(10, fields.systemHundredthKwh, true)
  data.setUint16(14, fields.maxPvCentivolts, true)
  data.setUint16(16, fields.maxBatteryCentivolts, true)
  payload[18] = fields.daysAvailable
  data.setUint16(19, fields.minBatteryCentivolts, true)

  return payload
}

/** An exported row at register scales. The export's Wh are ten to the register's 0.01 kWh unit. */
function encodeExportedDay(day: ExportedDay, overrides: Partial<DayRegisterFields> = {}): Uint8Array {
  return encodeHistoryDay({
    yieldHundredthKwh: Math.round(day.yieldWh / 10),
    maxBatteryCentivolts: Math.round(day.maxBatteryVoltageV * 100),
    minBatteryCentivolts: Math.round(day.minBatteryVoltageV * 100),
    errors: [day.errors[0], day.errors[1], day.errors[2], day.errors[3]],
    minutesInBulk: day.minutesInBulk,
    minutesInAbsorption: day.minutesInAbsorption,
    minutesInFloat: day.minutesInFloat,
    maxPvWatts: day.maxPvPowerW,
    maxPvCentivolts: Math.round(day.maxPvVoltageV * 100),
    ...overrides,
  })
}

function recordedDay(payload: Uint8Array): RecordedSolarHistoryDay {
  const day = decodeSolarHistoryDay(payload)
  if (!day.recorded) throw new Error('expected a recorded day, got an unwritten register')
  return day
}

function hex(payload: Uint8Array): string {
  return Buffer.from(payload).toString('hex')
}

function exportedDay(daysAgo: number): ExportedDay {
  const day = exported.days.find((candidate) => candidate.daysAgo === daysAgo)
  if (!day) throw new Error(`the fixture holds no row ${daysAgo} days ago`)
  return day
}

const highestYieldDay = exportedDay(12)
const lowestYieldDay = exportedDay(10)
const bulkHeavyDay = exportedDay(13)

/** Sequence numbers count down as a day ages, so today's minus the age names each exported day. */
const TODAY_SEQUENCE = 200

describe('decodeSolarHistoryDay against the exported days', () => {
  exported.days.forEach((day) => {
    it(`reads ${day.date} back at the exported values (${day.case})`, () => {
      const daySequenceNumber = TODAY_SEQUENCE - day.daysAgo
      const record = recordedDay(encodeExportedDay(day, { daySequenceNumber }))

      expect(record.yieldKwh * 1000).toBeCloseTo(day.yieldWh, 6)
      expect(record.maxPvPower).toBe(day.maxPvPowerW)
      expect(record.maxPvVoltage).toBeCloseTo(day.maxPvVoltageV, 3)
      expect(record.minBatteryVoltage).toBeCloseTo(day.minBatteryVoltageV, 3)
      expect(record.maxBatteryVoltage).toBeCloseTo(day.maxBatteryVoltageV, 3)
      expect(record.minutesInBulk).toBe(day.minutesInBulk)
      expect(record.minutesInAbsorption).toBe(day.minutesInAbsorption)
      expect(record.minutesInFloat).toBe(day.minutesInFloat)
      expect(record.errors).toEqual(day.errors)
      expect(record.errorDatabase).toBe(0)
      expect(record.daySequenceNumber).toBe(daySequenceNumber)
    })
  })

  it('holds the 10 Wh register unit apart from the kilowatt-hour it scales to', () => {
    // 1630 Wh exported is 163 register units, one hundredth of a kWh each.
    const payload = encodeExportedDay(highestYieldDay)
    expect(payload[1]).toBe(163)
    expect(recordedDay(payload).yieldKwh).toBeCloseTo(1.63, 6)

    // The lowest day in the export is 70 Wh — seven units, not seventy and not seven thousand.
    expect(encodeExportedDay(lowestYieldDay)[1]).toBe(7)
    expect(recordedDay(encodeExportedDay(lowestYieldDay)).yieldKwh).toBeCloseTo(0.07, 6)
  })

  it('keeps a bulk-heavy day apart from a float-heavy one', () => {
    const bulkHeavy = recordedDay(encodeExportedDay(bulkHeavyDay))
    const floatHeavy = recordedDay(encodeExportedDay(lowestYieldDay))

    expect(bulkHeavy.minutesInBulk).toBeGreaterThan(bulkHeavy.minutesInFloat)
    expect(floatHeavy.minutesInFloat).toBeGreaterThan(floatHeavy.minutesInBulk)
    expect(bulkHeavy.minutesInBulk).toBe(500)
    expect(floatHeavy.minutesInBulk).toBe(93)
  })

  it('reads a hand-laid payload field by field, low byte first', () => {
    // The highest-yield exported day written out by hand, so the offsets are checked against
    // something the spec's own encoder did not produce. A big-endian yield read here would be
    // 0xa3000000 units — 27 million kWh from one June day.
    const payload = hexToBytes('00a3000000ffffffff9505f1040000000000e90184003d0149010000b9006308bc00')
    expect(payload).toHaveLength(DAY_RECORD_LENGTH)

    const record = recordedDay(payload)
    expect(record).toEqual({
      recorded: true,
      daySequenceNumber: 188,
      yieldKwh: 1.63,
      consumedKwh: null,
      maxBatteryVoltage: 14.29,
      minBatteryVoltage: 12.65,
      errorDatabase: 0,
      errors: [0, 0, 0, 0],
      minutesInBulk: 489,
      minutesInAbsorption: 132,
      minutesInFloat: 317,
      maxPvPower: 329,
      maxBatteryCurrent: 18.5,
      maxPvVoltage: 21.47,
    })
    const encoded = encodeExportedDay(highestYieldDay, { daySequenceNumber: 188, maxBatteryDeciamps: 185 })
    expect(hex(encoded)).toBe(hex(payload))
  })

  it('scales maximum battery current by a tenth of an amp', () => {
    expect(recordedDay(encodeHistoryDay({ maxBatteryDeciamps: 287 })).maxBatteryCurrent).toBeCloseTo(28.7, 6)
  })
})

describe('decodeSolarHistoryDay sentinels and refusals', () => {
  it('reports no consumption on a controller without a load output', () => {
    expect(recordedDay(encodeHistoryDay()).consumedKwh).toBeNull()
    expect(hex(encodeHistoryDay().slice(5, 9))).toBe('ffffffff')
  })

  it('reads a real consumption figure where a load output reports one', () => {
    expect(recordedDay(encodeHistoryDay({ consumedHundredthKwh: 42 })).consumedKwh).toBeCloseTo(0.42, 6)
  })

  it('rejects a payload that is not exactly the record length', () => {
    const payload = encodeExportedDay(highestYieldDay)
    expect(() => decodeSolarHistoryDay(payload.slice(0, 33))).toThrow(/must be 34 bytes, got 33/)
    expect(() => decodeSolarHistoryDay(new Uint8Array(35))).toThrow(/must be 34 bytes, got 35/)
    expect(() => decodeSolarHistoryDay(new Uint8Array(0))).toThrow(/must be 34 bytes, got 0/)
    expect(() => decodeSolarHistoryDay(new Uint8Array(19))).toThrow(/must be 34 bytes, got 19/)
  })

  it('refuses a totals record handed to it, rather than decoding it as a day', () => {
    expect(() => decodeSolarHistoryDay(encodeHistoryTotals())).toThrow(/flag 0x01/)
    expect(() => decodeSolarHistoryDay(encodeHistoryDay({ flag: 0x02 }))).toThrow(/flag 0x02/)
  })
})

describe('a day with no data is not a day with no yield', () => {
  it('reports an unwritten register as unwritten', () => {
    const unwritten = decodeSolarHistoryDay(encodeHistoryDay({ flag: 0x04 }))
    expect(unwritten.recorded).toBe(false)
    expect(unwritten).toEqual({ recorded: false })
  })

  it('reports a genuine zero-yield day as a record that happens to read zero', () => {
    // A boat under cover for a day: the controller recorded the day, and the day was nothing.
    const covered = recordedDay(
      encodeHistoryDay({ minBatteryCentivolts: 1265, maxBatteryCentivolts: 1298, daySequenceNumber: 191 }),
    )

    expect(covered.yieldKwh).toBe(0)
    expect(covered.minBatteryVoltage).toBeCloseTo(12.65, 3)
    expect(covered.daySequenceNumber).toBe(191)
    expect(decodeSolarHistoryDay(encodeHistoryDay({ flag: 0x04 })).recorded).toBe(false)
  })
})

describe('the day sequence number', () => {
  it('round-trips every value in the year, including either side of the wrap', () => {
    for (const sequence of [0, 1, 180, 363, 364, 365]) {
      expect(recordedDay(encodeHistoryDay({ daySequenceNumber: sequence })).daySequenceNumber).toBe(sequence)
    }
  })

  it('carries a backlog that straddles the wrap without renumbering it', () => {
    // Today numbered 1 puts the record two days old at 364: the decoder reports both as stored,
    // and nothing here decides which is the earlier day.
    const today = recordedDay(encodeHistoryDay({ daySequenceNumber: 1 }))
    const twoDaysAgo = recordedDay(encodeHistoryDay({ daySequenceNumber: 364 }))

    expect(today.daySequenceNumber).toBe(1)
    expect(twoDaysAgo.daySequenceNumber).toBe(364)
  })
})

describe('decodeSolarHistoryTotals', () => {
  const totals = exported.totals
  const full = encodeHistoryTotals({
    resettableHundredthKwh: 8821,
    systemHundredthKwh: 41235,
    maxPvCentivolts: Math.round(totals.maxPvVoltageV * 100),
    maxBatteryCentivolts: Math.round(totals.maxBatteryVoltageV * 100),
    daysAvailable: totals.daysAvailable,
    minBatteryCentivolts: Math.round(totals.minBatteryVoltageV * 100),
  })

  it('reads both yield counters and the extremes at the exported scales', () => {
    const record = decodeSolarHistoryTotals(full)

    expect(record.resettableYieldKwh).toBeCloseTo(88.21, 6)
    expect(record.systemYieldKwh).toBeCloseTo(412.35, 6)
    expect(record.maxPvVoltage).toBeCloseTo(totals.maxPvVoltageV, 3)
    expect(record.maxBatteryVoltage).toBeCloseTo(totals.maxBatteryVoltageV, 3)
    expect(record.minBatteryVoltage).toBeCloseTo(totals.minBatteryVoltageV, 3)
    expect(record.errors).toEqual([0, 0, 0, 0])
  })

  it('reports how many daily registers hold data, which is what bounds a fetch', () => {
    expect(decodeSolarHistoryTotals(full).daysAvailable).toBe(totals.daysAvailable)
    expect(decodeSolarHistoryTotals(full).daysAvailable).toBeLessThanOrEqual(MAX_HISTORY_DAYS)
  })

  it('reports no battery-voltage minimum on the 19-byte firmware 1.16 record', () => {
    const short = full.slice(0, 19)
    const record = decodeSolarHistoryTotals(short)

    expect(record.minBatteryVoltage).toBeNull()
    expect(record.daysAvailable).toBe(totals.daysAvailable)
    expect(record.systemYieldKwh).toBeCloseTo(412.35, 6)
  })

  it('reports no battery-voltage minimum when the field reads as reserved padding', () => {
    // 0xFFFF there is a short record padded out to full length, not a 655 V battery.
    const padded = full.slice()
    padded.fill(0xff, 19, 21)
    expect(decodeSolarHistoryTotals(padded).minBatteryVoltage).toBeNull()
  })

  it('rejects a payload of neither documented length', () => {
    expect(() => decodeSolarHistoryTotals(full.slice(0, 20))).toThrow(/19 or 34 bytes, got 20/)
    expect(() => decodeSolarHistoryTotals(full.slice(0, 18))).toThrow(/19 or 34 bytes, got 18/)
    expect(() => decodeSolarHistoryTotals(new Uint8Array(0))).toThrow(/19 or 34 bytes, got 0/)
  })

  it('refuses a day record handed to it', () => {
    expect(() => decodeSolarHistoryTotals(encodeExportedDay(highestYieldDay))).toThrow(/flag 0x00/)
    expect(() => decodeSolarHistoryTotals(encodeHistoryDay({ flag: 0x04 }))).toThrow(/flag 0x04/)
  })
})

describe('historyDayRegister', () => {
  it('maps an age in days onto the register holding it', () => {
    expect(historyDayRegister(0)).toBe(HISTORY_TODAY_REGISTER)
    expect(historyDayRegister(0)).toBe(0x1050)
    expect(historyDayRegister(1)).toBe(0x1051)
    expect(historyDayRegister(MAX_HISTORY_DAYS - 1)).toBe(0x106e)
  })

  it('refuses an age the controller keeps no register for', () => {
    expect(() => historyDayRegister(-1)).toThrow(/-1 days ago/)
    expect(() => historyDayRegister(MAX_HISTORY_DAYS)).toThrow(/31 days ago/)
    expect(() => historyDayRegister(1.5)).toThrow(/1.5 days ago/)
  })
})
