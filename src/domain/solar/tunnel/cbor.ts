/**
 * The slice of CBOR the 306b tunnel actually uses: unsigned integers, byte strings, and a
 * fixed-length array header.
 *
 * CBOR is not a Victron format, so nothing here may be reused for VE.Direct over serial or for the
 * Instant Readout advertisement. Both of those are little-endian all the way down. A CBOR head is
 * big-endian because RFC 8949 says so, and the two must never share a helper: the moment one
 * function serves both links, one of them is wrong and neither test can say which.
 *
 * Register ids, status codes and byte-string lengths are all read by the same routine,
 * `readCborArgument`, because in CBOR they are the same construct — the low five bits of a head
 * byte say how many argument bytes follow, whatever the major type is. That is deliberate. Reading
 * 0x58 as a value two bytes wide, which is what one public implementation does, is only possible if
 * lengths are looked up in a table of head bytes instead of being decoded; sharing the decoder makes
 * the mistake unavailable, and it also gets 0x50 right for free, which a mask of the low four bits
 * does not. The captured history replies open their payload with `58 22`, the long form declaring
 * 0x22 = 34 bytes, so this is the form every record on this boat arrives under.
 *
 * Readers return null when the buffer ends mid-item and throw when the bytes are not a form this
 * module understands. The caller needs both: the first means wait for the next notification, the
 * second means resynchronise.
 */

import type { TunnelReading } from './TunnelReading'

const MAJOR_TYPE_SHIFT = 5
const ADDITIONAL_INFO_MASK = 0x1f

const MAJOR_UNSIGNED_INTEGER = 0
const MAJOR_BYTE_STRING = 2

/** Additional info below this is the argument itself, with no following bytes. */
const ONE_BYTE_ARGUMENT = 24
const TWO_BYTE_ARGUMENT = 25

/** The head byte of a CBOR array of exactly one element. */
export const CBOR_ARRAY_OF_ONE = 0x81

/** `18 <reg8>`, the form the tunnel uses for a register below 0x100. */
const CBOR_ONE_BYTE_UNSIGNED = 0x18
/** `19 <reg-be16>`, the form the tunnel uses for every other register. */
const CBOR_TWO_BYTE_UNSIGNED = 0x19

/**
 * A ceiling on a byte string, so a corrupt length cannot make the reassembly buffer grow without
 * bound. It is not a CBOR limit and not a documented Victron one: a SmartSolar history record is 34
 * bytes and the largest value captured off any Victron product is a 52-byte record from a mains
 * charger, which leaves an order of magnitude of headroom.
 */
export const MAX_CBOR_BYTE_STRING_LENGTH = 512

const MAX_REGISTER_ID = 0xffff

function describeByte(head: number): string {
  return `0x${head.toString(16).padStart(2, '0')}`
}

function majorType(head: number): number {
  return head >> MAJOR_TYPE_SHIFT
}

/**
 * The argument of the CBOR item whose head byte sits at `offset`, and where the item's content
 * begins.
 *
 * Big-endian, and not because Victron chose it — RFC 8949 fixes network byte order for every
 * argument in the encoding. Written out by hand rather than through a DataView so the byte order is
 * visible at the point it matters instead of hiding in a boolean argument.
 */
function readCborArgument(bytes: Uint8Array, offset: number): TunnelReading<number> | null {
  const additionalInfo = bytes[offset] & ADDITIONAL_INFO_MASK

  if (additionalInfo < ONE_BYTE_ARGUMENT) {
    return { decoded: additionalInfo, nextOffset: offset + 1 }
  }
  if (additionalInfo === ONE_BYTE_ARGUMENT) {
    if (offset + 1 >= bytes.length) return null
    return { decoded: bytes[offset + 1], nextOffset: offset + 2 }
  }
  if (additionalInfo === TWO_BYTE_ARGUMENT) {
    if (offset + 2 >= bytes.length) return null
    return { decoded: (bytes[offset + 1] << 8) | bytes[offset + 2], nextOffset: offset + 3 }
  }

  // Four- and eight-byte arguments, the reserved values, and the indefinite-length form all land
  // here. Each is well-formed CBOR that the tunnel has never been observed using, and guessing a
  // width for one of them is how a reader walks off the end of a PDU.
  throw new Error(`unsupported CBOR head ${describeByte(bytes[offset])}: additional info ${additionalInfo}`)
}

/**
 * A register id as the tunnel writes it.
 *
 * Big-endian, which is inverted from VE.Direct over serial, where the same register id goes out low
 * byte first. The bytes inside the value the register returns stay little-endian. Nothing in the
 * encoding hints at that split, so it lives here, in the one function that produces register bytes
 * for this link.
 */
export function encodeCborRegisterId(register: number): Uint8Array {
  if (!Number.isInteger(register) || register < 0 || register > MAX_REGISTER_ID) {
    throw new Error(`not a register id: ${register}`)
  }
  if (register < 0x100) {
    return new Uint8Array([CBOR_ONE_BYTE_UNSIGNED, register])
  }
  return new Uint8Array([CBOR_TWO_BYTE_UNSIGNED, register >> 8, register & 0xff])
}

/**
 * Reads a register id or a status code — the tunnel spells both as a CBOR unsigned integer, and the
 * position in the PDU is what tells them apart.
 *
 * Accepts the immediate form a canonical encoder would use below 24, which `encodeCborRegisterId`
 * never emits for a register: the tunnel spells even small registers out as `18 <reg8>`, while a
 * status code of 1 does arrive as the single byte 0x01.
 */
export function readCborUnsignedInteger(bytes: Uint8Array, offset: number): TunnelReading<number> | null {
  if (offset >= bytes.length) return null

  const head = bytes[offset]
  if (majorType(head) !== MAJOR_UNSIGNED_INTEGER) {
    throw new Error(`not a CBOR unsigned integer: head ${describeByte(head)}`)
  }
  return readCborArgument(bytes, offset)
}

/** True when this byte opens a CBOR byte string, which is how a register value is carried. */
function isCborByteStringHead(head: number): boolean {
  return majorType(head) === MAJOR_BYTE_STRING
}

export function readCborByteString(bytes: Uint8Array, offset: number): TunnelReading<Uint8Array> | null {
  if (offset >= bytes.length) return null

  const head = bytes[offset]
  if (!isCborByteStringHead(head)) {
    throw new Error(`register value is not a CBOR byte string: head ${describeByte(head)}`)
  }

  const length = readCborArgument(bytes, offset)
  if (length === null) return null
  if (length.decoded > MAX_CBOR_BYTE_STRING_LENGTH) {
    throw new Error(`CBOR byte string of ${length.decoded} bytes exceeds the tunnel's ceiling`)
  }

  const end = length.nextOffset + length.decoded
  if (end > bytes.length) return null
  return { decoded: bytes.slice(length.nextOffset, end), nextOffset: end }
}
