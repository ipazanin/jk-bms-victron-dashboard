/**
 * A decrypt the spec settles by hand.
 *
 * `crypto.subtle.decrypt` is the only genuinely asynchronous hop in the solar decode path.
 * Everything downstream of it — `decryptRecord`'s await, `decodeSolarAdvertisement`'s await, the
 * processor's `.then` — is a microtask, so once the decrypt has settled a single macrotask
 * boundary drains the decode to completion. That is what lets a spec assert what did *not* happen
 * after `stop()` without guessing how many turns of the event loop the real WebCrypto needs.
 *
 * The spy is a plain `vi.spyOn`, so the caller restores it the usual way.
 */

import { vi } from 'vitest'
import type { MockInstance } from 'vitest'

export interface HeldDecrypt {
  /**
   * The `crypto.subtle.decrypt` spy. A spec asserting that nothing was reported must also assert
   * this was called, or a decode that bailed out before the decrypt — a record type the payload no
   * longer carries, a key check that no longer matches — would satisfy it for the wrong reason.
   */
  readonly spy: MockInstance<SubtleCrypto['decrypt']>
  /** Settle the held decrypt with the plaintext, then let the rest of the decode run out. */
  complete(): Promise<void>
}

export function holdDecrypt(plaintext: ArrayBuffer): HeldDecrypt {
  let release: (decrypted: ArrayBuffer) => void = () => undefined
  const held = new Promise<ArrayBuffer>((resolve) => {
    release = resolve
  })
  const spy = vi.spyOn(crypto.subtle, 'decrypt').mockReturnValue(held)

  return {
    spy,
    async complete(): Promise<void> {
      release(plaintext)
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}
