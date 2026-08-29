/**
 * Whether this page is in front of the owner right now, as a port rather than two reads of
 * `document`.
 *
 * Both halves are load-bearing and neither is fussiness. Chromium tears down every advertisement
 * watch when the tab is hidden AND when the window merely loses focus, and it fires nothing at all
 * when it does — `watchingAdvertisements` keeps reading true over a watch that is already dead. So
 * anything armed behind another window that waits to hear a device is waiting on nothing, and the
 * two states have to be watched rather than assumed. A GATT connection is untouched by either, which
 * is what leaves the pack's supervisor something worth doing while the page is away.
 *
 * They are reported apart because they are answered apart: visibility is the tab, focus is the
 * window, and a window that is showing on a second monitor while the owner types elsewhere is
 * visible and unfocused at once.
 */

export interface PageActivity {
  /** Whether the tab is showing. */
  visible(): boolean
  /** Whether the window holds focus. */
  focused(): boolean
  /** Reports every change to either, until the returned unsubscribe is called. */
  subscribe(onChange: () => void): () => void
}

/**
 * This browser's own answer. A page with no document at all — a spec running outside jsdom, where
 * there is no radio to rejoin over either — is reported as in front, because nothing is in front
 * of it and the alternative is inventing a hidden window nobody is looking at.
 */
export function browserPageActivity(): PageActivity {
  return {
    visible(): boolean {
      if (typeof document === 'undefined') return true
      return document.visibilityState === 'visible'
    },
    focused(): boolean {
      if (typeof document === 'undefined' || typeof document.hasFocus !== 'function') return true
      return document.hasFocus()
    },
    subscribe(onChange: () => void): () => void {
      if (typeof document === 'undefined' || typeof window === 'undefined') return () => undefined
      const report = (): void => onChange()
      document.addEventListener('visibilitychange', report)
      window.addEventListener('focus', report)
      window.addEventListener('blur', report)
      return () => {
        document.removeEventListener('visibilitychange', report)
        window.removeEventListener('focus', report)
        window.removeEventListener('blur', report)
      }
    },
  }
}
