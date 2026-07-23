<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import StatusChip from './StatusChip.vue'
import { relativeAge } from '../application/format'
import { hashOf } from '../application/route'
import type { RememberedStatus } from '../application/rememberedSession'

const props = defineProps<{
  capturedAt: number | null
  status: RememberedStatus | null
}>()

const emit = defineEmits<{ forget: [] }>()

// The banner ticks its own age so nothing in telemetry has to hold a wall-clock timer.
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 60_000)
})

onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer)
})

const age = computed(() => (props.capturedAt === null ? 'earlier' : relativeAge(props.capturedAt, now.value)))

const statusLevel = computed(() => props.status?.worst ?? 'good')

const statusLabel = computed(() => {
  const status = props.status
  if (!status || status.worst === 'good') return 'All nominal when last seen'
  return `Last status: ${status.headline}`
})

const connectHref = hashOf({ name: 'connect' })
</script>

<template>
  <header class="remembered">
    <div class="left">
      <span class="dot" aria-hidden="true" />
      <span class="plate">Remembered</span>
      <span class="readout age">Last live session · {{ age }}</span>
    </div>

    <StatusChip :level="statusLevel" :label="statusLabel" />

    <span class="stale-tag">STALE — not live data</span>

    <div class="controls">
      <span class="hint">Open <a :href="connectHref">Connect</a> to go live.</span>
      <button type="button" aria-label="Forget remembered data" @click="emit('forget')">Forget</button>
    </div>
  </header>
</template>

<style scoped>
.remembered {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.75rem var(--pad);
  background: var(--surface);
  border-bottom: 1px solid var(--gridline);
}

.left {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

/* Static, never breathing: the absence of the live pulse reads immediately as "not live". */
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--status-warning);
}

.age {
  color: var(--ink-secondary);
}

.stale-tag {
  margin-left: auto;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.1em;
  color: var(--plane);
  background: var(--ink-secondary);
  padding: 0.15rem 0.5rem;
  border-radius: 2px;
}

.controls {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-basis: 100%;
}

.hint {
  font-size: 0.875rem;
  color: var(--ink-muted);
}

.hint a {
  color: var(--pack-ink);
  text-decoration: none;
}

.hint a:hover {
  text-decoration: underline;
}

button {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--baseline);
  color: var(--ink);
  border-radius: var(--radius);
  padding: 0.35rem 0.8rem;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 600;
}

button:hover {
  border-color: var(--ink-secondary);
}
</style>
