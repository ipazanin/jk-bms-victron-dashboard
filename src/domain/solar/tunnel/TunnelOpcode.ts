/**
 * What a PDU on the SmartSolar's 306b GATT tunnel is for.
 *
 * Named rather than numbered, because the byte alone cannot say which direction a PDU may
 * travel: 0x05 and 0x06 only ever go host to device, and 0x07 through 0x09 only ever arrive
 * as notifications. Every decision in the codec turns on that distinction, so it belongs in
 * the type rather than in a comparison against a literal.
 */
export type TunnelOpcode = 'read' | 'write' | 'error' | 'valueReport' | 'registerUnsupported'

export const TUNNEL_OPCODES: readonly TunnelOpcode[] = [
  'read',
  'write',
  'error',
  'valueReport',
  'registerUnsupported',
]

export const TUNNEL_OPCODE_BYTES: Readonly<Record<TunnelOpcode, number>> = {
  read: 0x05,
  write: 0x06,
  error: 0x07,
  valueReport: 0x08,
  registerUnsupported: 0x09,
}

const OPCODES_BY_BYTE: ReadonlyMap<number, TunnelOpcode> = new Map(
  TUNNEL_OPCODES.map((opcode): [number, TunnelOpcode] => [TUNNEL_OPCODE_BYTES[opcode], opcode]),
)

export function tunnelOpcodeForByte(opcodeByte: number): TunnelOpcode | null {
  return OPCODES_BY_BYTE.get(opcodeByte) ?? null
}

export function describeOpcodeByte(opcodeByte: number): string {
  return `0x${opcodeByte.toString(16).padStart(2, '0')}`
}
