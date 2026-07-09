<script setup lang="ts">
import type { FaultLevel } from '../application/telemetry'

defineProps<{ level: FaultLevel; label: string }>()

const GLYPHS: Record<FaultLevel, string> = {
  good: '✓',
  warning: '!',
  serious: '▲',
  critical: '✕',
}
</script>

<template>
  <span class="chip" :class="level">
    <span aria-hidden="true" class="glyph">{{ GLYPHS[level] }}</span>
    <span>{{ label }}</span>
  </span>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  white-space: nowrap;
}

.glyph {
  font-weight: 700;
}

.good {
  color: var(--status-good);
}
.warning {
  color: var(--status-warning);
}
.serious {
  color: var(--status-serious);
}
.critical {
  color: var(--status-critical);
}
</style>
