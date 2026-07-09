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
