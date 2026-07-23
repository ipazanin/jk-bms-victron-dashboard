/**
 * Which plane the instrument is read on, and where that choice is kept.
 *
 * Dark is the designed default rather than a fallback, so it is what an unanswered question
 * resolves to. Three sources can answer it, in this order:
 *
 *   1. `?theme` in the URL, which forces a plane for one visit without recording a preference —
 *      it exists so a screenshot or a link can pin the rendering, not so it can change settings
 *      behind the owner's back.
 *   2. A choice the owner made with the toggle, in this browser's localStorage and nowhere else.
 *   3. The system preference, followed live until they make a choice of their own.
 *
 * The distinction between 2 and 3 is why the stored value is nullable rather than defaulted:
 * "never chose" and "chose dark" behave differently when the machine switches to light at dusk.
 */

export type Theme = 'dark' | 'light'

const THEME_STORAGE = 'shunt.theme'

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light'
}

/** Null when the owner has never chosen, which is not the same as having chosen dark. */
export function loadThemeChoice(): Theme | null {
  let stored: string | null
  try {
    stored = localStorage.getItem(THEME_STORAGE)
  } catch {
    return null
  }
  // A hand-edited or half-written entry is treated as no answer rather than as an error.
  return isTheme(stored) ? stored : null
}

export function saveThemeChoice(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE, theme)
  } catch {
    // Private browsing denies storage; the choice simply will not outlive the tab.
  }
}

export function forgetThemeChoice(): void {
  try {
    localStorage.removeItem(THEME_STORAGE)
  } catch {
    // Nothing to clear.
  }
}

/** Reads `?theme=light` / `?theme=dark`. Anything else is not an instruction. */
export function themeFromQuery(search: string): Theme | null {
  const requested = new URLSearchParams(search).get('theme')
  return isTheme(requested) ? requested : null
}

/** Pure, so the precedence can be tested without a document, a URL or a matchMedia. */
export function resolveTheme(
  forced: Theme | null,
  chosen: Theme | null,
  prefersLight: boolean,
): Theme {
  return forced ?? chosen ?? (prefersLight ? 'light' : 'dark')
}

export function prefersLight(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches
}

export function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme
}

/**
 * Resolves and applies the theme before the app mounts.
 *
 * The stylesheet's own `:root` is the dark plane, so a page opened by someone who chose light
 * would otherwise paint dark and correct itself a frame later. Calling this from the entry module
 * rather than from a mounted component is what keeps that flash off the screen: nothing paintable
 * exists until Vue mounts, so the attribute is already on `<html>` by the time anything is drawn.
 */
export function applyInitialTheme(): Theme {
  const theme = resolveTheme(
    themeFromQuery(typeof window === 'undefined' ? '' : window.location.search),
    loadThemeChoice(),
    prefersLight(),
  )
  applyTheme(theme)
  return theme
}
