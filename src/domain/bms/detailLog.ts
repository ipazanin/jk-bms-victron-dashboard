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
 * Timestamps are the pack's own RTC counter, seconds wide, counting from midnight on 2020-01-01.
 * That epoch is confirmed independently: a capture of the vendor app setting the pack's clock
 * writes the counter that date produces. What the counter is counting is NOT confirmed. It is
 * either a naive local wall clock, or absolute seconds since the instant that was local midnight
 * on 2020-01-01 in the pack's own zone. The two agree wherever the pack's zone is on standard
 * time and differ by its summer-time shift, one hour in Europe, wherever it is not.
 *
 * Both readings are one equation with a different constant, so the caller supplies the constant
 * and this decoder does not have to choose:
 *
 *     recordedAt = Date.UTC(2020, 0, 1) + rtcSeconds × 1000 − packUtcOffsetMinutes × 60000
 *
 * Under the naive-local reading that offset is the pack zone's offset in force at the record;
 * under the absolute reading it is the pack zone's standard offset, the same number all year. A
 * summer record resolved with the wrong one of the two is an hour out, so until the convention is
 * settled a caller that cannot tell them apart must not present these instants as exact.
 *
 * A pack whose RTC was never set counts from the epoch itself, which makes a record dated near
 * 2020-01-01 an unset clock rather than a sample. No threshold separates the two — an uncalibrated
 * pack reads small and non-zero, not zero — so the decoder hands the counter through unjudged.
 *
 * Sampling runs on a 3601-second period rather than 3600, because the device crystal is slow. A
 * record's own timestamp is therefore the only authority on when it was taken; stepping whole
 * hours from a neighbouring record drifts a second per sample.
 */

import type { DetailLogFrameHeader } from './DetailLogFrameHeader'
import type { DetailLogOutcome } from './DetailLogOutcome'
import { logbookLabel } from './logbook'
import { FRAME_DETAIL_LOG, frameType } from './protocol'

const MILLI = 0.001
const CENTI = 0.01
const DECI = 0.1

const FRAME_COUNTER = 5
const FIRST_RECORD_INDEX = 6
const RECORD_COUNT = 8
const RECORD_BASE = 9
const RECORD_STRIDE = 24

/** One frame carries no more than this, and 9 + 12 × 24 = 297 is why. */
const MAX_RECORDS_PER_FRAME = 12

/** Where the pack's RTC counter starts, as a fixed instant so that no host clock can move it. */
const RTC_EPOCH_UTC_MS = Date.UTC(2020, 0, 1)

const MILLISECONDS_PER_MINUTE = 60_000

/** Real zones span −12:00 to +14:00; past that the caller has handed us something that is not one. */
const LOWEST_REAL_UTC_OFFSET_MINUTES = -12 * 60
const HIGHEST_REAL_UTC_OFFSET_MINUTES = 14 * 60

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
  /**
   * The pack's own clock reading and nothing more: its RTC counter laid on 2020-01-01T00:00:00Z.
   * Read it with the UTC getters and it renders the clock face the vendor app shows — exactly, if
   * the counter runs on naive local time; shifted by the pack zone's standard offset, if it runs
   * on absolute seconds. It shares no origin with `Date.now()` and must never be compared to it.
   */
  readonly packClockMs: number
  /**
   * Epoch milliseconds: the counter resolved against the offset the caller supplied, and the only
   * timestamp here that can be joined against a real clock.
   */
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

function readRecord(data: DataView, base: number, index: number, packUtcOffsetMs: number): DetailLogRecord {
  const statusBits = data.getUint8(base + STATUS_BITS)
  const eventCode = data.getUint8(base + EVENT_CODE)
  const highestTemperature = data.getInt8(base + HIGHEST_TEMPERATURE)
  const packClockMs = RTC_EPOCH_UTC_MS + data.getUint32(base + RTC_SECONDS, true) * 1000

  return {
    index,
    packClockMs,
    recordedAt: packClockMs - packUtcOffsetMs,
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
 * `packUtcOffsetMinutes` is signed the way a zone is written rather than the way JavaScript
 * reports it, so CET is +60 and CEST +120 — the opposite sign to `Date.prototype.getTimezoneOffset`.
 * It has no default: which offset resolves this pack's counter is a fact about the pack and its
 * installation, and a decoder that guessed it would hand back plausible instants that are wrong.
 *
 * The frame is expected to have passed the assembler's checksum already, so a count above what a
 * frame can physically hold means the layout is not what this decoder was written for, and
 * throwing beats handing back records read from the wrong offsets.
 */
export function decodeDetailLog(
  frame: Uint8Array,
  { packUtcOffsetMinutes }: { readonly packUtcOffsetMinutes: number },
): DetailLogRecord[] {
  if (
    !Number.isFinite(packUtcOffsetMinutes) ||
    packUtcOffsetMinutes < LOWEST_REAL_UTC_OFFSET_MINUTES ||
    packUtcOffsetMinutes > HIGHEST_REAL_UTC_OFFSET_MINUTES
  ) {
    throw new Error(`pack UTC offset of ${packUtcOffsetMinutes} minutes is not an offset any zone uses`)
  }

  const data = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const firstIndex = data.getUint16(FIRST_RECORD_INDEX, true)
  const declared = data.getUint8(RECORD_COUNT)
  if (declared > MAX_RECORDS_PER_FRAME) {
    throw new Error(`detail log frame claims ${declared} records; a frame holds at most ${MAX_RECORDS_PER_FRAME}`)
  }

  const packUtcOffsetMs = packUtcOffsetMinutes * MILLISECONDS_PER_MINUTE
  const records: DetailLogRecord[] = []
  for (let position = 0; position < declared; position += 1) {
    const base = RECORD_BASE + position * RECORD_STRIDE
    // Never read into the trailing checksum or past a short frame.
    if (base + RECORD_STRIDE > frame.length - 1) break
    records.push(readRecord(data, base, firstIndex + position, packUtcOffsetMs))
  }
  return records
}

/**
 * Reads a frame's leading fields without decoding a single record, and without caring what type of
 * frame it is — a reply to 0xA7 that is not a detail log has to be describable too, or the case
 * where the opcode means something else on this firmware cannot be told from the case where it
 * means nothing.
 */
export function readDetailLogHeader(frame: Uint8Array): DetailLogFrameHeader {
  const header = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  return {
    frameType: frameType(frame),
    counter: header.getUint8(FRAME_COUNTER),
    firstRecordIndex: header.getUint16(FIRST_RECORD_INDEX, true),
    recordCount: header.getUint8(RECORD_COUNT),
  }
}

/**
 * Which of the four answers a stored-log read came back with.
 *
 * The order of the tests is the point. Raw bytes are asked about first, before anything that
 * depends on assembly succeeding, because a pack that never answered and a burst that arrived in
 * pieces are indistinguishable by any later measure.
 */
export function detailLogOutcome(
  notificationBytes: number,
  frames: readonly DetailLogFrameHeader[],
): DetailLogOutcome {
  if (notificationBytes === 0) return 'no-answer'
  if (frames.length === 0) return 'torn-burst'
  if (!frames.some((header) => header.frameType === FRAME_DETAIL_LOG)) return 'other-frames'
  return 'records-read'
}
