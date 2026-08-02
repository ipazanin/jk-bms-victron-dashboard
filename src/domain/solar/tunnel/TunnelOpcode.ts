/**
 * What a PDU on the SmartSolar's 306b GATT tunnel is for.
 *
 * Named rather than numbered, because the byte alone cannot say which direction a PDU may travel:
 * 0x05 and 0x06 only ever go host to device, and 0x07 through 0x09 only ever arrive as
 * notifications. Every decision in the codec turns on that distinction, so it belongs in the type
 * rather than in a comparison against a literal.
 *
 * `write` is named here so the decoder can refuse one that arrives in the notification stream. It
 * is a name, not an encoder, and nothing in this package produces a 0x06 frame — see `pdu.ts`.
 */
export type TunnelOpcode = 'read' | 'write' | 'error' | 'valueReport' | 'registerUnsupported'

/**
 * The whole opcode space, and the only place it is written down. A `Record` keyed by the union is
 * exhaustiveness-checked, so a name added to `TunnelOpcode` without a byte here fails to compile —
 * which a parallel list of the same names could not catch. An opcode missing its byte would make a
 * valid PDU undecodable, and the reassembler would then resynchronise straight past it.
 *
 * Frozen, not merely `Readonly`. The single encoder writes `read` into byte 0 of every request it
 * builds, so this table is the one place where assigning `0x06` to `read` would turn the whole
 * sweep into writes against the history block. `Readonly` stops that at the type checker and
 * nowhere else; freezing makes it a property of the object.
 */
export const TUNNEL_OPCODE_BYTES: Readonly<Record<TunnelOpcode, number>> = Object.freeze({
  read: 0x05,
  write: 0x06,
  error: 0x07,
  valueReport: 0x08,
  registerUnsupported: 0x09,
})

const OPCODES_BY_BYTE: ReadonlyMap<number, TunnelOpcode> = new Map(
  Object.entries(TUNNEL_OPCODE_BYTES).map(([opcode, opcodeByte]): [number, TunnelOpcode] => [
    opcodeByte,
    opcode as TunnelOpcode,
  ]),
)

export function tunnelOpcodeForByte(opcodeByte: number): TunnelOpcode | null {
  return OPCODES_BY_BYTE.get(opcodeByte) ?? null
}

export function describeOpcodeByte(opcodeByte: number): string {
  return `0x${opcodeByte.toString(16).padStart(2, '0')}`
}
