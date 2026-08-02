/**
 * A register the controller answered for without a value.
 *
 * Carried, not interpreted — this is a finding about the exchange rather than a malformed frame, so
 * it is a value the caller can act on and never a throw. Nothing published names the codes.
 * Captures show 0x01 where the hardware has no such thing (a charger asked for its relay), and 0x02
 * where a history record does not exist, which is one way a controller says how far back its stored
 * days go. One 0x07 arrives during every session open, before any register has been asked for, and
 * the vendor app carries on regardless.
 */
export interface TunnelStatusReply {
  readonly opcode: 'error' | 'registerUnsupported'
  /** Byte one, echoed from the request. See `TunnelValueReport` for why it is not asserted. */
  readonly interfaceId: number
  readonly register: number
  readonly statusCode: number
}
