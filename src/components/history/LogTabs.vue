<script setup lang="ts">
import { computed } from 'vue'

import { useHistoryBrowser } from '../../application/history/historyBrowser'
import { hashOf, route } from '../../application/route'

const { warnings } = useHistoryBrowser()

const active = computed(() => (route.value.name === 'warnings' ? 'warnings' : 'sessions'))
const sessionsHref = hashOf({ name: 'log' })
const warningsHref = hashOf({ name: 'warnings' })
</script>

<template>
  <nav class="log-tabs" aria-label="Log views">
    <a :href="sessionsHref" :aria-current="active === 'sessions' ? 'page' : undefined">Sessions</a>
    <a :href="warningsHref" :aria-current="active === 'warnings' ? 'page' : undefined">
      Warnings<span v-if="warnings.length > 0" class="count">&nbsp;{{ warnings.length }}</span>
    </a>
  </nav>
</template>

<style scoped>
.log-tabs {
  display: inline-flex;
  margin: 1rem var(--pad) 0;
  border: 1px solid var(--gridline);
  border-radius: var(--radius);
  overflow: hidden;
}

.log-tabs a {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  padding: 0 1rem;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-secondary);
  text-decoration: none;
}

.log-tabs a + a {
  border-left: 1px solid var(--gridline);
}

.log-tabs a[aria-current='page'] {
  background: var(--raised);
  color: var(--ink);
}

.count {
  color: var(--ink-muted);
}

.log-tabs a[aria-current='page'] .count {
  color: var(--ink-secondary);
}
</style>
