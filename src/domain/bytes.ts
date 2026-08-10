/**
 * A `Uint8Array` may be backed by a `SharedArrayBuffer`, which the DOM's `BufferSource`
 * rejects. Copying into a fresh `ArrayBuffer` satisfies the Web Bluetooth and WebCrypto
 * signatures without an unsound cast, and also detaches the bytes from any view the
 * caller might reuse.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

/**
 * Hex text to the bytes it names, with no check that it is hex.
 *
 * Nothing here rejects, and what a typo costs depends on which kind it is. A mistyped digit stays
 * where it was written: `aabzccdd` decodes to `aa 0b cc dd`, one wrong byte at the right offset. A
 * character dropped or added re-pairs every byte behind it — `aabccdd` decodes to `aa bc cd` — and
 * an odd trailing character is dropped. Either way the bytes read back as a plausible frame rather
 * than as an error, which suits checked-in capture text, where a bad frame is better caught by the
 * decoder it feeds than by a guard in front of it. Hex off a wire gets no second look and wants a
 * parser that refuses, which is why `BridgeSolarScan` carries its own.
 */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}
