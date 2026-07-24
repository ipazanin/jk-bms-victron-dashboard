<script setup lang="ts">
import { computed } from 'vue'

import { useIsMobile } from '../application/breakpoints'
import { hashOf, route } from '../application/route'

const props = defineProps<{
  collapsed: boolean
  mobileOpen: boolean
  sessionCount: number
}>()

const emit = defineEmits<{ close: [] }>()

/**
 * Off-canvas and shut: the closed drawer is taken out of the tab order and the a11y tree. The
 * sidebar owns this rather than the parent because it renders two roots (scrim + aside), and a
 * fragment-root component cannot inherit inert/aria-hidden passed down — the attributes would be
 * dropped onto nothing.
 */
const isMobile = useIsMobile()
const hiddenOffCanvas = computed(() => isMobile.value && !props.mobileOpen)

/** Log stays lit for a single session and for the warnings sub-view, both reached through it. */
const active = computed(() =>
  route.value.name === 'session' || route.value.name === 'warnings' ? 'log' : route.value.name,
)

const links = [
  { name: 'dashboard' as const, href: hashOf({ name: 'dashboard' }), label: 'Bus', icon: 'bus' },
  { name: 'connect' as const, href: hashOf({ name: 'connect' }), label: 'Connect', icon: 'connect' },
  { name: 'stats' as const, href: hashOf({ name: 'stats' }), label: 'Stats', icon: 'stats' },
  { name: 'log' as const, href: hashOf({ name: 'log' }), label: 'Log', icon: 'log' },
]
</script>

<template>
  <!-- Scrim: mobile + open only. display:none otherwise so it neither intercepts clicks
       nor counts toward horizontal overflow. -->
  <div
    class="scrim"
    :class="{ show: mobileOpen }"
    data-testid="sidebar-scrim"
    aria-hidden="true"
    @click="emit('close')"
  ></div>

  <aside
    id="app-sidebar"
    class="sidebar"
    data-testid="app-sidebar"
    :class="{ 'is-collapsed': collapsed, 'is-open': mobileOpen }"
    :inert="hiddenOffCanvas || undefined"
    :aria-hidden="hiddenOffCanvas ? 'true' : undefined"
  >
    <!-- Close lives on the drawer, so the panel carries its own dismissal rather than reaching back
         to a control in the header. Shown only in the mobile drawer; the desktop rail has no X. -->
    <button
      type="button"
      class="drawer-close"
      aria-label="Close navigation"
      data-testid="drawer-close"
      @click="emit('close')"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>

    <a class="brand" :href="hashOf({ name: 'dashboard' })">
      <span class="mark" aria-hidden="true">S</span>
      <span class="brand-text">
        <span class="wordmark">Shunt</span>
        <span class="tagline">JK-BMS · Victron SmartSolar</span>
      </span>
    </a>

    <nav class="nav" data-testid="sidebar-nav" aria-label="Sections">
      <a
        v-for="link in links"
        :key="link.name"
        :href="link.href"
        class="tab"
        :title="link.label"
        :aria-current="active === link.name ? 'page' : undefined"
        @click="emit('close')"
      >
        <span class="tab-icon" aria-hidden="true">
          <svg
            v-if="link.icon === 'bus'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M4.5 15a8 8 0 1 1 15 0" />
            <circle cx="12" cy="15" r="1.6" />
            <path d="M12 13.4 15 9" />
          </svg>
          <svg
            v-else-if="link.icon === 'connect'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M7 7l10 10-5 4V3l5 4L7 17" />
          </svg>
          <svg
            v-else-if="link.icon === 'stats'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M4 20V10M10 20V4M16 20v-6M22 20H2" />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
          </svg>
        </span>
        <span class="tab-label">{{ link.label }}</span>
        <span v-if="link.name === 'log' && sessionCount > 0" class="count">{{ sessionCount }}</span>
      </a>
    </nav>
  </aside>
</template>

<style scoped>
/* Local shell widths — not tokenized, this rail is their only consumer. */
.sidebar {
  --rail-w: clamp(13rem, 4vw + 11rem, 16rem);
  --rail-w-collapsed: 4.5rem;
}

/* --- Desktop expanded rail (base) ------------------------------------------------ */

.sidebar {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  width: var(--rail-w);
  padding: 1.5rem 1rem;
  /* One elevation step off the workspace plane, so the rail reads as its own region. */
  background: var(--surface);
  border-right: 1px solid var(--card-border);
  transition: width var(--dur) var(--ease);
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-height: var(--tap);
  padding: 0 0.5rem;
  text-decoration: none;
  color: var(--ink);
}

/* The rail never needs a close; only the mobile drawer reveals this (below). */
.drawer-close {
  display: none;
}

.mark {
  display: none;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: var(--r-md);
  background: var(--pack-ink);
  color: var(--on-pack);
  font-family: var(--font-label);
  font-weight: 600;
  font-size: 1.15rem;
  letter-spacing: 0;
}

.brand-text {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.wordmark {
  font-family: var(--font-label);
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.tagline {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--ink-muted);
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: var(--tap);
  padding: 0 0.75rem;
  border-radius: var(--r-sm);
  border-left: 2px solid transparent;
  color: var(--ink-secondary);
  text-decoration: none;
  font-family: var(--font-label);
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.tab:hover {
  background: var(--raised);
  color: var(--ink);
}

.tab[aria-current='page'] {
  background: var(--raised);
  border-left-color: var(--pack-ink);
  color: var(--ink);
}

.tab-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
}

.tab-icon svg {
  width: 100%;
  height: 100%;
}

.tab-label {
  flex: 1;
  min-width: 0;
}

.count {
  flex: none;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1;
  color: var(--ink-secondary);
  background: var(--raised);
  border: 1px solid var(--card-border);
  border-radius: var(--r-pill);
  padding: 0.15rem 0.4rem;
  min-width: 1.25rem;
  text-align: center;
}

.tab[aria-current='page'] .count {
  color: var(--ink);
}

/* --- Desktop collapsed rail — icons only, labels kept in the a11y tree ----------- */

@media (min-width: 861px) {
  .sidebar.is-collapsed {
    width: var(--rail-w-collapsed);
    padding-inline: 0;
  }

  .sidebar.is-collapsed .brand {
    justify-content: center;
    gap: 0;
    padding-inline: 0;
  }

  .sidebar.is-collapsed .mark {
    display: inline-flex;
  }

  /* Clipped, not removed: the brand link keeps "Shunt" as its accessible name. */
  .sidebar.is-collapsed .wordmark {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .sidebar.is-collapsed .tagline {
    display: none;
  }

  .sidebar.is-collapsed .tab {
    justify-content: center;
    gap: 0;
    padding-inline: 0;
  }

  /* Kept for screen readers; the :title gives the sighted a hover label. */
  .sidebar.is-collapsed .tab-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* The count collapses to a dot pinned to the icon's top-right corner. */
  .sidebar.is-collapsed .count {
    position: absolute;
    top: calc(50% - 10px);
    left: calc(50% + 10px);
    transform: translate(-50%, -50%);
    width: 9px;
    height: 9px;
    min-width: 0;
    padding: 0;
    font-size: 0;
    color: transparent;
    background: var(--pack-ink);
    border: 1px solid var(--surface);
  }
}

/* --- Scrim (mobile only) --------------------------------------------------------- */

.scrim {
  display: none;
}

/* --- Mobile off-canvas drawer (≤ 860px) ------------------------------------------ */

@media (max-width: 860px) {
  .sidebar {
    position: fixed;
    top: var(--header-height);
    left: 0;
    z-index: 60;
    /* dvh so the mobile URL bar showing/hiding doesn't clip the drawer. */
    height: calc(100dvh - var(--header-height));
    width: min(84vw, 20rem);
    transform: translateX(-100%);
    visibility: hidden;
    box-shadow: var(--shadow-2);
    transition:
      transform var(--dur) var(--ease-out),
      visibility var(--dur);
  }

  .sidebar.is-open {
    transform: translateX(0);
    visibility: visible;
  }

  /* The drawer's own dismissal, top-right; the brand yields the corner to it. */
  .drawer-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: absolute;
    top: 0.6rem;
    right: 0.6rem;
    width: var(--tap);
    height: var(--tap);
    background: transparent;
    border: 1px solid var(--card-border);
    border-radius: var(--r-md);
    color: var(--ink-secondary);
    transition:
      background var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease);
  }

  .drawer-close:hover {
    background: var(--raised);
    color: var(--ink);
  }

  .drawer-close svg {
    width: 20px;
    height: 20px;
  }

  .brand {
    padding-right: 3rem;
  }

  .scrim.show {
    display: block;
    position: fixed;
    inset: var(--header-height) 0 0 0;
    z-index: 55;
    background: rgba(0, 0, 0, 0.5);
  }
}
</style>
