/**
 * The one line of communication between two tabs of this page.
 *
 * Nothing is sent but a word saying what changed: the archive is the shared state, and a receiver
 * re-reads what it needs from it. A payload would be a second copy of the truth, and the two would
 * disagree the first time a tab was slow.
 *
 * BroadcastChannel does not deliver a message back to the object that posted it, so a store can
 * both post and subscribe on one channel without hearing its own echo. Absent — some in-app
 * browsers, older WebKit — every call is a no-op and the page behaves like the single tab it is.
 */

const CHANNEL_NAME = 'shunt.log'

export type ArchiveMessage = 'session-opened' | 'session-closed' | 'pruned' | 'device-renamed'

export interface ArchiveChannel {
  post(message: ArchiveMessage): void
  /** Returns an unsubscribe, like `watchAdapter`. */
  subscribe(onMessage: (message: ArchiveMessage) => void): () => void
  /**
   * Under Node — which is what the specs run on — an open BroadcastChannel keeps the event loop
   * alive, so a store that is never closed hangs the run rather than failing it.
   */
  close(): void
}

export function openArchiveChannel(): ArchiveChannel {
  if (typeof BroadcastChannel !== 'function') return silentChannel()

  let channel: BroadcastChannel | null = new BroadcastChannel(CHANNEL_NAME)

  return {
    post(message) {
      // A post after close is not worth an exception: the tab is on its way out and the archive
      // it would have announced is already written.
      try {
        channel?.postMessage(message)
      } catch {
        // The channel died with its document.
      }
    },
    subscribe(onMessage) {
      const listener = (event: MessageEvent): void => {
        if (isArchiveMessage(event.data)) onMessage(event.data)
      }
      channel?.addEventListener('message', listener)
      return () => channel?.removeEventListener('message', listener)
    },
    close() {
      channel?.close()
      channel = null
    },
  }
}

function silentChannel(): ArchiveChannel {
  return {
    post: () => undefined,
    subscribe: () => () => undefined,
    close: () => undefined,
  }
}

/** Another origin-sharing page could post anything; only the four words this one knows are acted on. */
function isArchiveMessage(value: unknown): value is ArchiveMessage {
  return (
    value === 'session-opened' ||
    value === 'session-closed' ||
    value === 'pruned' ||
    value === 'device-renamed'
  )
}
