import type { TunnelStatusReply } from './TunnelStatusReply'
import type { TunnelValueReport } from './TunnelValueReport'

/**
 * One decoded protocol data unit off the SmartSolar's 306b GATT tunnel.
 *
 * The two shapes are not one shape with an optional value. A register that answered with bytes and
 * a register that answered with a status code are different answers, and the codec has to tell them
 * apart anyway to know where the PDU ends.
 */
export type TunnelPdu = TunnelValueReport | TunnelStatusReply
