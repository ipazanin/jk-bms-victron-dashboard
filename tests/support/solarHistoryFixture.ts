/**
 * The captured history sweep, as the archive takes it.
 *
 * `solarHistoryWire.json` holds what a SmartSolar MPPT 100/50 actually answered on all thirty-one
 * daily registers, alongside VictronConnect's own CSV export of the same controller. Everything a
 * spec needs is derived from those two: the day the sweep was taken on comes out of the export's own
 * dates against the register each row was read from, so no date is transcribed here and a spec that
 * asserts a date is asserting the vendor's.
 *
 * The two edited payloads — an unwritten register, a day whose yield has grown — are built by
 * changing the named bytes of a real record and nothing else, and each says which byte.
 */

import { calendarDateBefore } from '../../src/domain/history/calendarDays'
import { decodeSolarHistoryDay, decodeSolarHistoryTotals } from '../../src/domain/solar/history'
import { HISTORY_DAY_REGISTERS } from '../../src/domain/solar/SolarHistoryRegister'
import type { CalendarDate } from '../../src/domain/history/CalendarDate'
import type { DeviceKey } from '../../src/domain/history/types'
import type { SolarHistoryDayReading } from '../../src/domain/solar/SolarHistoryDayReading'
import type { SolarHistorySnapshot } from '../../src/domain/history/SolarHistorySnapshot'
import { hexToBytes } from './bytes'
import wire from '../fixtures/solarHistoryWire.json'

const RECORD_FLAG_OFFSET = 0
const UNWRITTEN_DAY_RECORD_FLAG = 0x04
const YIELD_OFFSET = 1
const DAY_SEQUENCE_NUMBER_OFFSET = 32

/** A digest-shaped key, in the shape `solarDeviceKeyFor` mints: `victron:` and 48 bits of hex. */
export const SOLAR_DEVICE_KEY: DeviceKey = 'victron:9f3c10a4b7d2'

export const capturedTotals = decodeSolarHistoryTotals(hexToBytes(wire.totals))

const capturedBytes = new Map(wire.days.map((day) => [day.register, hexToBytes(day.bytes)]))

/**
 * The day the capture was taken on, derived rather than written down: the export dates a register,
 * and the register says how many days before the sweep that day was.
 */
export const CAPTURE_READ_ON_DATE: CalendarDate = readOnDateFromExport()

/** Late morning on the capture's own day, so a second sweep can be given a later hour. */
export const CAPTURE_OBSERVED_AT = Date.parse(`${CAPTURE_READ_ON_DATE}T09:15:00Z`)

/** How many days the sweep carried. Every one of the captured registers holds a written day. */
export const CAPTURED_DAYS = HISTORY_DAY_REGISTERS.length

export function capturedDayBytes(daysAgo: number): Uint8Array {
  const bytes = capturedBytes.get(HISTORY_DAY_REGISTERS[daysAgo])
  if (bytes === undefined) throw new Error(`the capture holds no payload for ${daysAgo} days ago`)
  return bytes
}

/** One register's answer, at the age the sweep read it at. */
export function dayReading(daysAgo: number, bytes: Uint8Array = capturedDayBytes(daysAgo)): SolarHistoryDayReading {
  return { register: HISTORY_DAY_REGISTERS[daysAgo], daysAgo, day: decodeSolarHistoryDay(bytes) }
}

/** The whole captured backlog, newest first, as a sweep walks it. */
export function capturedDayReadings(): readonly SolarHistoryDayReading[] {
  return HISTORY_DAY_REGISTERS.map((_register, daysAgo) => dayReading(daysAgo))
}

/** Byte 0 is the record flag; 0x04 is a register the controller has not reached yet. */
export function unwrittenDayBytes(daysAgo: number): Uint8Array {
  const bytes = Uint8Array.from(capturedDayBytes(daysAgo))
  bytes[RECORD_FLAG_OFFSET] = UNWRITTEN_DAY_RECORD_FLAG
  return bytes
}

/** Bytes 1-4 are the day's yield, in hundredths of a kilowatt-hour. */
export function withYield(bytes: Uint8Array, hundredthsKwh: number): Uint8Array {
  const grown = Uint8Array.from(bytes)
  new DataView(grown.buffer).setUint32(YIELD_OFFSET, hundredthsKwh, true)
  return grown
}

/** Bytes 32-33 are the controller's own day counter. */
export function withDaySequenceNumber(bytes: Uint8Array, sequence: number): Uint8Array {
  const renumbered = Uint8Array.from(bytes)
  new DataView(renumbered.buffer).setUint16(DAY_SEQUENCE_NUMBER_OFFSET, sequence, true)
  return renumbered
}

/** The transport figures override one at a time, because most cases care about exactly one. */
export type SolarSnapshotOverrides = Partial<Omit<SolarHistorySnapshot, 'transport'>> & {
  readonly transport?: Partial<SolarHistorySnapshot['transport']>
}

export function capturedSolarSnapshot(overrides: SolarSnapshotOverrides = {}): SolarHistorySnapshot {
  return {
    deviceKey: SOLAR_DEVICE_KEY,
    observedAt: CAPTURE_OBSERVED_AT,
    readOnDate: CAPTURE_READ_ON_DATE,
    outcome: 'days-read',
    totals: capturedTotals,
    days: capturedDayReadings(),
    ...overrides,
    transport: {
      refusedRegisters: [],
      notificationBytes: 1_984,
      notificationCount: 62,
      controlNotificationCount: 9,
      pduCount: 32,
      unreadableReplyCount: 0,
      elapsedMs: 6_400,
      ...overrides.transport,
    },
  }
}

/**
 * The same controller swept again `daysLater` days on: every captured day has aged one register per
 * day, and the days between carry the sequence numbers that follow the capture's newest.
 */
export function laterSolarSnapshot(
  daysLater: number,
  overrides: SolarSnapshotOverrides = {},
): SolarHistorySnapshot {
  const newestSequence = decodedSequence(0)
  const fresh = Array.from({ length: daysLater }, (_unused, position) =>
    dayReading(
      position,
      withDaySequenceNumber(capturedDayBytes(0), newestSequence + daysLater - position),
    ),
  )
  const aged = capturedDayReadings()
    .map((reading) => dayReading(reading.daysAgo + daysLater, capturedDayBytes(reading.daysAgo)))
    .filter((reading) => reading.daysAgo < HISTORY_DAY_REGISTERS.length)

  return capturedSolarSnapshot({
    observedAt: CAPTURE_OBSERVED_AT + daysLater * 86_400_000,
    readOnDate: calendarDateBefore(CAPTURE_READ_ON_DATE, -daysLater),
    days: [...fresh, ...aged],
    ...overrides,
  })
}

export function decodedSequence(daysAgo: number): number {
  const day = decodeSolarHistoryDay(capturedDayBytes(daysAgo))
  if (!day.recorded) throw new Error(`the capture holds no written day ${daysAgo} days ago`)
  return day.daySequenceNumber
}

function readOnDateFromExport(): CalendarDate {
  const [exported] = wire.expectedFromVendorExport
  const daysAgo = (HISTORY_DAY_REGISTERS as readonly number[]).indexOf(exported.register)
  if (daysAgo < 0) throw new Error(`the export names a register outside the backlog: ${exported.register}`)
  return calendarDateBefore(exported.date, -daysAgo)
}
