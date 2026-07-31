/** A register and the bytes it holds. */
export interface TunnelValueReport {
  readonly opcode: 'valueReport'
  /**
   * Byte one, which the controller echoes from the request. Reported rather than asserted:
   * captures show 0x00, 0x01 and 0x03 in the same app session, and a decoder that insisted
   * on one of them would drop most of the traffic from some devices.
   */
  readonly interfaceId: number
  readonly register: number
  /** The register's own bytes, little-endian inside, at whatever width the register has. */
  readonly payload: Uint8Array
}
