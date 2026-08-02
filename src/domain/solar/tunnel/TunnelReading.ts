/**
 * Something read out of a byte stream, and the offset the next read starts at.
 *
 * The offset is the whole point. One notification can hold several PDUs back to back, and nothing
 * in the framing marks where one ends — only the CBOR lengths inside it do. A reader that returned
 * just the decoded thing would leave the caller to recompute a width it had already worked out,
 * which is exactly how a stream of PDUs gets misaligned.
 */
export interface TunnelReading<TDecoded> {
  readonly decoded: TDecoded
  readonly nextOffset: number
}
