/** A register and the bytes it holds. */
export interface TunnelValueReport {
  readonly opcode: 'valueReport'
  /**
   * Byte one, which the controller echoes from the request. Reported rather than asserted: the
   * SmartSolar's register reads run on 0x03, and captured sessions against other Victron products
   * carry 0x00 and 0x01, so a decoder that insisted on one of them would drop most of the traffic
   * from some devices.
   */
  readonly interfaceId: number
  readonly register: number
  /** The register's own bytes, little-endian inside, at whatever width the register has. */
  readonly payload: Uint8Array
}
