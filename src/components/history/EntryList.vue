<script setup lang="ts">
/**
 * What the annunciator said, when it said it.
 *
 * Entries are stored transitions, captured with the text as it read at the time. They are never
 * re-derived from the samples beside them: an alarm re-run against an hours-old snapshot would
 * annunciate the past, and a threshold changed since the session was recorded would silently
 * rewrite what the owner was told on the night.
 *
 * Every line is a button rather than a label, because the one thing a reader wants from an
 * incident is the instant it happened — so the line scrubs everything above it to that moment.
 */
import { computed } from 'vue'

import type { SessionEntry } from '../../domain/history/types'

const props = defineProps<{
  entries: readonly SessionEntry[]
  cursorAt: number | null
}>()

const emit = defineEmits<{ scrub: [number] }>()

/** Half a second either side: the cursor lands on a sample instant, an entry on its own stamp. */
const CURRENT_TOLERANCE_MS = 500

const LEVEL_GLYPHS: Readonly<Record<SessionEntry['level'], string>> = {
  good: '✓',
  warning: '!',
  serious: '▲',
  critical: '✕',
  neutral: '·',
}

const rows = computed(() =>
  props.entries.map((entry) => ({
    entry,
    glyph: glyphFor(entry),
    current:
      props.cursorAt !== null && Math.abs(props.cursorAt - entry.at) <= CURRENT_TOLERANCE_MS,
  })),
)

/**
 * The kind decides the mark for everything that is not a fault, so a cleared alarm and a session
 * boundary never wear an alarm glyph; a fault takes its severity's mark, which is the same one the
 * live annunciator used.
 */
function glyphFor(entry: SessionEntry): string {
  switch (entry.kind) {
    case 'cleared':
      return '✓'
    case 'deepest':
      return '▾'
    case 'fault':
      return LEVEL_GLYPHS[entry.level]
    default:
      return '·'
  }
}

function clockSeconds(at: number): string {
  const when = new Date(at)
  return [when.getHours(), when.getMinutes()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}
</script>

<template>
  <section v-if="entries.length > 0" class="entries">
    <header class="head">
      <h2 class="plate">Entries</h2>
      <p class="muted">What the annunciator said at the time, not re-run against these numbers.</p>
    </header>

    <ul class="list">
      <li v-for="row in rows" :key="`${row.entry.at}-${row.entry.text}`">
        <button
          type="button"
          class="row"
          :class="{ current: row.current }"
          :aria-current="row.current ? 'true' : undefined"
          @click="emit('scrub', row.entry.at)"
        >
          <span class="readout at">{{ clockSeconds(row.entry.at) }}</span>
          <span class="glyph" :class="row.entry.level" aria-hidden="true">{{ row.glyph }}</span>
          <span class="text">{{ row.entry.text }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.entries {
  padding: var(--pad);
  border-top: 1px solid var(--gridline);
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.5rem;
}

.head h2 {
  margin: 0;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.row {
  display: grid;
  grid-template-columns: 4rem 1.25rem 1fr;
  align-items: baseline;
  gap: 0.75rem;
  width: 100%;
  min-height: var(--tap);
  padding: 0.4rem 0.25rem;
  background: transparent;
  border: none;
  border-top: 1px solid var(--gridline);
  color: var(--ink-secondary);
  text-align: left;
}

.row:hover {
  background: var(--raised);
  color: var(--ink);
}

.current {
  background: var(--raised);
  color: var(--ink);
}

.at {
  color: var(--ink-muted);
}

.glyph {
  font-family: var(--font-mono);
  font-weight: 700;
  text-align: center;
}

.glyph.good {
  color: var(--status-good-ink);
}
.glyph.warning {
  color: var(--status-warning-ink);
}
.glyph.serious {
  color: var(--status-serious-ink);
}
.glyph.critical {
  color: var(--status-critical-ink);
}
.glyph.neutral {
  color: var(--ink-muted);
}

.text {
  font-size: var(--text-copy);
}
</style>
