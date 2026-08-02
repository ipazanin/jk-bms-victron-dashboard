/**
 * One byte stream out of two notification characteristics.
 *
 * The 306b tunnel notifies on both 306b0003, the command characteristic, and 306b0004, the bulk
 * one. They are not two conversations: fragments interleave between them, and a single PDU splits
 * across the pair mid-message. The only thing that reassembles is the concatenation of both in
 * arrival order, which is why `feed` takes bytes and not a characteristic — there is nothing
 * correct to do with the knowledge of which one a chunk came from.
 *
 * That also rules out the approach the public threads reached for first, which is to scan the
 * buffer for the `08 03 19` prefix and cut there. A register value is arbitrary bytes and can
 * contain that sequence; only the CBOR lengths say where a PDU ends. Reading the lengths is also
 * the only way to know a PDU is *finished* rather than merely unfinished, which is what the
 * split-across-characteristics case turns on.
 *
 * A notification is not a PDU either. One can hold several, or a fraction of one, or the tail of
 * the last plus the head of the next.
 *
 * Modelled on `FrameAssembler` for the JK-BMS, which solves the same problem for a fixed frame
 * length, with one difference that matters: there is no checksum here. A JK frame that survives its
 * checksum is almost certainly intact; a tunnel PDU has nothing to verify against, so a dropped
 * notification silently corrupts the PDU spanning it, and the stream recovers only when some later
 * byte fails to parse. Resynchronising one byte at a time, rather than discarding the buffer, is
 * what keeps that damage to the PDUs it touched.
 */

import { MAX_CBOR_BYTE_STRING_LENGTH } from './cbor'
import { readTunnelPdu } from './pdu'
import type { TunnelPdu } from './TunnelPdu'
import type { TunnelReading } from './TunnelReading'

/** Opcode, interface, the longest register head, the longest byte-string head, the value. */
export const MAX_PDU_LENGTH = 1 + 1 + 3 + 3 + MAX_CBOR_BYTE_STRING_LENGTH

export class TunnelReassembler {
  private buffer = new Uint8Array(0)

  /**
   * Bytes held back awaiting the rest of a PDU.
   *
   * Bounded under MAX_PDU_LENGTH plus one notification: bytes are only held when a PDU head has
   * been read and its declared length has not arrived, and `readCborByteString` refuses a length
   * beyond the ceiling rather than reserving room for it.
   */
  get bufferedBytes(): number {
    return this.buffer.length
  }

  /** Every complete PDU the stream now holds, in order. */
  feed(notification: Uint8Array): TunnelPdu[] {
    const merged = new Uint8Array(this.buffer.length + notification.length)
    merged.set(this.buffer, 0)
    merged.set(notification, this.buffer.length)
    this.buffer = merged

    const pdus: TunnelPdu[] = []
    let scanFrom = 0

    for (;;) {
      if (scanFrom >= this.buffer.length) {
        this.buffer = new Uint8Array(0)
        return pdus
      }

      let reading: TunnelReading<TunnelPdu> | null
      try {
        reading = readTunnelPdu(this.buffer, scanFrom)
      } catch {
        // These bytes cannot begin a PDU, so the stream is misaligned. Skipping the whole head
        // would swallow the start of the next one, which is what a resynchronise is trying to find.
        scanFrom += 1
        continue
      }

      if (reading === null) {
        // A PDU that has begun but not arrived. Keeping it from its own first byte is what bounds
        // the buffer: whatever is held is shorter than the one PDU it belongs to.
        this.buffer = this.buffer.slice(scanFrom)
        return pdus
      }

      pdus.push(reading.decoded)
      scanFrom = reading.nextOffset
    }
  }

  reset(): void {
    this.buffer = new Uint8Array(0)
  }
}
