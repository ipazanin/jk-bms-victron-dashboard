import type { ReconnectRefusal } from './ReconnectRefusal'

/**
 * A reconnect refused before the radio was ever asked, carrying which permission answer it was.
 *
 * Whoever retries branches on `refusal` rather than on the message: a refusal is the one reconnect
 * failure that repeating cannot fix, so it has to be told apart from an out-of-range pack
 * programmatically, not by reading English.
 */
export class ReconnectRefusedError extends Error {
  readonly refusal: ReconnectRefusal

  constructor(refusal: ReconnectRefusal, message: string) {
    super(message)
    this.name = 'ReconnectRefusedError'
    this.refusal = refusal
  }
}
