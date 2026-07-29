/**
 * The JK-BMS stored detail log (command 0xA7, frame type 0x06).
 *
 * The pack keeps its own ring of roughly 768 sampled records — about 32 days — plus a record
 * written whenever an event fires. This is a different store from the event logbook in
 * `logbook.ts`: a logbook entry is a bare code and a timestamp, whereas every detail record is a
 * small snapshot of the whole pack. Both stores draw event codes from one vocabulary, so labels
 * come from `logbookLabel` rather than a second table.
 *
 * Offsets come from the vendor Android app's own decoder rather than from a captured frame: the
 * layout is specified, not yet observed on the wire.
 *
 *   [4]     frame type 0x06
 *   [5]     frame counter
 *   [6..7]  uint16 LE index of the first record carried; index 0 is the oldest the ring holds
 *   [8]     count of records carried, at most 12
 *   [9..]   records, 24 bytes each, contiguous — 9 + 12 × 24 = 297, two bytes idle before the checksum
 *
 * Timestamps are the pack's own RTC counter: seconds from midnight on 2020-01-01 in LOCAL time,
 * not UTC. Read against a UTC epoch every record shifts by the host's offset from Greenwich.
 *
 * Sampling runs on a 3601-second period rather than 3600, because the device crystal is slow. A
 * record's own timestamp is therefore the only authority on when it was taken; stepping whole
 * hours from a neighbouring record drifts a second per sample.
 */

import { logbookLabel } from './logbook'

const MILLI = 0.001
const CENTI = 0.01
const DECI = 0.1

const FIRST_RECORD_INDEX = 6
const RECORD_COUNT = 8
const RECORD_BASE = 9
const RECORD_STRIDE = 24

/** One frame carries no more than this, and 9 + 12 × 24 = 297 is why. */
const MAX_RECORDS_PER_FRAME = 12

/** Midnight on 2020-01-01 in the host's own zone, where the pack's RTC counter starts. */
const RTC_EPOCH_MS = new Date(2020, 0, 1).getTime()

/** The device reports this in place of a temperature when no probe answers. */
const TEMPERATURE_UNAVAILABLE = -1

const CHARGE_MOSFET_ON = 0x01
const DISCHARGE_MOSFET_ON = 0x02
const BALANCING = 0x04
const HEATING = 0x08

const RTC_SECONDS = 0
const EVENT_CODE = 4
const STATUS_BITS = 5
const HIGHEST_CELL = 6
const LOWEST_CELL = 7
const HIGHEST_CELL_VOLTAGE = 8
const LOWEST_CELL_VOLTAGE = 10
const PACK_VOLTAGE = 12
const PACK_CURRENT = 14
const REMAINING_CAPACITY = 16
const NOMINAL_CAPACITY = 18
const HIGHEST_TEMPERATURE = 20
const LOWEST_TEMPERATURE = 21
const MOSFET_TEMPERATURE = 22
const HEATING_CURRENT = 23

/** Volts, amps, amp-hours, degrees Celsius. Positive current = charging. */
export interface DetailLogRecord {
  /** Position in the device's ring, counting from the oldest record it still holds. */
  readonly index: number
  /** Wall-clock milliseconds, read from the pack's RTC against a local 2020-01-01 epoch. */
  readonly recordedAt: number
  readonly eventCode: number
  /** The event that triggered this record, or null when it is a scheduled sample. */
  readonly eventLabel: string | null
  readonly chargingEnabled: boolean
  readonly dischargingEnabled: boolean
  readonly balancing: boolean
  readonly heating: boolean
  /** Zero-based, unlike the one-based `highestCell` a live cell-info frame carries. */
  readonly highestCellIndex: number
  readonly lowestCellIndex: number
  readonly highestCellVoltage: number
  readonly lowestCellVoltage: number
  readonly packVoltage: number
  readonly current: number
  readonly remainingCapacity: number
  readonly nominalCapacity: number
  /** Null when no probe answered. The other two channels carry their reading verbatim. */
  readonly highestTemperature: number | null
  readonly lowestTemperature: number
  readonly mosfetTemperature: number
  readonly heatingCurrent: number
}

function eventLabelFor(code: number): string | null {
  if (code === 0) return null
  return logbookLabel(code)
}

function readRecord(data: DataView, base: number, index: number): DetailLogRecord {
  const statusBits = data.getUint8(base + STATUS_BITS)
  const eventCode = data.getUint8(base + EVENT_CODE)
  const highestTemperature = data.getInt8(base + HIGHEST_TEMPERATURE)

  return {
    index,
    recordedAt: RTC_EPOCH_MS + data.getUint32(base + RTC_SECONDS, true) * 1000,
    eventCode,
    eventLabel: eventLabelFor(eventCode),
    chargingEnabled: (statusBits & CHARGE_MOSFET_ON) !== 0,
    dischargingEnabled: (statusBits & DISCHARGE_MOSFET_ON) !== 0,
    balancing: (statusBits & BALANCING) !== 0,
    heating: (statusBits & HEATING) !== 0,
    highestCellIndex: data.getUint8(base + HIGHEST_CELL),
    lowestCellIndex: data.getUint8(base + LOWEST_CELL),
    highestCellVoltage: data.getUint16(base + HIGHEST_CELL_VOLTAGE, true) * MILLI,
    lowestCellVoltage: data.getUint16(base + LOWEST_CELL_VOLTAGE, true) * MILLI,
    packVoltage: data.getUint16(base + PACK_VOLTAGE, true) * CENTI,
    current: data.getInt16(base + PACK_CURRENT, true) * DECI,
    remainingCapacity: data.getUint16(base + REMAINING_CAPACITY, true) * DECI,
    nominalCapacity: data.getUint16(base + NOMINAL_CAPACITY, true) * DECI,
    highestTemperature: highestTemperature === TEMPERATURE_UNAVAILABLE ? null : highestTemperature,
    lowestTemperature: data.getInt8(base + LOWEST_TEMPERATURE),
    mosfetTemperature: data.getInt8(base + MOSFET_TEMPERATURE),
    heatingCurrent: data.getInt8(base + HEATING_CURRENT) * DECI,
  }
}

/**
 * Reads the records one frame carries, keyed by their position in the device's ring.
 *
 * The frame is expected to have passed the assembler's checksum already, so a count above what a
 * frame can physically hold means the layout is not what this decoder was written for, and
 * throwing beats handing back records read from the wrong offsets.
 */
export function decodeDetailLog(frame: Uint8Array): DetailLogRecord[] {
  const data = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const firstIndex = data.getUint16(FIRST_RECORD_INDEX, true)
  const declared = data.getUint8(RECORD_COUNT)
  if (declared > MAX_RECORDS_PER_FRAME) {
    throw new Error(`detail log frame claims ${declared} records; a frame holds at most ${MAX_RECORDS_PER_FRAME}`)
  }

  const records: DetailLogRecord[] = []
  for (let position = 0; position < declared; position += 1) {
    const base = RECORD_BASE + position * RECORD_STRIDE
    // Never read into the trailing checksum or past a short frame.
    if (base + RECORD_STRIDE > frame.length - 1) break
    records.push(readRecord(data, base, firstIndex + position))
  }
  return records
}
