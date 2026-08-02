/**
 * One record's 24 bytes together with the ring position the frame carried it at.
 *
 * The transport hands these over beside its decoded records so the archive can store what the pack
 * sent rather than what this build made of it. The index orders a burst and splits it into runs; it
 * is never an identity, because the ring shifts under it between reads.
 */
export interface RingRecordBytes {
  readonly index: number
  readonly bytes: Uint8Array
}
