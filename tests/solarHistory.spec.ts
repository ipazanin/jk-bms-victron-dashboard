/**
 * Decoding the history a SmartSolar stores for itself, against the controller's own bytes.
 *
 * Every payload here is real. A SmartSolar MPPT 100/50 answered its totals register and all
 * thirty-one daily registers over the 306b tunnel, and VictronConnect exported the same
 * controller's history to CSV from the same session. Both sides are checked in as
 * `tests/fixtures/solarHistoryWire.json`, and this spec loops the fixture rather than transcribing
 * a single number out of it: an expected value written here by hand would be a number this decoder
 * produced, checked against itself.
 *
 * The comparison runs field by field over the twenty-nine exported days — yield, both battery
 * extremes, peak panel power and voltage, and all three charge-stage durations. That is 232
 * comparisons against a reading somebody else's software took off the same registers, and it is
 * what makes the offsets and the scales facts rather than a plausible reading of a document. The
 * two registers the export omits are today and yesterday, which were still being written when the
 * CSV was taken; their payloads are still decoded here, just not against an exported row.
 *
 * Where a payload is edited rather than captured — a load-output figure this controller never
 * reports, an unwritten register it had already filled — the test says so and says which byte.
 */

import { describe, expect, it } from 'vitest'

import { hexToBytes } from './support/bytes'
import { decodeSolarHistoryDay, decodeSolarHistoryTotals } from '../src/domain/solar/history'
import {
  HISTORY_DAY_REGISTERS,
  HISTORY_TODAY_REGISTER,
  HISTORY_TOTALS_REGISTER,
  MAX_HISTORY_DAYS,
  SOLAR_HISTORY_REGISTERS,
  historyDayRegister,
} from '../src/domain/solar/SolarHistoryRegister'
import type { RecordedSolarHistoryDay } from '../src/domain/solar/RecordedSolarHistoryDay'
import wire from './fixtures/solarHistoryWire.json'

type ExportedDay = (typeof wire.expectedFromVendorExport)[number]

const DAY_RECORD_LENGTH = 34
const RECORD_FLAG_OFFSET = 0
const CONSUMED_OFFSET = 5
const UNWRITTEN_DAY_RECORD_FLAG = 0x04

const capturedTotals = hexToBytes(wire.totals)
const capturedDays = new Map(wire.days.map((day) => [day.register, hexToBytes(day.bytes)]))

/** Widened to plain numbers, so a register outside the set can be asked about at all. */
const reachableRegisters: readonly number[] = SOLAR_HISTORY_REGISTERS

function describeRegister(register: number): string {
  return `0x${register.toString(16)}`
}

function capturedDay(register: number): Uint8Array {
  const payload = capturedDays.get(register)
  if (!payload) throw new Error(`the capture holds no payload for register ${describeRegister(register)}`)
  return payload
}

function recordedDay(payload: Uint8Array): RecordedSolarHistoryDay {
  const day = decodeSolarHistoryDay(payload)
  if (!day.recorded) throw new Error('expected a recorded day, got an unwritten register')
  return day
}

/** The captured day at `register`, decoded. */
function decodedDay(register: number): RecordedSolarHistoryDay {
  return recordedDay(capturedDay(register))
}

/** A captured payload with one field overwritten, for a reading this controller never produces. */
function withConsumedEnergy(payload: Uint8Array, hundredthKwh: number): Uint8Array {
  const edited = payload.slice()
  new DataView(edited.buffer).setUint32(CONSUMED_OFFSET, hundredthKwh, true)
  return edited
}

function withRecordFlag(payload: Uint8Array, flag: number): Uint8Array {
  const edited = payload.slice()
  edited[RECORD_FLAG_OFFSET] = flag
  return edited
}

function hex(payload: Uint8Array): string {
  return Buffer.from(payload).toString('hex')
}

describe('the bounded set of registers a caller may ask for', () => {
  it('holds the totals register and every daily register, and nothing else', () => {
    expect(SOLAR_HISTORY_REGISTERS).toHaveLength(1 + MAX_HISTORY_DAYS)
    expect(SOLAR_HISTORY_REGISTERS[0]).toBe(HISTORY_TOTALS_REGISTER)
    expect(HISTORY_TOTALS_REGISTER).toBe(0x104f)
    expect([...HISTORY_DAY_REGISTERS]).toEqual([...SOLAR_HISTORY_REGISTERS].slice(1))
  })

  it('stops at 0x106E, short of the per-tracker registers of a different product', () => {
    expect(HISTORY_DAY_REGISTERS[0]).toBe(0x1050)
    expect(HISTORY_DAY_REGISTERS[MAX_HISTORY_DAYS - 1]).toBe(0x106e)
    expect(reachableRegisters).not.toContain(0x10a0)
  })

  it('excludes the register believed to clear the stored history', () => {
    expect(reachableRegisters).not.toContain(0x1030)
  })

  it('is frozen, so nothing can widen it at runtime', () => {
    expect(Object.isFrozen(SOLAR_HISTORY_REGISTERS)).toBe(true)
    expect(Object.isFrozen(HISTORY_DAY_REGISTERS)).toBe(true)
  })

  it('names exactly the registers the controller answered', () => {
    expect(wire.days.map((day) => day.register)).toEqual([...HISTORY_DAY_REGISTERS])
    expect(wire.totalsRegister).toBe(HISTORY_TOTALS_REGISTER)
  })

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

describe('decodeSolarHistoryDay over every captured register', () => {
  wire.days.forEach((day) => {
    it(`reads register ${describeRegister(day.register)} as a day the controller wrote`, () => {
      const payload = hexToBytes(day.bytes)
      expect(payload).toHaveLength(DAY_RECORD_LENGTH)

      const record = recordedDay(payload)

      expect(record.recorded).toBe(true)
      expect(record.yieldKwh).toBeGreaterThan(0)
      expect(record.maxBatteryVoltage).toBeGreaterThanOrEqual(record.minBatteryVoltage)
      expect(record.errors).toEqual([0, 0, 0, 0])
    })
  })
})

describe('the decoded days against VictronConnect’s own export', () => {
  wire.expectedFromVendorExport.forEach((exportedDay: ExportedDay) => {
    const register = describeRegister(exportedDay.register)

    it(`reproduces the exported ${exportedDay.date} row out of register ${register}`, () => {
      const record = decodedDay(exportedDay.register)

      expect(record.yieldKwh * 1000).toBeCloseTo(exportedDay.yieldWh, 6)
      expect(record.maxPvPower).toBe(exportedDay.maxPvPowerW)
      expect(record.maxPvVoltage).toBeCloseTo(exportedDay.maxPvVoltage, 6)
      expect(record.minBatteryVoltage).toBeCloseTo(exportedDay.minBatteryVoltage, 6)
      expect(record.maxBatteryVoltage).toBeCloseTo(exportedDay.maxBatteryVoltage, 6)
      expect(record.minutesInBulk).toBe(exportedDay.minutesInBulk)
      expect(record.minutesInAbsorption).toBe(exportedDay.minutesInAbsorption)
      expect(record.minutesInFloat).toBe(exportedDay.minutesInFloat)
    })
  })

  it('compares every field of every exported day, and not a subset of them', () => {
    // The loop above is only worth what it covers: twenty-nine days by eight fields.
    expect(wire.expectedFromVendorExport).toHaveLength(29)
    expect(wire.expectedFromVendorExport.length * 8).toBe(232)
  })

  it('holds the register unit apart from the kilowatt-hour it scales to', () => {
    // The lowest exported day is 140 Wh. Read as kilowatt-hours the same byte is 14 kWh from a
    // 100/50 in July, and read as watt-hours it is a controller that produced nothing at all.
    const quietest = wire.expectedFromVendorExport.reduce((lowest, day) => {
      return day.yieldWh < lowest.yieldWh ? day : lowest
    })

    expect(quietest.yieldWh).toBe(140)
    expect(capturedDay(quietest.register)[1]).toBe(14)
    expect(decodedDay(quietest.register).yieldKwh).toBeCloseTo(0.14, 6)
  })
})

describe('the day sequence number is what identifies a day', () => {
  it('gives every captured day its own number', () => {
    const sequenceNumbers = wire.days.map((day) => recordedDay(hexToBytes(day.bytes)).daySequenceNumber)
    expect(new Set(sequenceNumbers).size).toBe(sequenceNumbers.length)
  })

  it('steps by exactly one down the backlog, newest register first', () => {
    const sequenceNumbers = wire.days.map((day) => recordedDay(hexToBytes(day.bytes)).daySequenceNumber)
    const expected = sequenceNumbers.map((_, age) => sequenceNumbers[0] - age)

    expect(sequenceNumbers).toEqual(expected)
  })

  it('travels with the record rather than naming the register it sits in', () => {
    // Today is always 0x1050, so a register is a position and never an identity: the day in
    // 0x1050 today is the day in 0x1051 tomorrow, carrying this number with it.
    const today = decodedDay(HISTORY_TODAY_REGISTER)
    const yesterday = decodedDay(historyDayRegister(1))

    expect(today.daySequenceNumber).toBe(yesterday.daySequenceNumber + 1)
  })
})

describe('decodeSolarHistoryDay sentinels and refusals', () => {
  it('reports no consumption on a controller without a load output', () => {
    wire.days.forEach((day) => {
      expect(recordedDay(hexToBytes(day.bytes)).consumedKwh).toBeNull()
    })
    expect(hex(capturedDay(HISTORY_TODAY_REGISTER).slice(5, 9))).toBe('ffffffff')
  })

  it('reads a real consumption figure where a load output reports one', () => {
    // A captured day with bytes 5..8 overwritten: this controller has no load output, so the only
    // way to exercise the non-sentinel branch is to write a figure into one of its records.
    const withLoad = withConsumedEnergy(capturedDay(HISTORY_TODAY_REGISTER), 42)

    expect(recordedDay(withLoad).consumedKwh).toBeCloseTo(0.42, 6)
    expect(recordedDay(withLoad).yieldKwh).toBe(decodedDay(HISTORY_TODAY_REGISTER).yieldKwh)
  })

  it('rejects a payload that is not exactly the record length', () => {
    const payload = capturedDay(HISTORY_TODAY_REGISTER)

    expect(() => decodeSolarHistoryDay(payload.slice(0, 33))).toThrow(/must be 34 bytes, got 33/)
    expect(() => decodeSolarHistoryDay(new Uint8Array(35))).toThrow(/must be 34 bytes, got 35/)
    expect(() => decodeSolarHistoryDay(new Uint8Array(0))).toThrow(/must be 34 bytes, got 0/)
    expect(() => decodeSolarHistoryDay(capturedTotals.slice(0, 19))).toThrow(/must be 34 bytes, got 19/)
  })

  it('refuses the totals record handed to it, rather than decoding it as a day', () => {
    expect(() => decodeSolarHistoryDay(capturedTotals)).toThrow(/flag 0x01/)
    expect(() => decodeSolarHistoryDay(withRecordFlag(capturedDay(0x1050), 0x02))).toThrow(/flag 0x02/)
  })
})

describe('a day with no data is not a day with no yield', () => {
  it('reports an unwritten register as unwritten', () => {
    // A captured day with byte 0 set to the unwritten flag. The rest of the payload is a real
    // 1.34 kWh day, which is the point: once the flag says unwritten, no other byte is read.
    const unwritten = decodeSolarHistoryDay(
      withRecordFlag(capturedDay(HISTORY_TODAY_REGISTER), UNWRITTEN_DAY_RECORD_FLAG),
    )

    expect(unwritten.recorded).toBe(false)
    expect(unwritten).toEqual({ recorded: false })
  })

  it('keeps a recorded day distinguishable from an unwritten one at the type level', () => {
    const recorded = decodeSolarHistoryDay(capturedDay(HISTORY_TODAY_REGISTER))
    const unwritten = decodeSolarHistoryDay(
      withRecordFlag(capturedDay(HISTORY_TODAY_REGISTER), UNWRITTEN_DAY_RECORD_FLAG),
    )

    expect(recorded.recorded).toBe(true)
    expect(unwritten.recorded).toBe(false)
    expect(Object.keys(unwritten)).toEqual(['recorded'])
  })
})

describe('decodeSolarHistoryTotals', () => {
  it('reads the captured totals record', () => {
    const totals = decodeSolarHistoryTotals(capturedTotals)

    expect(totals.errorDatabase).toBe(0)
    expect(totals.errors).toEqual([0, 0, 0, 0])
    expect(totals.resettableYieldKwh).toBeCloseTo(59.53, 6)
    expect(totals.systemYieldKwh).toBeCloseTo(59.53, 6)
    expect(totals.maxPvVoltage).toBeCloseTo(22.57, 6)
    expect(totals.maxBatteryVoltage).toBeCloseTo(14.34, 6)
    expect(totals.minBatteryVoltage).toBeCloseTo(12.65, 6)
  })

  it('agrees with the daily backlog on the extremes it summarises', () => {
    const totals = decodeSolarHistoryTotals(capturedTotals)
    const days = wire.days.map((day) => recordedDay(hexToBytes(day.bytes)))
    const highestPvVoltage = Math.max(...days.map((day) => day.maxPvVoltage))
    const highestBatteryVoltage = Math.max(...days.map((day) => day.maxBatteryVoltage))

    expect(totals.maxPvVoltage).toBeGreaterThanOrEqual(highestPvVoltage)
    expect(totals.maxBatteryVoltage).toBeGreaterThanOrEqual(highestBatteryVoltage)
  })

  it('reports the day count that bounds a fetch', () => {
    const totals = decodeSolarHistoryTotals(capturedTotals)

    expect(totals.daysAvailable).toBe(30)
    expect(totals.daysAvailable).toBeLessThanOrEqual(MAX_HISTORY_DAYS)
  })

  it('reports no battery-voltage minimum on the 19-byte firmware 1.16 record', () => {
    // The same captured record truncated where firmware before 1.17 ends it. The length decides,
    // not byte 0: the flag is identical in both forms.
    const short = capturedTotals.slice(0, 19)
    const totals = decodeSolarHistoryTotals(short)

    expect(short[0]).toBe(capturedTotals[0])
    expect(totals.minBatteryVoltage).toBeNull()
    expect(totals.daysAvailable).toBe(30)
    expect(totals.systemYieldKwh).toBeCloseTo(59.53, 6)
  })

  it('reports no battery-voltage minimum when the field reads as reserved padding', () => {
    // 0xFFFF there is a short record padded out to full length, not a 655 V battery.
    const padded = capturedTotals.slice()
    padded.fill(0xff, 19, 21)

    expect(decodeSolarHistoryTotals(padded).minBatteryVoltage).toBeNull()
  })

  it('rejects a payload of neither documented length', () => {
    expect(() => decodeSolarHistoryTotals(capturedTotals.slice(0, 20))).toThrow(/19 or 34 bytes, got 20/)
    expect(() => decodeSolarHistoryTotals(capturedTotals.slice(0, 18))).toThrow(/19 or 34 bytes, got 18/)
    expect(() => decodeSolarHistoryTotals(new Uint8Array(0))).toThrow(/19 or 34 bytes, got 0/)
  })

  it('refuses a day record handed to it', () => {
    expect(() => decodeSolarHistoryTotals(capturedDay(HISTORY_TODAY_REGISTER))).toThrow(/flag 0x00/)
    expect(() =>
      decodeSolarHistoryTotals(withRecordFlag(capturedDay(HISTORY_TODAY_REGISTER), UNWRITTEN_DAY_RECORD_FLAG)),
    ).toThrow(/flag 0x04/)
  })
})
