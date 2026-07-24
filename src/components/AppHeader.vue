<script setup lang="ts">
import { computed } from 'vue'

import { useIsDesktop } from '../application/breakpoints'
import { hashOf } from '../application/route'
import type { FaultLevel, Source } from '../application/telemetry'
import type { Theme } from '../application/theme'

/**
 * What the header has to say about the boat, read off telemetry by whoever owns it. The header
 * never reaches into telemetry itself — it draws the two fields any caller could assemble, so a
 * spec can hand it a fixture without a live radio behind it.
 */
export interface HeaderStatus {
  readonly source: Source
  readonly worst: FaultLevel
}

const props = defineProps<{
  theme: Theme
  /** Desktop rail state: expanded (false) or icon-only (true). Ignored under the breakpoint. */
  collapsed: boolean
  /** Off-canvas drawer state under the breakpoint. Ignored at desktop width. */
  mobileOpen: boolean
  status: HeaderStatus
}>()

const emit = defineEmits<{ toggleTheme: []; toggleSidebar: [] }>()

const isDesktop = useIsDesktop()

/**
 * The one sidebar-toggle button means different things by width, so its icon and its ARIA state
 * have to say which. On desktop it collapses a rail that stays on screen — a pressed toggle, not a
 * hidden region; under the breakpoint it shows and hides an off-canvas drawer, a true expandable.
 * Only the drawer morphs the hamburger into a close X.
 */
const drawerOpen = computed(() => !isDesktop.value && props.mobileOpen)
const sidebarButtonLabel = computed(() =>
  isDesktop.value
    ? props.collapsed
      ? 'Expand sidebar'
      : 'Collapse sidebar'
    : props.mobileOpen
      ? 'Hide navigation'
      : 'Show navigation',
)

const STATUS_COLOR: Record<FaultLevel, string> = {
  good: 'var(--status-good)',
  warning: 'var(--status-warning)',
  serious: 'var(--status-serious)',
  critical: 'var(--status-critical)',
}

const dotColor = computed(() => STATUS_COLOR[props.status.worst])

function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * One line, never a ticking clock: a per-second relative age would churn the text width on every
 * tick and undermine the steadiness the dashboard promises elsewhere. It says what the numbers
 * are (source) and, only while live, whether anything stands against them (worst).
 */
const contextText = computed(() => {
  const status = props.status
  if (status.source === 'live') {
    return status.worst === 'good' ? 'Live' : `Live · ${capitalized(status.worst)}`
  }
  if (status.source === 'remembered') return 'Remembered'
  if (status.source === 'history') return 'Reviewing saved session'
  return 'JK-BMS · Victron SmartSolar'
})
</script>

<template>
  <header class="app-header" data-testid="app-header">
    <div class="lead">
      <!-- Left, on the same side the rail collapses and the drawer slides from — not stranded on
           the far right controlling a panel that lives on the left. -->
      <button
        id="sidebar-toggle"
        type="button"
        class="icon-btn menu"
        :class="{ 'is-open': drawerOpen }"
        :aria-expanded="isDesktop ? undefined : mobileOpen"
        :aria-pressed="isDesktop ? collapsed : undefined"
        aria-controls="app-sidebar"
        :aria-label="sidebarButtonLabel"
        @click="emit('toggleSidebar')"
      >
        <svg
          class="glyph"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path class="bar bar-top" d="M3 6h18" />
          <path class="bar bar-mid" d="M3 12h18" />
          <path class="bar bar-bottom" d="M3 18h18" />
        </svg>
      </button>
      <a class="wordmark" :href="hashOf({ name: 'dashboard' })">Shunt</a>
      <p class="context" :class="`is-${status.source}`">
        <span
          v-if="status.source === 'live'"
          class="dot"
          :style="{ background: dotColor }"
          aria-hidden="true"
        ></span>
        <span class="context-text">{{ contextText }}</span>
      </p>
    </div>

    <div class="controls">
      <button
        type="button"
        class="icon-btn theme"
        :aria-label="`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`"
        @click="emit('toggleTheme')"
      >
        <svg
          v-if="theme === 'dark'"
          class="glyph"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
          />
        </svg>
        <svg
          v-else
          class="glyph"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  position: sticky;
  top: 0;
  z-index: 50;
  height: var(--header-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-inline: clamp(1rem, 3.5vw, 2.5rem);
  background: var(--header-bg);
  backdrop-filter: blur(var(--header-blur));
  -webkit-backdrop-filter: blur(var(--header-blur));
  border-bottom: 1px solid var(--header-border);
}

.lead {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.wordmark {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  font-family: var(--font-label);
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink);
  text-decoration: none;
  flex-shrink: 0;
}

.context {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  /* --ink-secondary, not --ink-muted: this line sits on translucent glass, and workspace content
     scrolling beneath the header must not drop it below AA where the two colours mix. */
  color: var(--ink-secondary);
}

/* The text, not its flex container, carries the truncation: text-overflow only ever acts on the
   element whose own inline content overflows, never on an overflowing flex child. */
.context-text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: var(--r-pill);
}

.controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

.icon-btn {
  width: var(--tap);
  height: var(--tap);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  color: var(--ink-secondary);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.icon-btn:hover {
  background: var(--raised);
  color: var(--ink);
}

.glyph {
  width: 20px;
  height: 20px;
}

/* Hamburger morphs to an X: the top and bottom bars rotate into the middle bar's line,
   the middle bar fades out. Collapses under the global prefers-reduced-motion rule. */
.menu .bar {
  transition:
    transform var(--dur-fast) var(--ease),
    opacity var(--dur-fast) var(--ease);
  transform-origin: center;
}

.menu.is-open .bar-top {
  transform: translateY(6px) rotate(45deg);
}

.menu.is-open .bar-mid {
  opacity: 0;
}

.menu.is-open .bar-bottom {
  transform: translateY(-6px) rotate(-45deg);
}

@media (max-width: 420px) {
  .context {
    display: none;
  }
}
</style>
