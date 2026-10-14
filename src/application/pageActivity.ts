/** Chromium can silently stop advertisement watches when visibility or focus is lost. */
export interface PageActivity {
  visible(): boolean
  focused(): boolean
  /** Reports activity changes and restore signals, even when visibility and focus are unchanged. */
  subscribe(onChange: () => void): () => void
}

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
      document.addEventListener('resume', report)
      window.addEventListener('focus', report)
      window.addEventListener('blur', report)
      window.addEventListener('pageshow', report)
      return () => {
        document.removeEventListener('visibilitychange', report)
        document.removeEventListener('resume', report)
        window.removeEventListener('focus', report)
        window.removeEventListener('blur', report)
        window.removeEventListener('pageshow', report)
      }
    },
  }
}
