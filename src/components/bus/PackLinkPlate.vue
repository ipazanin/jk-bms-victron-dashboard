<script setup lang="ts">
/**
 * What the pack link is doing, on the page the owner actually watches, and the one control that
 * changes it.
 *
 * This sits above instruments read at a glance in daylight, so it is deliberately not an alarm. A
 * pack behind a bulkhead or half a pontoon away is the ordinary case on a boat and the honest thing
 * to say about it is that the page is still looking — the search is work, not a fault, and it wears
 * the annunciator's unassessed pulse rather than anything from the status palette.
 *
 * Three states, and the difference between them is what the owner could do about it. Searching needs
 * no control at all: the tap it would offer is the thing already happening. A page that has been
 * disconnected needs one, because only a press undoes a press. And a blocker — a radio switched off,
 * a permission that has lapsed — needs the sentence naming what to do, plus the way to the chooser
 * for the one case a tap genuinely fixes.
 */
import { computed } from 'vue'

import { rejoinBlockerNote } from '../../application/rejoinBlockerNote'
import type { RejoinBlocker } from '../../application/RejoinBlocker'
import { hashOf } from '../../application/route'

const props = defineProps<{
  /** The remembered pack's advertised name, or null when it never gave one. */
  packName: string | null
  /** Whether this browser goes back to it on its own, as the owner last answered it. */
  armed: boolean
  /** Looking right now — the attempt in flight and the waits between them alike. */
  searching: boolean
  blocker: RejoinBlocker | null
}>()

const emit = defineEmits<{ rejoin: [] }>()

const connectHref = hashOf({ name: 'connect' })

/** A pack that advertised no name is still referred to as something, and this is the honest one. */
const packSubject = computed(() => props.packName ?? 'the pack')

const heading = computed(() => {
  if (props.searching) return 'Reconnecting'
  if (props.blocker !== null) return 'Held'
  return props.armed ? 'Not connected' : 'Disconnected'
})

const line = computed(() => {
  if (props.blocker !== null) return rejoinBlockerNote(props.blocker, packSubject.value)
  if (props.searching) return `Looking for ${packSubject.value}. It comes back on its own.`
  if (props.armed) return `Nothing is reporting. The page tries ${packSubject.value} again shortly.`
  return `You disconnected, so the page has stopped looking for ${packSubject.value}.`
})

/** The one refusal a tap here cannot answer: the chooser is on the Connect page, and it needs one. */
const chooserNeeded = computed(
  () => props.blocker === 'permission-gone' || props.blocker === 'browser-cannot-rejoin',
)

/** Offered only where pressing it would change something: a search already running would not. */
const canPress = computed(() => !props.searching && props.blocker === null)
</script>

<template>
  <section class="link">
    <span class="dot" :class="{ hunting: searching }" aria-hidden="true" />
    <span class="plate">{{ heading }}</span>
    <!-- The sentence carries the whole state, so it is the live region rather than the row: a
         region wrapping the control would re-announce a button that has not changed. -->
    <span class="line" role="status">{{ line }}</span>

    <a v-if="chooserNeeded" class="button" :href="connectHref">Open Connect</a>
    <button v-else-if="canPress" type="button" class="button" @click="emit('rejoin')">
      Reconnect
    </button>
  </section>
</template>

<style scoped>
/* One row on the Bus stack, on the annunciator's own rhythm: the card surface comes from the
   `.card` utility the view puts on it, and only the padding and the row belong here. */
.link {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.6rem 1rem;
  padding: 0.75rem var(--pad);
}

.dot {
  width: 9px;
  height: 9px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--ink-muted);
}

/* Alive but not yet answered — the same breath the annunciator uses for a radio that is up to
   something and has delivered nothing. Collapses under the global prefers-reduced-motion rule. */
.dot.hunting {
  animation: breathe 2.4s ease-in-out infinite;
}

@keyframes breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.line {
  font-size: 0.875rem;
  color: var(--ink-secondary);
  max-width: 62ch;
}

/* The control sits at the end of the row, and the link wears the button's shape so the two states
   read as one control that changes its mind rather than two different things. */
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
  min-height: var(--tap);
  padding: 0 1rem;
  background: transparent;
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  color: var(--ink);
  text-decoration: none;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 600;
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}

.button:hover {
  background: var(--raised);
  border-color: var(--ink-secondary);
}
</style>
