/**
 * The PDU codec for the SmartSolar's 306b GATT tunnel.
 *
 * The framing is CBOR, despite the tunnel carrying VE.Direct registers. There is no ':' start byte,
 * no nibble-per-character encoding and no VE.Direct checksum — those belong to VE.Direct over a
 * serial line, which is a different link with a different byte order.
 *
 *   read request     05 03 81 19 <reg-be16>
 *   value report     08 03 19 <reg-be16> 58 22 <34 bytes>
 *   status reply     09 <iface> 19 <reg-be16> <CBOR unsigned>
 *
 * Byte one is the interface, 0x03 for the register reads a SmartSolar answers. Byte two of a
 * request, 0x81, is a CBOR array header whose low bits are a count: a read carries a *list* of
 * registers, and the vendor app batches two at a time under 0x82. This codec asks for one.
 *
 * A write is 0x06 over a pair of register and value, and this module cannot express one. That is
 * the entire safety story for the feature: 0x1030 is believed to be "clear history", it differs
 * from the totals register by a handful of bits and from a read by a single opcode byte, and the
 * data it would destroy is the data being rescued. There is no write encoder, the read request is
 * the only function here that produces bytes, and the register it accepts comes from a frozen list
 * of literals rather than an integer. Adding an encoder would remove all three guarantees at once.
 *
 * Every reply shape is fully determined, which is what lets the reassembler find PDU boundaries in
 * a stream with no length prefix and no delimiter: after the register comes exactly one CBOR item,
 * a byte string for a value report and an unsigned integer for everything else. The status code is
 * not optional — every captured 0x09 carries one.
 */

import { CBOR_ARRAY_OF_ONE, encodeCborRegisterId, readCborByteString, readCborUnsignedInteger } from './cbor'
import { TUNNEL_OPCODE_BYTES, describeOpcodeByte, tunnelOpcodeForByte } from './TunnelOpcode'
import type { SolarHistoryRegister } from '../SolarHistoryRegister'
import type { TunnelPdu } from './TunnelPdu'
import type { TunnelReading } from './TunnelReading'

/**
 * Byte one of a request. The SmartSolar's register reads run on 0x03, confirmed against the vendor
 * app's own traffic to this controller. Captured sessions against other Victron products carry 0x00
 * and 0x01, so replies report whichever byte they arrived with rather than being checked here.
 */
const TUNNEL_INTERFACE = 0x03

const OPCODE_OFFSET = 0
const INTERFACE_OFFSET = 1
const REGISTER_OFFSET = 2

/**
 * The bytes that ask the controller for one register.
 *
 * The register id goes out big-endian, inverted from VE.Direct over serial. That is not a choice:
 * it is CBOR's own integer encoding, and `encodeCborRegisterId` is the only place that decides it.
 */
export function encodeRegisterReadRequest(register: SolarHistoryRegister): Uint8Array {
  const registerId = encodeCborRegisterId(register)
  const request = new Uint8Array(REGISTER_OFFSET + 1 + registerId.length)

  request[OPCODE_OFFSET] = TUNNEL_OPCODE_BYTES.read
  request[INTERFACE_OFFSET] = TUNNEL_INTERFACE
  request[REGISTER_OFFSET] = CBOR_ARRAY_OF_ONE
  request.set(registerId, REGISTER_OFFSET + 1)

  return request
}

/**
 * Reads one reply starting at `offset`, reporting where the next one begins.
 *
 * Returns null when the buffer ends mid-PDU and throws when the bytes at `offset` cannot begin one.
 * Only the reassembler should need both: a caller holding a whole PDU wants `decodeTunnelReply`,
 * which turns either outcome into a throw.
 */
export function readTunnelPdu(notification: Uint8Array, offset: number): TunnelReading<TunnelPdu> | null {
  if (offset >= notification.length) return null

  const opcodeByte = notification[offset + OPCODE_OFFSET]
  const opcode = tunnelOpcodeForByte(opcodeByte)
  if (opcode === null) {
    throw new Error(`not a tunnel opcode: ${describeOpcodeByte(opcodeByte)}`)
  }
  if (opcode === 'read' || opcode === 'write') {
    throw new Error(`${opcode} is a host request and never arrives as a notification`)
  }

  if (offset + INTERFACE_OFFSET >= notification.length) return null
  const interfaceId = notification[offset + INTERFACE_OFFSET]

  const register = readCborUnsignedInteger(notification, offset + REGISTER_OFFSET)
  if (register === null) return null

  if (opcode === 'valueReport') {
    const payload = readCborByteString(notification, register.nextOffset)
    if (payload === null) return null
    return {
      decoded: { opcode, interfaceId, register: register.decoded, payload: payload.decoded },
      nextOffset: payload.nextOffset,
    }
  }

  const statusCode = readCborUnsignedInteger(notification, register.nextOffset)
  if (statusCode === null) return null
  return {
    decoded: { opcode, interfaceId, register: register.decoded, statusCode: statusCode.decoded },
    nextOffset: statusCode.nextOffset,
  }
}

/** One reply, whole. Throws if the bytes are short, malformed, or hold more than one PDU. */
export function decodeTunnelReply(reply: Uint8Array): TunnelPdu {
  const reading = readTunnelPdu(reply, 0)
  if (reading === null) {
    throw new Error(`tunnel reply is incomplete: ${reply.length} bytes`)
  }
  if (reading.nextOffset !== reply.length) {
    throw new Error(`tunnel reply has ${reply.length - reading.nextOffset} trailing bytes`)
  }
  return reading.decoded
}
