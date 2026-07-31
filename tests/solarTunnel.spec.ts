/**
 * The framing layer of the SmartSolar's 306b GATT tunnel.
 *
 * Provenance, because it decides what these tests are worth. Most of the bytes below are
 * real, copied verbatim from three public captures:
 *
 *   - a VictronConnect Wireshark trace of a SmartSolar HQ2027LDKCU, published as the init
 *     sequence of `vvvrrooomm/victron`, which is where every read request here comes from;
 *   - VictronConnect debug logs off a Blue Smart IP22 24|16 charger, posted in
 *     `Olen/VictronConnect` issue 2, which is where every fragmented notification comes from;
 *   - Wireshark-derived unit fixtures for a SmartShunt in `vvvrrooomm/victron`, which come
 *     with the author's own asserted decodes and so pin the payload byte order to a value
 *     somebody else read off a display.
 *
 * The gap in that set is the point of the whole exercise. The SmartSolar trace contains the
 * app *asking* for the history registers and not one reply to any of them; every captured
 * history reply here came off a mains charger instead. The one developer to publish an
 * attempt reports the protocol decoding correctly and the SmartSolar simply not sending the
 * data. So the framing is tested against real bytes, and the thing the framing exists to
 * fetch has never been seen arriving from this device.
 *
 * Where a test uses invented bytes it says so.
 */

import { describe, expect, it } from 'vitest'

import { hexToBytes } from './support/bytes'
import { decodeSolarHistoryDay } from '../src/domain/solar/history'
import {
  MAX_CBOR_BYTE_STRING_LENGTH,
  encodeCborRegisterId,
  readCborByteString,
  readCborUnsignedInteger,
} from '../src/domain/solar/tunnel/cbor'
import { TUNNEL_OPCODES, TUNNEL_OPCODE_BYTES } from '../src/domain/solar/tunnel/TunnelOpcode'
import { MAX_PDU_LENGTH, TunnelReassembler } from '../src/domain/solar/tunnel/TunnelReassembler'
import { decodeTunnelReply, encodeRegisterReadRequest, readTunnelPdu } from '../src/domain/solar/tunnel/pdu'
import type { TunnelPdu } from '../src/domain/solar/tunnel/TunnelPdu'
import type { TunnelStatusReply } from '../src/domain/solar/tunnel/TunnelStatusReply'
import type { TunnelValueReport } from '../src/domain/solar/tunnel/TunnelValueReport'

const HISTORY_TOTALS_REGISTER = 0x104f
const HISTORY_TODAY_REGISTER = 0x1050

/**
 * Two notifications from one VictronConnect log, the first on 306b0004 and the second on
 * 306b0003 eight milliseconds later. Four PDUs, the last of which is a lone opcode byte at
 * the end of the first notification with its remaining five bytes on the other
 * characteristic.
 */
const SPLIT_ACROSS_CHARACTERISTICS = [
  hexToBytes('090019ede601090019ede0010800190206410009'),
  hexToBytes('0019ede801'),
] as const

/**
 * A 52-byte history record for register 0x1070, spread over three notifications: two on
 * 306b0004 and the last on 306b0003. This is the only captured history reply in existence
 * and it came off a mains charger, not a solar controller — the record is 52 bytes wide
 * where the documented solar day record is 34, so this is a different layout entirely. What
 * it does establish is the framing: `58 34` declares 0x34 = 52 bytes, and 13 + 20 + 19 of
 * payload arrive to match it.
 */
const HISTORY_RECORD_NOTIFICATIONS = [
  hexToBytes('0800191070583400000000003800000000000000'),
  hexToBytes('00000000000000000000000002' + '00000000000000'),
  hexToBytes('000000000000000000000000' + '950affff00ff00'),
] as const

/** One notification off 306b0003 holding two complete value reports back to back. */
const TWO_REPORTS_IN_ONE_NOTIFICATION = hexToBytes('080019eddb427e090800190120443c0c0000')

/** Two value reports and the first two bytes of a third, cut off by the notification. */
const REPORTS_WITH_A_TRUNCATED_TAIL = hexToBytes('080319ed8f42f8ff080319ed8c444efcffff0803')

/** SmartShunt fixtures whose decodes are asserted at the source: 13.27 V, −0.954 A, 100.0%. */
const SHUNT_VOLTAGE_REPORT = hexToBytes('080319ed8d422f05')
const SHUNT_CURRENT_REPORT = hexToBytes('080319ed8c4446fcffff')
const SHUNT_CHARGE_REPORT = hexToBytes('0803190fff421027')

/** The charger with no relay, answering for the relay-control register. */
const RELAY_UNSUPPORTED = hexToBytes('090019034e01')

/** The exported day `solarHistory.spec.ts` reads field by field: 1.63 kWh over 34 bytes. */
const EXPORTED_DAY = hexToBytes('00a3000000ffffffff9505f1040000000000e90184003d0149010000b9006308bc00')

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

function valueReport(pdu: TunnelPdu): TunnelValueReport {
  if (pdu.opcode !== 'valueReport') throw new Error(`expected a value report, got ${pdu.opcode}`)
  return pdu
}

function statusReply(pdu: TunnelPdu): TunnelStatusReply {
  if (pdu.opcode === 'valueReport') throw new Error('expected a status reply, got a value report')
  return pdu
}

function reassembleAll(...notifications: readonly Uint8Array[]): TunnelPdu[] {
  const reassembler = new TunnelReassembler()
  return notifications.flatMap((notification) => reassembler.feed(notification))
}

function littleEndian(payload: Uint8Array, signed: boolean): number {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  if (payload.length === 2) return signed ? view.getInt16(0, true) : view.getUint16(0, true)
  if (payload.length === 4) return signed ? view.getInt32(0, true) : view.getUint32(0, true)
  throw new Error(`the spec only reads 2- and 4-byte payloads, got ${payload.length}`)
}

/** An invented value report, for the shapes no capture covers. */
function inventedValueReport(register: number, payload: Uint8Array): Uint8Array {
  const valueHead = payload.length < 24 ? [0x40 + payload.length] : [0x58, payload.length]
  return concat(
    new Uint8Array([TUNNEL_OPCODE_BYTES.valueReport, 0x03]),
    encodeCborRegisterId(register),
    new Uint8Array(valueHead),
    payload,
  )
}

describe('encodeRegisterReadRequest against the captured app', () => {
  it('reproduces the bytes VictronConnect sent a SmartSolar for its history registers', () => {
    // Lifted out of the app's own write stream, which chops PDUs across 20-byte GATT writes:
    // "...8119103005038119104f050381191050". The app asked. Nothing came back.
    expect(hex(encodeRegisterReadRequest(HISTORY_TOTALS_REGISTER))).toBe('05038119104f')
    expect(hex(encodeRegisterReadRequest(HISTORY_TODAY_REGISTER))).toBe('050381191050')
  })

  it('reproduces the one-byte form for a register below 0x100', () => {
    // From the same stream: "...ec12050381181805038119010205038119edbc05".
    expect(hex(encodeRegisterReadRequest(0x18))).toBe('0503811818')
    expect(hex(encodeRegisterReadRequest(0x0102))).toBe('050381190102')
  })

  it('puts the seam between the two forms at 0x100', () => {
    expect(hex(encodeRegisterReadRequest(0x00ff))).toBe('05038118ff')
    expect(hex(encodeRegisterReadRequest(0x0100))).toBe('050381190100')
  })

  it('refuses anything that is not a register id', () => {
    expect(() => encodeRegisterReadRequest(-1)).toThrow(/not a register id: -1/)
    expect(() => encodeRegisterReadRequest(0x10000)).toThrow(/not a register id: 65536/)
    expect(() => encodeRegisterReadRequest(1.5)).toThrow(/not a register id: 1.5/)
  })
})

describe('the register is big-endian and everything inside it is not', () => {
  it('writes the register id high byte first, the opposite of VE.Direct over serial', () => {
    const request = encodeRegisterReadRequest(HISTORY_TODAY_REGISTER)

    expect(request[4]).toBe(0x10)
    expect(request[5]).toBe(0x50)
    // Serial would send 50 10, which asks a SmartSolar for register 0x5010 instead.
    expect(hex(request.slice(4))).not.toBe('5010')
  })

  it('reads a register id back the same way round', () => {
    expect(readCborUnsignedInteger(hexToBytes('191050'), 0)?.decoded).toBe(0x1050)
    expect(readCborUnsignedInteger(hexToBytes('195010'), 0)?.decoded).toBe(0x5010)
  })

  it('reads a captured payload low byte first, at the value its author read off the display', () => {
    // 2f 05 is 13.27 V in hundredths. Big-endian the same two bytes are 121.17 V.
    expect(littleEndian(valueReport(decodeTunnelReply(SHUNT_VOLTAGE_REPORT)).payload, false)).toBe(1327)
    // 46 fc ff ff is −0.954 A in thousandths. Big-endian it is 1187184639 A.
    expect(littleEndian(valueReport(decodeTunnelReply(SHUNT_CURRENT_REPORT)).payload, true)).toBe(-954)
    // 10 27 is 100.0%. Big-endian it is 415.9%.
    expect(littleEndian(valueReport(decodeTunnelReply(SHUNT_CHARGE_REPORT)).payload, false)).toBe(10000)
  })

  it('holds the two orders apart inside one captured PDU', () => {
    // 08 00 19 01 20 44 3c 0c 00 00: register 0x0120 high byte first, uptime low byte first.
    // Swap either and the other stops making sense — register 0x2001 does not exist, and
    // 3132 seconds of uptime becomes a device that has been running for a hundred years.
    const uptime = valueReport(reassembleAll(TWO_REPORTS_IN_ONE_NOTIFICATION)[1])

    expect(uptime.register).toBe(0x0120)
    expect(hex(uptime.payload)).toBe('3c0c0000')
    expect(littleEndian(uptime.payload, false)).toBe(3132)
  })

  it('carries a little-endian day record inside a big-endian register', () => {
    // Invented framing around the one real solar day record this repo has, so the two byte
    // orders meet in a single PDU. 1.63 kWh from a3 00 00 00; read big-endian those four
    // bytes are 27 million kWh from one June day.
    const reply = valueReport(decodeTunnelReply(inventedValueReport(HISTORY_TODAY_REGISTER, EXPORTED_DAY)))
    const day = decodeSolarHistoryDay(reply.payload)

    expect(reply.register).toBe(0x1050)
    if (!day.recorded) throw new Error('expected a recorded day')
    expect(day.yieldKwh).toBeCloseTo(1.63, 6)
  })
})

describe('decodeTunnelReply', () => {
  it('reads a captured value report', () => {
    const reply = valueReport(decodeTunnelReply(SHUNT_VOLTAGE_REPORT))

    expect(reply.opcode).toBe('valueReport')
    expect(reply.interfaceId).toBe(0x03)
    expect(reply.register).toBe(0xed8d)
    expect(hex(reply.payload)).toBe('2f05')
  })

  it('reads a captured unsupported-register reply', () => {
    // A charger with no relay, asked for the relay-control register 0x034E.
    const reply = statusReply(decodeTunnelReply(RELAY_UNSUPPORTED))

    expect(reply.opcode).toBe('registerUnsupported')
    expect(reply.interfaceId).toBe(0x00)
    expect(reply.register).toBe(0x034e)
    expect(reply.statusCode).toBe(0x01)
  })

  it('reads the status code a controller returns for a history record it does not hold', () => {
    // The sweep that produced these walked 0x1070 upward: records until 0x1074, then 0x02
    // for every register above it. Invented framing around a captured code and register.
    const reply = statusReply(decodeTunnelReply(hexToBytes('090019107502')))

    expect(reply.register).toBe(0x1075)
    expect(reply.statusCode).toBe(0x02)
  })

  it('reads an error reply, which no capture has ever contained', () => {
    // Opcode 0x07 is named in one line of prose and nowhere else. Decoding it as a status
    // reply is an assumption; it is written down here so that it is visible as one.
    expect(decodeTunnelReply(hexToBytes('070019107502')).opcode).toBe('error')
  })

  it('refuses a host request arriving where a reply belongs', () => {
    expect(() => decodeTunnelReply(hexToBytes('05038119104f'))).toThrow(/read is a host request/)
    expect(() => decodeTunnelReply(hexToBytes('0600821893421027'))).toThrow(/write is a host request/)
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
    expect(() => decodeTunnelReply(SHUNT_CURRENT_REPORT.slice(0, 8))).toThrow(/incomplete: 8 bytes/)
    expect(() => decodeTunnelReply(hexToBytes('0803'))).toThrow(/incomplete: 2 bytes/)
  })

  it('refuses trailing bytes rather than ignoring a second PDU', () => {
    expect(() => decodeTunnelReply(TWO_REPORTS_IN_ONE_NOTIFICATION)).toThrow(/10 trailing bytes/)
  })
})

describe('the CBOR byte-string length forms', () => {
  it('reads the short forms the captured registers use', () => {
    expect(readCborByteString(hexToBytes('4100'), 0)?.decoded).toHaveLength(1)
    expect(readCborByteString(hexToBytes('422f05'), 0)?.decoded).toHaveLength(2)
    expect(readCborByteString(hexToBytes('4446fcffff'), 0)?.decoded).toHaveLength(4)
    expect(readCborByteString(concat(hexToBytes('50'), new Uint8Array(16)), 0)?.decoded).toHaveLength(16)
  })

  it('decodes 0x58 as a long form with a following length, not as a width of two', () => {
    // The captured history record declares 58 34 and 52 bytes follow it. Reading 0x58 out
    // of a table of head bytes gives a 2-byte value and leaves 51 bytes of the record in the
    // stream, which then resynchronises into rubbish.
    const [record] = reassembleAll(...HISTORY_RECORD_NOTIFICATIONS)
    const report = valueReport(record)

    expect(hex(HISTORY_RECORD_NOTIFICATIONS[0].slice(5, 7))).toBe('5834')
    expect(report.register).toBe(0x1070)
    expect(report.payload).toHaveLength(0x34)
    expect(report.payload).toHaveLength(52)
  })

  it('puts the seam between the short and long forms exactly where CBOR puts it', () => {
    const twentyThree = inventedValueReport(HISTORY_TODAY_REGISTER, new Uint8Array(23))
    const twentyFour = inventedValueReport(HISTORY_TODAY_REGISTER, new Uint8Array(24))

    expect(twentyThree[5]).toBe(0x57)
    expect(hex(twentyFour.slice(5, 7))).toBe('5818')
    expect(valueReport(decodeTunnelReply(twentyThree)).payload).toHaveLength(23)
    expect(valueReport(decodeTunnelReply(twentyFour)).payload).toHaveLength(24)
  })

  it('reads the two-byte length form rather than guessing at it', () => {
    const long = concat(hexToBytes('590101'), new Uint8Array(257))

    expect(readCborByteString(long, 0)?.decoded).toHaveLength(257)
    expect(readCborByteString(long, 0)?.nextOffset).toBe(260)
  })

  it('refuses a length form no capture shows the tunnel using', () => {
    // Indefinite-length byte strings and the four- and eight-byte lengths are all valid
    // CBOR. Refusing them is the point: a guessed width walks off the end of the PDU.
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
    expect(readCborByteString(hexToBytes('5834'), 0)).toBeNull()
    expect(readCborByteString(hexToBytes('58'), 0)).toBeNull()
    expect(readCborByteString(hexToBytes('422f'), 0)).toBeNull()
  })
})

describe('TunnelReassembler across the two notification characteristics', () => {
  it('joins a PDU split between 306b0004 and 306b0003 mid-message', () => {
    // The first notification ends on a bare opcode byte; its interface, register and status
    // arrive on the other characteristic. A buffer per characteristic sees one byte that is
    // not a PDU and five bytes that are not a PDU, and reports neither.
    const reassembler = new TunnelReassembler()
    const fromNotifyFour = reassembler.feed(SPLIT_ACROSS_CHARACTERISTICS[0])

    expect(fromNotifyFour.map((pdu) => pdu.register)).toEqual([0xede6, 0xede0, 0x0206])
    expect(reassembler.bufferedBytes).toBe(1)

    const fromNotifyThree = reassembler.feed(SPLIT_ACROSS_CHARACTERISTICS[1])

    expect(fromNotifyThree).toHaveLength(1)
    expect(statusReply(fromNotifyThree[0]).register).toBe(0xede8)
    expect(statusReply(fromNotifyThree[0]).statusCode).toBe(0x01)
    expect(reassembler.bufferedBytes).toBe(0)
  })

  it('joins a record split three ways across both characteristics', () => {
    const reassembler = new TunnelReassembler()

    expect(reassembler.feed(HISTORY_RECORD_NOTIFICATIONS[0])).toHaveLength(0)
    expect(reassembler.bufferedBytes).toBe(20)
    expect(reassembler.feed(HISTORY_RECORD_NOTIFICATIONS[1])).toHaveLength(0)
    expect(reassembler.bufferedBytes).toBe(40)

    const completed = reassembler.feed(HISTORY_RECORD_NOTIFICATIONS[2])

    expect(completed).toHaveLength(1)
    expect(valueReport(completed[0]).payload).toHaveLength(52)
    expect(reassembler.bufferedBytes).toBe(0)
  })

  it('yields both PDUs when one notification holds two', () => {
    const [temperature, uptime] = reassembleAll(TWO_REPORTS_IN_ONE_NOTIFICATION)

    expect(valueReport(temperature).register).toBe(0xeddb)
    expect(hex(valueReport(temperature).payload)).toBe('7e09')
    expect(valueReport(uptime).register).toBe(0x0120)
    expect(hex(valueReport(uptime).payload)).toBe('3c0c0000')
  })

  it('yields three PDUs when one notification holds three', () => {
    const registers = reassembleAll(SPLIT_ACROSS_CHARACTERISTICS[0]).map((pdu) => pdu.register)
    expect(registers).toEqual([0xede6, 0xede0, 0x0206])
  })

  it('holds a truncated tail back rather than reporting a short payload', () => {
    // A captured notification that ends two bytes into a third report: the opcode and the
    // interface arrived, the register did not.
    const reassembler = new TunnelReassembler()
    const pdus = reassembler.feed(REPORTS_WITH_A_TRUNCATED_TAIL)

    expect(pdus.map((pdu) => pdu.register)).toEqual([0xed8f, 0xed8c])
    expect(reassembler.bufferedBytes).toBe(2)

    // The rest of that report, had the capture kept it: register 0xED8D, 13.27 V.
    const completed = reassembler.feed(SHUNT_VOLTAGE_REPORT.slice(2))

    expect(completed).toHaveLength(1)
    expect(valueReport(completed[0]).register).toBe(0xed8d)
    expect(reassembler.bufferedBytes).toBe(0)
  })

  it('holds back a record that is one byte short of its declared length', () => {
    const record = concat(...HISTORY_RECORD_NOTIFICATIONS)
    const reassembler = new TunnelReassembler()

    expect(reassembler.feed(record.slice(0, record.length - 1))).toHaveLength(0)
    expect(reassembler.bufferedBytes).toBe(58)
    expect(reassembler.feed(record.slice(record.length - 1))).toHaveLength(1)
  })

  it('resynchronises a byte at a time instead of discarding the buffer', () => {
    // A dropped notification leaves wreckage the tunnel cannot detect: there is no checksum
    // here. Skipping a whole PDU's worth of bytes would eat the next good reply along with
    // the damage.
    const pdus = reassembleAll(concat(hexToBytes('deadbeef'), SHUNT_CHARGE_REPORT))

    expect(pdus).toHaveLength(1)
    expect(valueReport(pdus[0]).register).toBe(0x0fff)
  })

  it('drops a host request that appears in the notification stream', () => {
    const reassembler = new TunnelReassembler()
    const stream = concat(encodeRegisterReadRequest(HISTORY_TODAY_REGISTER), SHUNT_CHARGE_REPORT)
    const pdus = reassembler.feed(stream)

    expect(pdus).toHaveLength(1)
    expect(pdus[0].opcode).toBe('valueReport')
    expect(reassembler.bufferedBytes).toBe(0)
  })

  it('does not let a corrupt length grow the buffer', () => {
    const reassembler = new TunnelReassembler()
    const pdus = reassembler.feed(concat(hexToBytes('080319105059ffff'), SHUNT_CHARGE_REPORT))

    expect(pdus).toHaveLength(1)
    expect(valueReport(pdus[0]).register).toBe(0x0fff)
    expect(reassembler.bufferedBytes).toBe(0)
  })

  it('bounds the buffer at one PDU while a declared length is outstanding', () => {
    // A value report declaring the largest byte string the tunnel accepts, whose payload
    // then dribbles in and never finishes. The buffer holds what has arrived and no more.
    const reassembler = new TunnelReassembler()
    reassembler.feed(hexToBytes('0803191050590200'))

    for (let notification = 0; notification < 20; notification += 1) {
      expect(reassembler.feed(new Uint8Array(20))).toHaveLength(0)
    }

    expect(reassembler.bufferedBytes).toBe(408)
    expect(reassembler.bufferedBytes).toBeLessThan(MAX_PDU_LENGTH)
  })

  it('forgets a half-arrived PDU on reset', () => {
    const record = concat(...HISTORY_RECORD_NOTIFICATIONS)
    const reassembler = new TunnelReassembler()

    reassembler.feed(HISTORY_RECORD_NOTIFICATIONS[0])
    expect(reassembler.bufferedBytes).toBe(20)

    reassembler.reset()
    expect(reassembler.bufferedBytes).toBe(0)

    const pdus = reassembler.feed(record)
    expect(pdus).toHaveLength(1)
    expect(valueReport(pdus[0]).payload).toHaveLength(52)
  })

  it('carries the interface byte through rather than assuming one', () => {
    // The same app session uses 0x00 against a charger and 0x03 against a SmartShunt.
    expect(reassembleAll(SPLIT_ACROSS_CHARACTERISTICS[0])[0].interfaceId).toBe(0x00)
    expect(reassembleAll(SHUNT_VOLTAGE_REPORT)[0].interfaceId).toBe(0x03)
  })
})

describe('readTunnelPdu', () => {
  it('reports where the next PDU begins', () => {
    const first = readTunnelPdu(TWO_REPORTS_IN_ONE_NOTIFICATION, 0)

    expect(first?.nextOffset).toBe(8)
    expect(readTunnelPdu(TWO_REPORTS_IN_ONE_NOTIFICATION, 8)?.decoded.register).toBe(0x0120)
  })

  it('distinguishes waiting for bytes from refusing them', () => {
    expect(readTunnelPdu(HISTORY_RECORD_NOTIFICATIONS[0], 0)).toBeNull()
    expect(readTunnelPdu(new Uint8Array(0), 0)).toBeNull()
    expect(() => readTunnelPdu(hexToBytes('0103191050'), 0)).toThrow(/not a tunnel opcode/)
  })
})

describe('the opcode enum', () => {
  it('names every byte the protocol defines', () => {
    expect(TUNNEL_OPCODES).toHaveLength(5)
    expect(TUNNEL_OPCODES.map((opcode) => TUNNEL_OPCODE_BYTES[opcode])).toEqual([0x05, 0x06, 0x07, 0x08, 0x09])
  })
})
