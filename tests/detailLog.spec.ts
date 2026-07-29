/**
 * What these tests establish, and what they deliberately do not.
 *
 * They prove that `decodeDetailLog` reads the field offsets, scale factors, signedness and RTC
 * epoch that the detail-log layout specifies: every sampled row here is a real row from a vendor-app
 * export of this pack, encoded into that layout and read back, and the decoded values are checked
 * against the numbers the vendor app itself printed.
 *
 * They do not prove the layout is what a device actually sends. No 0x06 frame has been captured, so
 * every frame below is synthesized by this file from the same specification the decoder implements.
 * A layout error shared by both would pass here and fail on the water.
 *
 * The export carries no record with heating on and none with an unavailable temperature probe, so
 * those two paths are exercised by rows edited by hand, marked as such where they appear.
 */

import { describe, expect, it } from 'vitest'

import { decodeDetailLog } from '../src/domain/bms/detailLog'
import {
  FRAME_DETAIL_LOG,
  FRAME_LENGTH,
  FrameAssembler,
  RESPONSE_HEADER,
  checksum,
  frameType,
  isChecksumValid,
} from '../src/domain/bms/protocol'
import vendorExport from './fixtures/detailLogRows.json'

interface SampledRow {
  /** Local wall clock, exactly as the vendor app rendered it. */
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

const RECORD_STRIDE = 24
const RECORD_BASE = 9

/**
 * Midnight on 2020-01-01 in the host's own zone. Spelled out here rather than imported so that the
 * decoder and the encoder below cannot agree on a wrong epoch by sharing one constant.
 */
const RTC_EPOCH_MS = new Date(2020, 0, 1).getTime()

function localMs(stamp: string): number {
  const parts = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(stamp)
  if (parts === null) throw new Error(`unparseable vendor timestamp: ${stamp}`)
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number)
  return new Date(year, month - 1, day, hour, minute, second).getTime()
}

function statusBits(row: SampledRow): number {
  return (
    (row.chargingEnabled ? 0x01 : 0) |
    (row.dischargingEnabled ? 0x02 : 0) |
    (row.balancing ? 0x04 : 0) |
    (row.heating ? 0x08 : 0)
  )
}

/** One 24-byte record laid out the way the detail-log specification describes it. */
function encodeRecord(row: SampledRow): Uint8Array {
  const record = new Uint8Array(RECORD_STRIDE)
  const view = new DataView(record.buffer)
  view.setUint32(0, Math.round((localMs(row.at) - RTC_EPOCH_MS) / 1000), true)
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

describe('a vendor detail-log export read back through the documented layout', () => {
  const records = decodeDetailLog(detailLogFrame(sampledRows.map(encodeRecord)))

  it('yields one record per exported row', () => {
    expect(records).toHaveLength(sampledRows.length)
  })

  sampledRows.forEach((row, position) => {
    it(`reproduces every value the vendor app rendered for ${row.at}`, () => {
      const record = records[position]

      expect(record.recordedAt).toBe(localMs(row.at))
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
    )

    expect(records.map((record) => record.index)).toEqual([754, 755])
  })

  it('decodes a full twelve-record frame without the stride drifting', () => {
    const filled = Array.from({ length: 12 }, (_, position) => sampledRows[position % sampledRows.length])
    const records = decodeDetailLog(detailLogFrame(filled.map(encodeRecord), 100))

    expect(records).toHaveLength(12)
    records.forEach((record, position) => {
      expect(record.index).toBe(100 + position)
      expect(record.recordedAt).toBe(localMs(filled[position].at))
      expect(record.current).toBeCloseTo(filled[position].current, 1)
      expect(record.mosfetTemperature).toBe(filled[position].mosfetTemperature)
    })
  })

  it('rejects a frame claiming more records than one can physically hold', () => {
    const frame = detailLogFrame(sampledRows.map(encodeRecord), 0, 13)

    expect(() => decodeDetailLog(frame)).toThrow(/at most 12/)
  })

  it('puts the RTC zero at local midnight on 2020-01-01, not at the UTC one', () => {
    const record = encodeRecord(sampledRows[0])
    new DataView(record.buffer).setUint32(0, 0, true)

    const [decoded] = decodeDetailLog(detailLogFrame([record]))
    const zero = new Date(decoded.recordedAt)

    expect(decoded.recordedAt).toBe(RTC_EPOCH_MS)
    expect([zero.getFullYear(), zero.getMonth(), zero.getDate(), zero.getHours(), zero.getMinutes()]).toEqual([
      2020, 0, 1, 0, 0,
    ])
  })

  // Hand-edited rows: the export holds no record with an unfitted probe or with heating running.
  it('reports an unfitted temperature probe as unavailable rather than as −1 °C', () => {
    const row = { ...sampledRows[0], highestTemperature: -1, lowestTemperature: -1 }
    const [record] = decodeDetailLog(detailLogFrame([encodeRecord(row)]))

    expect(record.highestTemperature).toBeNull()
    // The sentinel is documented on the highest channel alone; the others read verbatim.
    expect(record.lowestTemperature).toBe(-1)
  })

  it('reads the heating flag and a signed heating current', () => {
    const row = { ...sampledRows[0], heating: true, heatingCurrent: -1.2 }
    const [record] = decodeDetailLog(detailLogFrame([encodeRecord(row)]))

    expect(record.heating).toBe(true)
    expect(record.heatingCurrent).toBeCloseTo(-1.2, 1)
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
