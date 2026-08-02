/**
 * The framing layer of the SmartSolar's 306b GATT tunnel.
 *
 * Almost every byte below is a frame this boat's controller actually sent or received, replayed out
 * of `tests/fixtures/solarHistoryWire.json`: the read requests the vendor app wrote, the value
 * reports that came back, and the session-open and keepalive frames that surround them. None of the
 * framing is inferred from a document: a request encoded here has to match the bytes the app put on
 * the wire, and a reply decoded here has to give back the payload the history decoder then reads.
 *
 * Two frames come from published captures of other Victron products, and say so at the point of
 * use. Both are 0x09 status replies, a shape this controller had no cause to send — every register
 * asked of it existed.
 *
 * The safety property gets its own describe block. A write on this tunnel is a read with one byte
 * changed, and one nearby register is believed to erase the stored history, so "there is no encoder
 * for a write" is asserted here rather than left as an assumption a future edit could quietly drop.
 */

import { describe, expect, it } from 'vitest'

import { hexToBytes } from './support/bytes'
import { decodeSolarHistoryDay, decodeSolarHistoryTotals } from '../src/domain/solar/history'
import {
  HISTORY_TODAY_REGISTER,
  HISTORY_TOTALS_REGISTER,
  SOLAR_HISTORY_REGISTERS,
} from '../src/domain/solar/SolarHistoryRegister'
import * as cbor from '../src/domain/solar/tunnel/cbor'
import * as pdu from '../src/domain/solar/tunnel/pdu'
import * as reassembly from '../src/domain/solar/tunnel/TunnelReassembler'
import { TUNNEL_OPCODE_BYTES } from '../src/domain/solar/tunnel/TunnelOpcode'
import type { TunnelPdu } from '../src/domain/solar/tunnel/TunnelPdu'
import type { TunnelStatusReply } from '../src/domain/solar/tunnel/TunnelStatusReply'
import type { TunnelValueReport } from '../src/domain/solar/tunnel/TunnelValueReport'
import wire from './fixtures/solarHistoryWire.json'

const { MAX_CBOR_BYTE_STRING_LENGTH, encodeCborRegisterId } = cbor
const { readCborByteString, readCborUnsignedInteger } = cbor
const { decodeTunnelReply, encodeRegisterReadRequest, readTunnelPdu } = pdu
const { MAX_PDU_LENGTH, TunnelReassembler } = reassembly

const frames = wire.capturedFrames

const VALUE_REPORT_TOTALS = hexToBytes(frames.valueReportTotals)
const VALUE_REPORT_TODAY = hexToBytes(frames.valueReportToday)

/**
 * A charger with no relay answering for the relay-control register, from a published VictronConnect
 * debug log. This boat's controller never sent a 0x09: every register asked of it existed.
 */
const RELAY_UNSUPPORTED = hexToBytes('090019034e01')

/**
 * A controller reporting that a history record does not exist, from a register sweep that walked
 * upward until the records ran out. Invented framing around a captured register and status code.
 */
const HISTORY_RECORD_ABSENT = hexToBytes('090019107502')

/** What a Bluetooth notification can carry at the MTU these sessions negotiate. */
const NOTIFICATION_BYTES = 20

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function concat(...chunks: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  chunks.reduce((offset, chunk) => {
    joined.set(chunk, offset)
    return offset + chunk.length
  }, 0)
  return joined
}

function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.slice(offset, offset + size))
  }
  return chunks
}

function valueReport(frame: TunnelPdu): TunnelValueReport {
  if (frame.opcode !== 'valueReport') throw new Error(`expected a value report, got ${frame.opcode}`)
  return frame
}

function statusReply(frame: TunnelPdu): TunnelStatusReply {
  if (frame.opcode === 'valueReport') throw new Error('expected a status reply, got a value report')
  return frame
}

function reassembleAll(...notifications: readonly Uint8Array[]): TunnelPdu[] {
  const reassembler = new TunnelReassembler()
  return notifications.flatMap((notification) => reassembler.feed(notification))
}

/** A frame's payload as hex, or its opcode where it carried no payload at all. */
function payloadOf(frame: TunnelPdu): string {
  return frame.opcode === 'valueReport' ? hex(frame.payload) : frame.opcode
}

/**
 * The reply the controller would send for a register, built around a captured payload.
 *
 * The capture holds two whole replies and thirty-one payloads. Wrapping the rest in the framing
 * those two establish — `08 03 19 <reg-be16> 58 22` — is what lets the reassembler be driven over a
 * whole backlog rather than a single record.
 */
function valueReportFrame(register: number, payloadHex: string): Uint8Array {
  const registerId = encodeCborRegisterId(register)
  const head = new Uint8Array([TUNNEL_OPCODE_BYTES.valueReport, 0x03])
  return concat(head, registerId, hexToBytes('5822'), hexToBytes(payloadHex))
}

describe('encodeRegisterReadRequest against the frames the vendor app sent', () => {
  it('reproduces the captured request for the totals register byte for byte', () => {
    expect(hex(encodeRegisterReadRequest(HISTORY_TOTALS_REGISTER))).toBe('05038119104f')
    expect(hex(encodeRegisterReadRequest(HISTORY_TOTALS_REGISTER))).toBe(frames.readRequestTotals)
  })

  it('reproduces the captured request for today', () => {
    expect(hex(encodeRegisterReadRequest(HISTORY_TODAY_REGISTER))).toBe(frames.readRequestToday)
    expect(hex(encodeRegisterReadRequest(HISTORY_TODAY_REGISTER))).toBe('050381191050')
  })

  it('spells every register the same way: read, interface 0x03, an array of one', () => {
    SOLAR_HISTORY_REGISTERS.forEach((register) => {
      const request = encodeRegisterReadRequest(register)

      expect(request).toHaveLength(6)
      expect(request[0]).toBe(TUNNEL_OPCODE_BYTES.read)
      expect(request[1]).toBe(0x03)
      expect(request[2]).toBe(0x81)
      expect(request[3]).toBe(0x19)
    })
  })

  it('writes the register id high byte first, the opposite of VE.Direct over serial', () => {
    const request = encodeRegisterReadRequest(HISTORY_TODAY_REGISTER)

    expect(request[4]).toBe(0x10)
    expect(request[5]).toBe(0x50)
    // Serial would send 50 10, which asks the controller for register 0x5010 instead.
    expect(hex(request.slice(4))).not.toBe('5010')
  })

  it('reads a register id back the same way round', () => {
    expect(readCborUnsignedInteger(hexToBytes('191050'), 0)?.decoded).toBe(0x1050)
    expect(readCborUnsignedInteger(hexToBytes('195010'), 0)?.decoded).toBe(0x5010)
  })

  it('refuses anything that is not a register id', () => {
    expect(() => encodeCborRegisterId(-1)).toThrow(/not a register id: -1/)
    expect(() => encodeCborRegisterId(0x10000)).toThrow(/not a register id: 65536/)
    expect(() => encodeCborRegisterId(1.5)).toThrow(/not a register id: 1.5/)
  })
})

describe('there is no way to encode a write', () => {
  it('exports a read encoder and two readers, and nothing else', () => {
    expect(Object.keys(pdu).sort()).toEqual(['decodeTunnelReply', 'encodeRegisterReadRequest', 'readTunnelPdu'])
  })

  it('exports nothing anywhere in the codec whose name is a write', () => {
    const codecExports = [...Object.keys(pdu), ...Object.keys(cbor), ...Object.keys(reassembly)]

    expect(codecExports.filter((name) => /write|clear|erase/i.test(name))).toEqual([])
    expect(codecExports.filter((name) => name.startsWith('encode')).sort()).toEqual([
      'encodeCborRegisterId',
      'encodeRegisterReadRequest',
    ])
  })

  it('emits the read opcode for every register a caller may ask for, and never 0x06', () => {
    expect(TUNNEL_OPCODE_BYTES.write).toBe(0x06)

    SOLAR_HISTORY_REGISTERS.forEach((register) => {
      const request = encodeRegisterReadRequest(register)

      expect(request[0]).toBe(TUNNEL_OPCODE_BYTES.read)
      expect(Array.from(request)).not.toContain(TUNNEL_OPCODE_BYTES.write)
    })
  })

  it('refuses a host request arriving where a reply belongs', () => {
    // The keepalive is a real 0x06 write frame the session sends every few seconds. It decodes as
    // nothing, which is the only thing this codec is willing to do with one.
    expect(() => decodeTunnelReply(hexToBytes(frames.readRequestTotals))).toThrow(/read is a host request/)
    expect(() => decodeTunnelReply(hexToBytes(frames.keepalive))).toThrow(/write is a host request/)
  })
})

describe('decodeTunnelReply against the captured value reports', () => {
  it('reads the totals reply back to its register and its payload', () => {
    const reply = valueReport(decodeTunnelReply(VALUE_REPORT_TOTALS))

    expect(reply.opcode).toBe('valueReport')
    expect(reply.interfaceId).toBe(0x03)
    expect(reply.register).toBe(HISTORY_TOTALS_REGISTER)
    expect(hex(reply.payload)).toBe(wire.totals)
  })

  it('reads today’s reply back to its register and its payload', () => {
    const reply = valueReport(decodeTunnelReply(VALUE_REPORT_TODAY))

    expect(reply.register).toBe(HISTORY_TODAY_REGISTER)
    expect(hex(reply.payload)).toBe(wire.days[0].bytes)
  })

  it('reads the 58 22 byte-string header as a length of 34, not a value two bytes wide', () => {
    // Head 0x58 declares that one length byte follows; 0x22 is 34, the width of a day record.
    // Taken from a table of head bytes instead, 0x58 reads as a 2-byte value and leaves 33 bytes
    // of the record in the stream to resynchronise into rubbish.
    expect(hex(VALUE_REPORT_TODAY.slice(5, 7))).toBe('5822')
    expect(valueReport(decodeTunnelReply(VALUE_REPORT_TODAY)).payload).toHaveLength(0x22)
    expect(valueReport(decodeTunnelReply(VALUE_REPORT_TODAY)).payload).toHaveLength(34)
  })

  it('hands the history decoder a payload it reads as the day the export names', () => {
    const today = decodeSolarHistoryDay(valueReport(decodeTunnelReply(VALUE_REPORT_TODAY)).payload)
    const totals = decodeSolarHistoryTotals(valueReport(decodeTunnelReply(VALUE_REPORT_TOTALS)).payload)

    if (!today.recorded) throw new Error('expected a recorded day')
    expect(today.daySequenceNumber).toBeGreaterThan(0)
    expect(totals.daysAvailable).toBe(30)
  })

  it('keeps the big-endian register and the little-endian payload apart in one frame', () => {
    // Register 0x1050 reads high byte first; the yield inside it reads low byte first. Swap either
    // and the other stops making sense — 0x5010 is not a register the controller has, and a
    // big-endian yield is twenty-two million kilowatt-hours from one July day.
    const reply = valueReport(decodeTunnelReply(VALUE_REPORT_TODAY))
    const yieldBytes = reply.payload.slice(1, 5)
    const day = decodeSolarHistoryDay(reply.payload)

    expect(reply.register).toBe(0x1050)
    expect(hex(yieldBytes)).toBe('86000000')
    if (!day.recorded) throw new Error('expected a recorded day')
    expect(day.yieldKwh).toBeCloseTo(1.34, 6)
  })

  it('reads a status reply as a value rather than throwing', () => {
    const reply = statusReply(decodeTunnelReply(RELAY_UNSUPPORTED))

    expect(reply.opcode).toBe('registerUnsupported')
    expect(reply.interfaceId).toBe(0x00)
    expect(reply.register).toBe(0x034e)
    expect(reply.statusCode).toBe(0x01)
  })

  it('reads the status code a controller returns for a history record it does not hold', () => {
    const reply = statusReply(decodeTunnelReply(HISTORY_RECORD_ABSENT))

    expect(reply.register).toBe(0x1075)
    expect(reply.statusCode).toBe(0x02)
  })

  it('reads the error frame that arrives during every session open', () => {
    // The vendor app receives this immediately after opening the command channel and carries on
    // regardless, so it is a finding about the exchange and not a reason to abandon the session.
    const reply = statusReply(decodeTunnelReply(hexToBytes(frames.sessionErrorAfterOpen)))

    expect(reply.opcode).toBe('error')
  })

  it('refuses a byte that is not an opcode at all', () => {
    expect(() => decodeTunnelReply(hexToBytes('0403191050'))).toThrow(/not a tunnel opcode: 0x04/)
    expect(() => decodeTunnelReply(hexToBytes('ff03191050'))).toThrow(/not a tunnel opcode: 0xff/)
  })

  it('refuses a value report whose value is not a byte string', () => {
    expect(() => decodeTunnelReply(hexToBytes('0803191050190001'))).toThrow(/not a CBOR byte string/)
  })

  it('refuses a register id encoded as a wider CBOR integer', () => {
    expect(() => decodeTunnelReply(hexToBytes('08031a0000105041ff'))).toThrow(/unsupported CBOR head 0x1a/)
  })

  it('refuses a truncated reply rather than reporting a short payload', () => {
    expect(() => decodeTunnelReply(VALUE_REPORT_TODAY.slice(0, 20))).toThrow(/incomplete: 20 bytes/)
    expect(() => decodeTunnelReply(hexToBytes('0803'))).toThrow(/incomplete: 2 bytes/)
  })

  it('refuses trailing bytes rather than ignoring a second PDU', () => {
    const twoReports = concat(VALUE_REPORT_TODAY, VALUE_REPORT_TOTALS)

    expect(() => decodeTunnelReply(twoReports)).toThrow(/41 trailing bytes/)
  })
})

describe('the CBOR byte-string length forms', () => {
  it('reads the short forms a narrow register uses', () => {
    expect(readCborByteString(hexToBytes('4100'), 0)?.decoded).toHaveLength(1)
    expect(readCborByteString(hexToBytes('422f05'), 0)?.decoded).toHaveLength(2)
    expect(readCborByteString(hexToBytes('4446fcffff'), 0)?.decoded).toHaveLength(4)
    expect(readCborByteString(concat(hexToBytes('50'), new Uint8Array(16)), 0)?.decoded).toHaveLength(16)
  })

  it('reads the two-byte length form rather than guessing at it', () => {
    const long = concat(hexToBytes('590101'), new Uint8Array(257))

    expect(readCborByteString(long, 0)?.decoded).toHaveLength(257)
    expect(readCborByteString(long, 0)?.nextOffset).toBe(260)
  })

  it('refuses a length form no capture shows the tunnel using', () => {
    // Indefinite-length byte strings and the four- and eight-byte lengths are all valid CBOR.
    // Refusing them is the point: a guessed width walks off the end of the PDU.
    expect(() => readCborByteString(hexToBytes('5f41ff41ffff'), 0)).toThrow(/unsupported CBOR head 0x5f/)
    expect(() => readCborByteString(hexToBytes('5a00000001ff'), 0)).toThrow(/unsupported CBOR head 0x5a/)
    expect(() => readCborByteString(hexToBytes('5c00'), 0)).toThrow(/unsupported CBOR head 0x5c/)
  })

  it('refuses a length beyond the tunnel ceiling instead of reserving room for it', () => {
    const ceiling = new Uint8Array([0x59, MAX_CBOR_BYTE_STRING_LENGTH >> 8, MAX_CBOR_BYTE_STRING_LENGTH & 0xff])
    const atCeiling = concat(ceiling, new Uint8Array(MAX_CBOR_BYTE_STRING_LENGTH))

    expect(readCborByteString(atCeiling, 0)?.decoded).toHaveLength(MAX_CBOR_BYTE_STRING_LENGTH)
    expect(() => readCborByteString(hexToBytes('59ffff'), 0)).toThrow(/exceeds the tunnel's ceiling/)
  })

  it('waits for a byte string whose declared length has not arrived', () => {
    expect(readCborByteString(hexToBytes('5822'), 0)).toBeNull()
    expect(readCborByteString(hexToBytes('58'), 0)).toBeNull()
    expect(readCborByteString(hexToBytes('422f'), 0)).toBeNull()
  })
})

describe('TunnelReassembler across the command and bulk characteristics', () => {
  it('joins a captured reply cut in half', () => {
    const half = Math.floor(VALUE_REPORT_TODAY.length / 2)
    const reassembler = new TunnelReassembler()

    expect(reassembler.feed(VALUE_REPORT_TODAY.slice(0, half))).toHaveLength(0)
    expect(reassembler.bufferedBytes).toBe(half)

    const completed = reassembler.feed(VALUE_REPORT_TODAY.slice(half))

    expect(completed).toHaveLength(1)
    expect(hex(valueReport(completed[0]).payload)).toBe(wire.days[0].bytes)
    expect(reassembler.bufferedBytes).toBe(0)
  })

  it('joins that reply cut at every byte boundary there is', () => {
    for (let cut = 1; cut < VALUE_REPORT_TODAY.length; cut += 1) {
      const pdus = reassembleAll(VALUE_REPORT_TODAY.slice(0, cut), VALUE_REPORT_TODAY.slice(cut))

      expect(pdus).toHaveLength(1)
      expect(hex(valueReport(pdus[0]).payload)).toBe(wire.days[0].bytes)
    }
  })

  it('treats the two notification characteristics as one stream', () => {
    // Fragments interleave between 306b0003 and 306b0004 and a single PDU splits across the pair.
    // A buffer per characteristic does not merely lose replies: it staples the head of one register
    // onto the body of another and hands back a record that decodes cleanly and is fiction. `feed`
    // takes bytes and not a characteristic because there is nothing correct to do with the
    // difference.
    const notifications = chunked(concat(VALUE_REPORT_TOTALS, VALUE_REPORT_TODAY), NOTIFICATION_BYTES)
    const capturedPayloads = [wire.totals, wire.days[0].bytes]
    const reassembler = new TunnelReassembler()
    const command = new TunnelReassembler()
    const bulk = new TunnelReassembler()

    const joined = notifications.flatMap((notification) => reassembler.feed(notification))
    const perCharacteristic = notifications.flatMap((notification, index) => {
      return index % 2 === 0 ? bulk.feed(notification) : command.feed(notification)
    })

    expect(joined.map((frame) => frame.register)).toEqual([HISTORY_TOTALS_REGISTER, HISTORY_TODAY_REGISTER])
    expect(joined.map((frame) => hex(valueReport(frame).payload))).toEqual(capturedPayloads)
    // One record comes back, and it is fiction: the totals register's head with today's tail.
    expect(perCharacteristic.map((frame) => frame.register)).toEqual([HISTORY_TOTALS_REGISTER])
    expect(perCharacteristic.map(payloadOf)).not.toEqual(capturedPayloads)
    expect(payloadOf(perCharacteristic[0])).not.toBe(wire.totals)
  })

  it('yields both PDUs when one notification holds two', () => {
    const [totals, today] = reassembleAll(concat(VALUE_REPORT_TOTALS, VALUE_REPORT_TODAY))

    expect(hex(valueReport(totals).payload)).toBe(wire.totals)
    expect(hex(valueReport(today).payload)).toBe(wire.days[0].bytes)
  })

  it('reassembles the whole captured backlog arriving as GATT-sized notifications', () => {
    // The reconstructed framing is checked against the two real replies first, so what follows is
    // thirty-one captured payloads in a wrapper the capture itself vouches for.
    expect(hex(valueReportFrame(wire.totalsRegister, wire.totals))).toBe(frames.valueReportTotals)
    expect(hex(valueReportFrame(wire.days[0].register, wire.days[0].bytes))).toBe(frames.valueReportToday)

    const backlog = concat(...wire.days.map((day) => valueReportFrame(day.register, day.bytes)))
    const pdus = reassembleAll(...chunked(backlog, NOTIFICATION_BYTES))

    expect(pdus).toHaveLength(wire.days.length)
    expect(pdus.map((frame) => frame.register)).toEqual(wire.days.map((day) => day.register))
    expect(pdus.map(payloadOf)).toEqual(wire.days.map((day) => day.bytes))
  })

  it('holds a truncated tail back rather than reporting a short payload', () => {
    const reassembler = new TunnelReassembler()
    const pdus = reassembler.feed(concat(VALUE_REPORT_TODAY, VALUE_REPORT_TOTALS.slice(0, 2)))

    expect(pdus).toHaveLength(1)
    expect(reassembler.bufferedBytes).toBe(2)

    const completed = reassembler.feed(VALUE_REPORT_TOTALS.slice(2))

    expect(completed).toHaveLength(1)
    expect(hex(valueReport(completed[0]).payload)).toBe(wire.totals)
    expect(reassembler.bufferedBytes).toBe(0)
  })

  it('resynchronises a byte at a time instead of discarding the buffer', () => {
    // A dropped notification leaves wreckage the tunnel cannot detect: there is no checksum here.
    // Skipping a whole PDU's worth of bytes would eat the next good reply along with the damage.
    const pdus = reassembleAll(concat(hexToBytes('deadbeef'), VALUE_REPORT_TODAY))

    expect(pdus).toHaveLength(1)
    expect(valueReport(pdus[0]).register).toBe(HISTORY_TODAY_REGISTER)
  })

  it('drops a host request that appears in the notification stream', () => {
    const reassembler = new TunnelReassembler()
    const stream = concat(hexToBytes(frames.readRequestToday), VALUE_REPORT_TODAY)
    const pdus = reassembler.feed(stream)

    expect(pdus).toHaveLength(1)
    expect(pdus[0].opcode).toBe('valueReport')
    expect(reassembler.bufferedBytes).toBe(0)
  })

  it('does not let a corrupt length grow the buffer', () => {
    const reassembler = new TunnelReassembler()
    const pdus = reassembler.feed(concat(hexToBytes('080319105059ffff'), VALUE_REPORT_TODAY))

    expect(pdus).toHaveLength(1)
    expect(hex(valueReport(pdus[0]).payload)).toBe(wire.days[0].bytes)
    expect(reassembler.bufferedBytes).toBe(0)
  })

  it('bounds the buffer at one PDU while a declared length is outstanding', () => {
    // A value report declaring the largest byte string the tunnel accepts, whose payload then
    // dribbles in and never finishes. The buffer holds what has arrived and no more.
    const reassembler = new TunnelReassembler()
    reassembler.feed(hexToBytes('0803191050590200'))

    for (let notification = 0; notification < 20; notification += 1) {
      expect(reassembler.feed(new Uint8Array(NOTIFICATION_BYTES))).toHaveLength(0)
    }

    expect(reassembler.bufferedBytes).toBe(408)
    expect(reassembler.bufferedBytes).toBeLessThan(MAX_PDU_LENGTH)
  })

  it('forgets a half-arrived PDU on reset', () => {
    const reassembler = new TunnelReassembler()

    reassembler.feed(VALUE_REPORT_TODAY.slice(0, 20))
    expect(reassembler.bufferedBytes).toBe(20)

    reassembler.reset()
    expect(reassembler.bufferedBytes).toBe(0)

    const pdus = reassembler.feed(VALUE_REPORT_TODAY)
    expect(pdus).toHaveLength(1)
    expect(hex(valueReport(pdus[0]).payload)).toBe(wire.days[0].bytes)
  })

  it('carries the interface byte through rather than assuming one', () => {
    expect(reassembleAll(VALUE_REPORT_TODAY)[0].interfaceId).toBe(0x03)
    expect(reassembleAll(RELAY_UNSUPPORTED)[0].interfaceId).toBe(0x00)
  })
})

describe('readTunnelPdu', () => {
  it('reports where the next PDU begins', () => {
    const stream = concat(VALUE_REPORT_TOTALS, VALUE_REPORT_TODAY)
    const first = readTunnelPdu(stream, 0)

    expect(first?.nextOffset).toBe(VALUE_REPORT_TOTALS.length)
    expect(readTunnelPdu(stream, VALUE_REPORT_TOTALS.length)?.decoded.register).toBe(HISTORY_TODAY_REGISTER)
  })

  it('distinguishes waiting for bytes from refusing them', () => {
    expect(readTunnelPdu(VALUE_REPORT_TODAY.slice(0, 20), 0)).toBeNull()
    expect(readTunnelPdu(new Uint8Array(0), 0)).toBeNull()
    expect(() => readTunnelPdu(hexToBytes('0103191050'), 0)).toThrow(/not a tunnel opcode/)
  })
})

describe('the opcode enum', () => {
  it('names every byte the protocol defines', () => {
    expect(TUNNEL_OPCODE_BYTES).toEqual({
      read: 0x05,
      write: 0x06,
      error: 0x07,
      valueReport: 0x08,
      registerUnsupported: 0x09,
    })
  })
})
