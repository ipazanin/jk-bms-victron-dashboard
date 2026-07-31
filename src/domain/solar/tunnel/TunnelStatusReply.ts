/**
 * A register the controller answered for without a value.
 *
 * Carried, not interpreted. Nothing published names the codes; captures show 0x01 where the
 * hardware has no such thing — a charger asked for its relay, a 15 A solar charger asked for
 * panel current — and 0x02 where a history record does not exist, which is how a controller
 * says how far back its stored days go without being asked.
 */
export interface TunnelStatusReply {
  readonly opcode: 'error' | 'registerUnsupported'
  /** Byte one, echoed from the request. See `TunnelValueReport` for why it is not asserted. */
  readonly interfaceId: number
  readonly register: number
  readonly statusCode: number
}
