/**
 * What these tests establish, and how the two halves of the file divide the work.
 *
 * The real-frame cases drive bytes captured off a JK_B2A8S20P answering a bare 0xA7, committed
 * verbatim in `detailLogFrame.json`. They are what prove the layout is what a device actually sends,
 * and what pin the epoch: the captured records were matched to the vendor app's own export by value
 * fingerprint, so the wall-clock strings asserted against them are the strings that app printed.
 *
 * The synthesized cases encode vendor-exported rows into that layout and read them back. They cover
 * what the capture does not contain — event codes, MOSFETs off, both current signs, an unfitted
 * probe, heating — and the malformed and boundary frames, which have to be constructed to exist at
 * all. Their encoder writes the counter the way the device writes it: absolute seconds from the
 * instant that was local midnight on 2020-01-01, which means the pack zone's standard offset applied
 * to every record whatever season it falls in.
 *
 * Nothing here reads the host clock or the host zone. Every expected instant is either a literal
 * `Date.UTC(…)` or comes from an `Intl` formatter pinned to the pack's own zone, so every number
 * below stays the same under any TZ.
 *
 * The export carries no record with heating on and none with an unavailable temperature probe, so
 * those two paths are exercised by rows edited by hand, marked as such where they appear.
 */

import { describe, expect, it } from 'vitest'

import {
  decodeDetailLog,
  decodeDetailLogRecord,
  readDetailLogHeader,
  readDetailLogRecordBytes,
} from '../src/domain/bms/detailLog'
import type { DetailLogRecord } from '../src/domain/bms/detailLog'
import {
  FRAME_DETAIL_LOG,
  FRAME_LENGTH,
  FrameAssembler,
  RESPONSE_HEADER,
  checksum,
  frameType,
  isChecksumValid,
} from '../src/domain/bms/protocol'
import capturedFrames from './fixtures/detailLogFrame.json'
import vendorExport from './fixtures/detailLogRows.json'
import { hexToBytes } from './support/bytes'

interface SampledRow {
  /** The pack's clock face in the fixture's `recordedTimeZone`, exactly as the vendor app rendered it. */
  readonly at: string
  readonly eventCode: number
  readonly eventLabel: string | null
  readonly chargingEnabled: boolean
  readonly dischargingEnabled: boolean
  readonly balancing: boolean
  readonly heating: boolean
  readonly highestCellIndex: number
  readonly lowestCellIndex: number
  readonly highestCellVoltage: number
  readonly lowestCellVoltage: number
  readonly packVoltage: number
  readonly current: number
  readonly remainingCapacity: number
  readonly nominalCapacity: number
  readonly highestTemperature: number
  readonly lowestTemperature: number
  readonly mosfetTemperature: number
  readonly heatingCurrent: number
}

const sampledRows: readonly SampledRow[] = vendorExport.sampledRows

/** The zone the pack was installed in when the export was taken, not the zone this suite runs in. */
const packZone: string = vendorExport.recordedTimeZone

const RECORD_STRIDE = 24
const RECORD_BASE = 9
const MAX_RECORDS_PER_FRAME = 12

const MILLISECONDS_PER_MINUTE = 60_000

/**
 * Where the RTC counter starts. Spelled out here rather than imported so that the decoder and the
 * encoder below cannot agree on a wrong epoch by sharing one constant.
 */
const RTC_EPOCH_UTC_MS = Date.UTC(2020, 0, 1)

const packZoneClock = new Intl.DateTimeFormat('en-US', {
  timeZone: packZone,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function twoDigits(figure: number): string {
  return String(figure).padStart(2, '0')
}

function clockFaceFields(stamp: string): readonly number[] {
  const parts = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(stamp)
  if (parts === null) throw new Error(`unparseable vendor timestamp: ${stamp}`)
  return parts.slice(1).map(Number)
}

/** A clock face read as if it were UTC — a wall clock with no zone applied to it. */
function wallClockMsOf(stamp: string): number {
  const [year, month, day, hour, minute, second] = clockFaceFields(stamp)
  return Date.UTC(year, month - 1, day, hour, minute, second)
}

/** The pack zone's calendar fields at an instant, read through `Intl` and never off the host zone. */
function packZoneFieldsAt(instantMs: number): Record<string, number> {
  return packZoneClock
    .formatToParts(new Date(instantMs))
    .filter((part) => part.type !== 'literal')
    .reduce<Record<string, number>>((fields, part) => ({ ...fields, [part.type]: Number(part.value) }), {})
}

/** An instant written the way the pack's own zone spells it, in the format the vendor app prints. */
function renderInPackZone(instantMs: number): string {
  const spelled = packZoneFieldsAt(instantMs)
  const day = `${spelled.year}-${twoDigits(spelled.month)}-${twoDigits(spelled.day)}`
  const time = `${twoDigits(spelled.hour)}:${twoDigits(spelled.minute)}:${twoDigits(spelled.second)}`
  return `${day} ${time}`
}

/** How far ahead of UTC the pack's zone stands at a given instant, signed the way a zone is written. */
function packZoneOffsetMinutesAt(instantMs: number): number {
  const spelled = packZoneFieldsAt(instantMs)
  const asIfUtc = Date.UTC(spelled.year, spelled.month - 1, spelled.day, spelled.hour, spelled.minute, spelled.second)
  return (asIfUtc - instantMs) / MILLISECONDS_PER_MINUTE
}

/**
 * The true instant a vendor clock face names in the pack's zone. Two passes because the offset that
 * resolves a wall clock is the offset in force at the instant it resolves to, not at UTC.
 */
function instantInPackZone(stamp: string): number {
  const wallClock = wallClockMsOf(stamp)
  const firstGuess = wallClock - packZoneOffsetMinutesAt(wallClock) * MILLISECONDS_PER_MINUTE
  return wallClock - packZoneOffsetMinutesAt(firstGuess) * MILLISECONDS_PER_MINUTE
}

/**
 * The pack zone's standard offset — the one constant the RTC counter runs on, whatever season a
 * record falls in. Summer time is always an advance, so the smallest offset a zone takes across a
 * year is its standard one, and derived that way it holds for either hemisphere.
 */
function standardOffsetMinutesOf(year: number): number {
  const monthStarts = Array.from({ length: 12 }, (_, month) => Date.UTC(year, month, 1))
  return Math.min(...monthStarts.map(packZoneOffsetMinutesAt))
}

const [EXPORT_YEAR] = clockFaceFields(sampledRows[0].at)
const PACK_UTC_OFFSET_MINUTES = standardOffsetMinutesOf(EXPORT_YEAR)
const packClock = { packUtcOffsetMinutes: PACK_UTC_OFFSET_MINUTES }

function statusBits(row: SampledRow): number {
  return (
    (row.chargingEnabled ? 0x01 : 0) |
    (row.dischargingEnabled ? 0x02 : 0) |
    (row.balancing ? 0x04 : 0) |
    (row.heating ? 0x08 : 0)
  )
}

/**
 * One 24-byte record laid out the way the detail log describes it, with the counter written the way
 * the device writes it: the row's true instant carried up by the pack zone's standard offset, so
 * that subtracting that same standard offset resolves it back whatever season the row falls in.
 */
function encodeRecord(row: SampledRow): Uint8Array {
  const packClockMs = instantInPackZone(row.at) + PACK_UTC_OFFSET_MINUTES * MILLISECONDS_PER_MINUTE
  const record = new Uint8Array(RECORD_STRIDE)
  const view = new DataView(record.buffer)
  view.setUint32(0, Math.round((packClockMs - RTC_EPOCH_UTC_MS) / 1000), true)
  view.setUint8(4, row.eventCode)
  view.setUint8(5, statusBits(row))
  view.setUint8(6, row.highestCellIndex)
  view.setUint8(7, row.lowestCellIndex)
  view.setUint16(8, Math.round(row.highestCellVoltage * 1000), true)
  view.setUint16(10, Math.round(row.lowestCellVoltage * 1000), true)
  view.setUint16(12, Math.round(row.packVoltage * 100), true)
  view.setInt16(14, Math.round(row.current * 10), true)
  view.setUint16(16, Math.round(row.remainingCapacity * 10), true)
  view.setUint16(18, Math.round(row.nominalCapacity * 10), true)
  view.setInt8(20, row.highestTemperature)
  view.setInt8(21, row.lowestTemperature)
  view.setInt8(22, row.mosfetTemperature)
  view.setInt8(23, Math.round(row.heatingCurrent * 10))
  return record
}

function detailLogFrame(records: readonly Uint8Array[], firstIndex = 0, declared = records.length): Uint8Array {
  const frame = new Uint8Array(FRAME_LENGTH)
  frame.set(RESPONSE_HEADER, 0)
  frame[4] = FRAME_DETAIL_LOG
  frame[5] = 0x00
  new DataView(frame.buffer).setUint16(6, firstIndex, true)
  frame[8] = declared
  records.forEach((record, position) => frame.set(record, RECORD_BASE + position * RECORD_STRIDE))
  frame[FRAME_LENGTH - 1] = checksum(frame.subarray(0, FRAME_LENGTH - 1))
  return frame
}

// ── the captured frames ──────────────────────────────────────────────────────

/** Europe/Zagreb standard time, which is what this pack's counter runs on the year round. */
const CAPTURED_PACK_UTC_OFFSET_MINUTES = 60
const capturedPackClock = { packUtcOffsetMinutes: CAPTURED_PACK_UTC_OFFSET_MINUTES }

/** The gap between consecutive records, every one of them: the device crystal runs a second slow. */
const SAMPLING_PERIOD_SECONDS = 3601

/** How many records the ring holds before it wraps, which its last page is what settles. */
const RING_CAPACITY = 836

const CELLS_IN_PACK = 4
const PACK_NOMINAL_CAPACITY_AH = 315

const fullPage = hexToBytes(capturedFrames.full.hex)
const tailPage = hexToBytes(capturedFrames.tail.hex)

const capturedPages = [
  { described: 'a full page', frame: fullPage, declared: capturedFrames.full },
  { described: "the ring's tail", frame: tailPage, declared: capturedFrames.tail },
] as const

function everyCapturedRecord(): readonly DetailLogRecord[] {
  return [...decodeDetailLog(fullPage, capturedPackClock), ...decodeDetailLog(tailPage, capturedPackClock)]
}

describe('the frames a bare 0xA7 brought back off a real pack', () => {
  it('is read against the same offset the fixture was fingerprinted with', () => {
    expect(capturedFrames.packUtcOffsetMinutes).toBe(CAPTURED_PACK_UTC_OFFSET_MINUTES)
  })

  capturedPages.forEach((page) => {
    it(`carries ${page.described} as one whole frame the assembler accepts`, () => {
      expect(page.frame).toHaveLength(FRAME_LENGTH)
      expect(isChecksumValid(page.frame)).toBe(true)
      expect(frameType(page.frame)).toBe(FRAME_DETAIL_LOG)
      expect(new FrameAssembler().feed(page.frame)).toHaveLength(1)
    })

    it(`decodes ${page.described} into exactly the records its header declares`, () => {
      const header = readDetailLogHeader(page.frame)
      const records = decodeDetailLog(page.frame, capturedPackClock)
      const expectedIndices = Array.from(
        { length: page.declared.recordCount },
        (_, position) => page.declared.firstRecordIndex + position,
      )

      expect(header.firstRecordIndex).toBe(page.declared.firstRecordIndex)
      expect(header.recordCount).toBe(page.declared.recordCount)
      expect(records).toHaveLength(page.declared.recordCount)
      expect(records.map((record) => record.index)).toEqual(expectedIndices)
    })

    it(`spaces every record in ${page.described} exactly ${SAMPLING_PERIOD_SECONDS} s from the last`, () => {
      const records = decodeDetailLog(page.frame, capturedPackClock)
      const gaps = records.slice(1).map((record, position) => record.recordedAt - records[position].recordedAt)

      expect(new Set(gaps)).toEqual(new Set([SAMPLING_PERIOD_SECONDS * 1000]))
    })
  })

  it('reads every captured record as a pack that is physically this one', () => {
    const records = everyCapturedRecord()
    const packVoltages = records.map((record) => record.packVoltage)
    const cellVoltages = records.flatMap((record) => [record.highestCellVoltage, record.lowestCellVoltage])
    const cellIndices = records.flatMap((record) => [record.highestCellIndex, record.lowestCellIndex])
    const nominalCapacities = records.map((record) => record.nominalCapacity)

    expect(new Set(nominalCapacities)).toEqual(new Set([PACK_NOMINAL_CAPACITY_AH]))
    expect(Math.min(...packVoltages)).toBeGreaterThan(13)
    expect(Math.max(...packVoltages)).toBeLessThan(14)
    expect(Math.min(...cellVoltages)).toBeGreaterThan(3.3)
    expect(Math.max(...cellVoltages)).toBeLessThan(3.45)
    expect(Math.max(...cellIndices)).toBeLessThan(CELLS_IN_PACK)
    expect(Math.max(...records.map((record) => record.remainingCapacity))).toBeLessThan(PACK_NOMINAL_CAPACITY_AH)
  })

  /**
   * The concrete instant, spelled out, because it is the whole of what the epoch convention decides.
   * The vendor app prints this record as 2026-06-29 17:15:25 and the fingerprint match is what says
   * so; any change to how the counter is resolved has to break this line to get through.
   */
  it('puts the oldest record the ring holds where the vendor app puts it', () => {
    const [oldest] = decodeDetailLog(fullPage, capturedPackClock)

    expect(oldest.index).toBe(0)
    expect(oldest.recordedAt).toBe(Date.UTC(2026, 5, 29, 15, 15, 25))
    expect(renderInPackZone(oldest.recordedAt)).toBe('2026-06-29 17:15:25')
    expect(oldest.packClockMs).toBe(Date.UTC(2026, 5, 29, 16, 15, 25))
  })

  it('puts that record an hour early if the summer offset is used in place of the standard one', () => {
    const [oldest] = decodeDetailLog(fullPage, { packUtcOffsetMinutes: 120 })

    expect(renderInPackZone(oldest.recordedAt)).toBe('2026-06-29 16:15:25')
  })

  it('runs the last record of a full page an hour past its first', () => {
    const records = decodeDetailLog(fullPage, capturedPackClock)

    expect(renderInPackZone(records[records.length - 1].recordedAt)).toBe('2026-06-30 04:15:36')
  })

  it('reads the newest record the ring holds as the pack the instruments showed moments later', () => {
    const records = decodeDetailLog(tailPage, capturedPackClock)
    const newest = records[records.length - 1]

    expect(newest.index).toBe(RING_CAPACITY - 1)
    expect(newest.recordedAt).toBe(Date.UTC(2026, 7, 1, 7, 29, 14))
    expect(renderInPackZone(newest.recordedAt)).toBe('2026-08-01 09:29:14')
    expect(newest.packVoltage).toBeCloseTo(13.61, 2)
    expect(newest.highestCellVoltage).toBeCloseTo(3.415, 3)
    expect(newest.lowestCellVoltage).toBeCloseTo(3.399, 3)
    expect(newest.highestCellIndex).toBe(0)
    expect(newest.lowestCellIndex).toBe(3)
    expect(newest.current).toBeCloseTo(14.7, 1)
    expect(newest.remainingCapacity).toBeCloseTo(292, 1)
    expect(newest.nominalCapacity).toBeCloseTo(315, 1)
    expect(newest.highestTemperature).toBe(26)
    expect(newest.lowestTemperature).toBe(25)
    expect(newest.mosfetTemperature).toBe(31)
  })

  it('ends the ring at a short page, which is what puts its capacity at 836 records', () => {
    const tail = readDetailLogHeader(tailPage)

    expect(tail.recordCount).toBeLessThan(12)
    expect(tail.firstRecordIndex % 12).toBe(0)
    expect(tail.firstRecordIndex + tail.recordCount).toBe(RING_CAPACITY)
  })

  it('has nothing sequential in byte 5, so the index field is the only thing that orders a burst', () => {
    const full = readDetailLogHeader(fullPage)
    const tail = readDetailLogHeader(tailPage)
    const pagesBetween = (tail.firstRecordIndex - full.firstRecordIndex) / MAX_RECORDS_PER_FRAME

    expect(full.unidentifiedByte).toBe(0x52)
    expect(tail.unidentifiedByte).toBe(0x1b)
    expect(tail.unidentifiedByte).not.toBe(full.unidentifiedByte + pagesBetween)
  })

  it('reads every captured record as a scheduled sample rather than an event', () => {
    const records = everyCapturedRecord()

    expect(records.filter((record) => record.eventCode !== 0)).toEqual([])
    expect(records.filter((record) => record.eventLabel !== null)).toEqual([])
  })

  it('finds the balancer running on one record alone, both MOSFETs on throughout and no heating', () => {
    const records = everyCapturedRecord()

    expect(records.filter((record) => record.balancing).map((record) => record.index)).toEqual([RING_CAPACITY - 1])
    expect(records.filter((record) => !record.chargingEnabled || !record.dischargingEnabled)).toEqual([])
    expect(records.filter((record) => record.heating)).toEqual([])
  })
})

describe('a vendor detail-log export encoded into the layout and read back', () => {
  const records = decodeDetailLog(detailLogFrame(sampledRows.map(encodeRecord)), packClock)

  it('yields one record per exported row', () => {
    expect(records).toHaveLength(sampledRows.length)
  })

  it('resolves the export with the pack zone standard offset, which none of its rows is on', () => {
    const offsetsInForce = sampledRows.map((row) => packZoneOffsetMinutesAt(instantInPackZone(row.at)))

    expect(PACK_UTC_OFFSET_MINUTES).toBe(60)
    expect(offsetsInForce.every((offset) => offset === 120)).toBe(true)
  })

  sampledRows.forEach((row, position) => {
    it(`reproduces every value the vendor app rendered for ${row.at}`, () => {
      const record = records[position]

      expect(renderInPackZone(record.recordedAt)).toBe(row.at)
      expect(record.recordedAt).toBe(instantInPackZone(row.at))
      expect(record.eventCode).toBe(row.eventCode)
      expect(record.eventLabel).toBe(row.eventLabel)
      expect(record.chargingEnabled).toBe(row.chargingEnabled)
      expect(record.dischargingEnabled).toBe(row.dischargingEnabled)
      expect(record.balancing).toBe(row.balancing)
      expect(record.heating).toBe(row.heating)
      expect(record.highestCellIndex).toBe(row.highestCellIndex)
      expect(record.lowestCellIndex).toBe(row.lowestCellIndex)
      expect(record.highestCellVoltage).toBeCloseTo(row.highestCellVoltage, 3)
      expect(record.lowestCellVoltage).toBeCloseTo(row.lowestCellVoltage, 3)
      expect(record.packVoltage).toBeCloseTo(row.packVoltage, 2)
      expect(record.current).toBeCloseTo(row.current, 1)
      expect(record.remainingCapacity).toBeCloseTo(row.remainingCapacity, 1)
      expect(record.nominalCapacity).toBeCloseTo(row.nominalCapacity, 1)
      expect(record.highestTemperature).toBe(row.highestTemperature)
      expect(record.lowestTemperature).toBe(row.lowestTemperature)
      expect(record.mosfetTemperature).toBe(row.mosfetTemperature)
      expect(record.heatingCurrent).toBeCloseTo(row.heatingCurrent, 1)
    })
  })

  it('keeps the sign of a charging and a discharging current apart', () => {
    const charging = records.find((record) => record.current > 15)!
    const discharging = records.find((record) => record.current < -50)!

    expect(charging.current).toBeCloseTo(20.8, 1)
    expect(discharging.current).toBeCloseTo(-87.0, 1)
  })

  it('labels an event record from the shared event-code table and leaves a scheduled sample bare', () => {
    const scheduled = records.find((record) => record.eventCode === 0)!
    const calibration = records.find((record) => record.eventCode === 0x3b)!
    const protection = records.find((record) => record.eventCode === 0x67)!

    expect(scheduled.eventLabel).toBeNull()
    expect(calibration.eventLabel).toBe('Time calibration')
    expect(protection.eventLabel).toBe('Cell 4 overcharge protection')
  })

  it('reads both MOSFETs off on the record that logged an incorrect cell count', () => {
    const record = records.find((entry) => entry.eventCode === 0x3c)!

    expect(record.chargingEnabled).toBe(false)
    expect(record.dischargingEnabled).toBe(false)
    expect(record.packVoltage).toBeCloseTo(10.21, 2)
  })
})

describe('decodeDetailLog', () => {
  it('keys each record from the first-record index the frame carries', () => {
    const records = decodeDetailLog(
      detailLogFrame([encodeRecord(sampledRows[0]), encodeRecord(sampledRows[1])], 754),
      packClock,
    )

    expect(records.map((record) => record.index)).toEqual([754, 755])
  })

  it('decodes a full twelve-record frame without the stride drifting', () => {
    const filled = Array.from({ length: 12 }, (_, position) => sampledRows[position % sampledRows.length])
    const records = decodeDetailLog(detailLogFrame(filled.map(encodeRecord), 100), packClock)

    expect(records).toHaveLength(12)
    records.forEach((record, position) => {
      expect(record.index).toBe(100 + position)
      expect(renderInPackZone(record.recordedAt)).toBe(filled[position].at)
      expect(record.recordedAt).toBe(instantInPackZone(filled[position].at))
      expect(record.current).toBeCloseTo(filled[position].current, 1)
      expect(record.mosfetTemperature).toBe(filled[position].mosfetTemperature)
    })
  })

  it('rejects a frame claiming more records than one can physically hold', () => {
    const frame = detailLogFrame(sampledRows.map(encodeRecord), 0, 13)

    expect(() => decodeDetailLog(frame, packClock)).toThrow(/at most 12/)
  })

  it('refuses an offset no zone on earth uses rather than inventing an instant from it', () => {
    const frame = detailLogFrame([encodeRecord(sampledRows[0])])

    expect(() => decodeDetailLog(frame, { packUtcOffsetMinutes: Number.NaN })).toThrow(/not an offset any zone uses/)
    expect(() => decodeDetailLog(frame, { packUtcOffsetMinutes: 900 })).toThrow(/not an offset any zone uses/)
  })

  it('starts the counter at 2020-01-01T00:00:00Z on every host, whatever zone the host keeps', () => {
    const record = encodeRecord(sampledRows[0])
    new DataView(record.buffer).setUint32(0, 0, true)

    const [decoded] = decodeDetailLog(detailLogFrame([record]), packClock)
    const zero = new Date(decoded.packClockMs)

    expect(decoded.packClockMs).toBe(RTC_EPOCH_UTC_MS)
    expect(decoded.packClockMs).toBe(1_577_836_800_000)
    expect([zero.getUTCFullYear(), zero.getUTCMonth(), zero.getUTCDate(), zero.getUTCHours(), zero.getUTCMinutes()])
      .toEqual([2020, 0, 1, 0, 0])
    expect(decoded.recordedAt).toBe(RTC_EPOCH_UTC_MS - PACK_UTC_OFFSET_MINUTES * MILLISECONDS_PER_MINUTE)
  })

  it('moves the instant, and only the instant, when the same bytes are read against another offset', () => {
    const frame = detailLogFrame(sampledRows.map(encodeRecord))

    const atCentralEurope = decodeDetailLog(frame, { packUtcOffsetMinutes: 60 })
    const atKolkata = decodeDetailLog(frame, { packUtcOffsetMinutes: 330 })

    atCentralEurope.forEach((record, position) => {
      expect(atKolkata[position].packClockMs).toBe(record.packClockMs)
      expect(record.recordedAt - atKolkata[position].recordedAt).toBe((330 - 60) * MILLISECONDS_PER_MINUTE)
    })
  })

  // Hand-edited rows: the export holds no record with an unfitted probe or with heating running.
  it('reports an unfitted temperature probe as unavailable rather than as −1 °C', () => {
    const row = { ...sampledRows[0], highestTemperature: -1, lowestTemperature: -1 }
    const [record] = decodeDetailLog(detailLogFrame([encodeRecord(row)]), packClock)

    expect(record.highestTemperature).toBeNull()
    // The sentinel is documented on the highest channel alone; the others read verbatim.
    expect(record.lowestTemperature).toBe(-1)
  })

  it('reads the heating flag and a signed heating current', () => {
    const row = { ...sampledRows[0], heating: true, heatingCurrent: -1.2 }
    const [record] = decodeDetailLog(detailLogFrame([encodeRecord(row)]), packClock)

    expect(record.heating).toBe(true)
    expect(record.heatingCurrent).toBeCloseTo(-1.2, 1)
  })

  // The archive stores a record's bytes and decodes them one at a time on read, so the two entry
  // points have to be the same reading of the same layout — a stride that drifted between them
  // would corrupt every stored row while every frame on screen stayed right.
  it('decodes a record on its own exactly as it decodes it inside a frame', () => {
    const filled = Array.from({ length: 12 }, (_, position) => sampledRows[position % sampledRows.length])
    const frame = detailLogFrame(filled.map(encodeRecord), 640)

    const wholeFrame = decodeDetailLog(frame, packClock)
    const oneAtATime = readDetailLogRecordBytes(frame).map((record) =>
      decodeDetailLogRecord(record.bytes, record.index, packClock),
    )

    expect(oneAtATime).toEqual(wholeFrame)
  })

  it('hands back each record as bytes of its own rather than a window onto the frame', () => {
    const frame = detailLogFrame([encodeRecord(sampledRows[0]), encodeRecord(sampledRows[1])], 12)

    const records = readDetailLogRecordBytes(frame)

    expect(records.map((record) => record.index)).toEqual([12, 13])
    expect(records[0].bytes).toEqual(encodeRecord(sampledRows[0]))
    records.forEach((record) => {
      expect(record.bytes).toHaveLength(RECORD_STRIDE)
      // A view would carry the whole 300-byte frame into the archive behind every 24 stored bytes.
      expect(record.bytes.byteLength).toBe(record.bytes.buffer.byteLength)
    })
  })

  it('refuses to slice a frame claiming more records than one can physically hold', () => {
    const frame = detailLogFrame(sampledRows.map(encodeRecord), 0, 13)

    expect(() => readDetailLogRecordBytes(frame)).toThrow(/at most 12/)
  })
})

describe('the synthesized detail-log envelope', () => {
  it('satisfies the frame contract the assembler enforces', () => {
    const frame = detailLogFrame(sampledRows.map(encodeRecord), 12)

    expect(isChecksumValid(frame)).toBe(true)
    expect(frameType(frame)).toBe(FRAME_DETAIL_LOG)
    expect(new FrameAssembler().feed(frame)).toHaveLength(1)
  })
})
