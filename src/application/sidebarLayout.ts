/**
 * Whether the desktop rail is collapsed to icons, and where that choice is kept.
 *
 * Expanded is the designed default, so an unanswered question resolves to it — the same
 * "a bad value is no answer" rule the theme choice follows. Only the desktop rail honours this;
 * the mobile drawer is driven by transient open/closed state that is never persisted.
 */

const SIDEBAR_STORAGE = 'shunt.sidebar'

/** Missing or hand-edited resolves to expanded — the same "bad value = no answer" rule as theme. */
export function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE) === 'collapsed'
  } catch {
    return false
  }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_STORAGE, collapsed ? 'collapsed' : 'expanded')
  } catch {
    // Private browsing denies storage; the preference simply will not outlive the tab.
  }
}
