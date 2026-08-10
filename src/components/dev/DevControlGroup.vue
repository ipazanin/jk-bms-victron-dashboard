<script setup lang="ts">
/**
 * One titled section of the dev panel, folded away until it is asked for.
 *
 * A native `<details>`, so the disclosure costs no state here and stays keyboard-reachable and
 * findable by the browser's own page search. Nine groups of levers do not fit on a phone at once,
 * and the phone is a first-class route into this panel rather than an afterthought.
 */
defineProps<{
  title: string
  /** When these controls apply, or what they cannot reach — the sentence a lever cannot carry. */
  note?: string
}>()
</script>

<template>
  <details class="group">
    <summary class="plate">{{ title }}</summary>
    <p v-if="note" class="group-note">{{ note }}</p>
    <div class="group-controls">
      <slot />
    </div>
  </details>
</template>

<style scoped>
.group {
  border-top: 1px solid var(--gridline);
}

summary {
  display: flex;
  align-items: center;
  min-height: var(--tap);
  padding: 0 0.3rem;
  cursor: pointer;
  color: var(--ink);
}

summary:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}

.group-note {
  margin: 0 0.3rem 0.6rem;
  font-size: 0.75rem;
  color: var(--ink-muted);
}

.group-controls {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  padding: 0 0.3rem 0.9rem;
}
</style>
