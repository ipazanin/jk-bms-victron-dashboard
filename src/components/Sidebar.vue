<script setup lang="ts">
import { computed } from 'vue'

import { hashOf, route } from '../application/route'
import type { Theme } from '../application/theme'

defineProps<{
  theme: Theme
  sessionCount: number
}>()

const emit = defineEmits<{ toggleTheme: [] }>()

/** Log stays lit for a single session and for the warnings sub-view, both reached through it. */
const active = computed(() =>
  route.value.name === 'session' || route.value.name === 'warnings' ? 'log' : route.value.name,
)

const links = [
  { name: 'dashboard' as const, href: hashOf({ name: 'dashboard' }), label: 'Bus' },
  { name: 'connect' as const, href: hashOf({ name: 'connect' }), label: 'Connect' },
  { name: 'stats' as const, href: hashOf({ name: 'stats' }), label: 'Stats' },
  { name: 'log' as const, href: hashOf({ name: 'log' }), label: 'Log' },
]
</script>

<template>
  <aside class="sidebar">
    <a class="brand" :href="hashOf({ name: 'dashboard' })">
      <span class="wordmark">Shunt</span>
      <span class="tagline">JK-BMS · Victron SmartSolar</span>
    </a>

    <nav class="nav" aria-label="Sections">
      <a
        v-for="link in links"
        :key="link.name"
        :href="link.href"
        class="tab"
        :aria-current="active === link.name ? 'page' : undefined"
      >
        <span class="tab-label">{{ link.label }}</span>
        <span v-if="link.name === 'log' && sessionCount > 0" class="count">{{ sessionCount }}</span>
      </a>
    </nav>

    <button type="button" class="theme" @click="emit('toggleTheme')">
      {{ theme === 'dark' ? 'Light' : 'Dark' }}
    </button>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  padding: 1.5rem 1rem;
  border-right: 1px solid var(--gridline);
  background: var(--surface);
}

.brand {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  text-decoration: none;
  color: var(--ink);
  padding: 0 0.5rem;
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
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.tab {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-height: var(--tap);
  padding: 0 0.75rem;
  border-radius: var(--radius);
  border-left: 2px solid transparent;
  color: var(--ink-secondary);
  text-decoration: none;
  font-family: var(--font-label);
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
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

.count {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--ink-muted);
}

.tab[aria-current='page'] .count {
  color: var(--ink-secondary);
}

.theme {
  margin-top: auto;
  align-self: flex-start;
  background: transparent;
  border: 1px solid var(--gridline);
  color: var(--ink-secondary);
  border-radius: 2px;
  min-height: var(--tap);
  padding: 0.35rem 0.9rem;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/* Under the rail breakpoint the sidebar is a top bar: brand left, tabs in a scrollable row,
   theme toggle right. The wordmark keeps its place; the tagline is dropped to save the height. */
@media (max-width: 860px) {
  .sidebar {
    flex-direction: row;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem var(--pad);
    border-right: none;
    border-bottom: 1px solid var(--gridline);
  }

  .tagline {
    display: none;
  }

  .nav {
    flex-direction: row;
    flex: 1;
    overflow-x: auto;
    gap: 0.25rem;
  }

  .tab {
    border-left: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    white-space: nowrap;
  }

  .tab[aria-current='page'] {
    border-left-color: transparent;
    border-bottom-color: var(--pack-ink);
    background: transparent;
  }

  .theme {
    margin-top: 0;
  }
}
</style>
