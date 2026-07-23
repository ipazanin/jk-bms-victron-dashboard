<script setup lang="ts">
/**
 * Whether anything is being written down, said plainly.
 *
 * Deliberately not red. Red is a status token on this page and recording is not a fault; a
 * recording indicator borrowing the alarm palette would make every session look like an incident.
 *
 * It says nothing at all when the archive is usable and no session is open — there is no honest
 * claim to make about a link that has not started. The one sentence it does print in the negative
 * names the real cause, because "not recording" without a reason reads as a bug.
 */
import { computed, onUnmounted, ref, watch } from 'vue'

import type { RecorderState } from '../application/history/SessionRecorder'

const props = defineProps<{
  state: RecorderState
  /** False when the browser refused an archive at all: private browsing, or no IndexedDB. */
  usable: boolean
}>()

const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600

/** Its own tick, so nothing in the recorder has to hold a wall-clock timer for a label. */
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

watch(
  () => props.state.sessionId,
  (sessionId) => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    if (sessionId === null) return
    now.value = Date.now()
    timer = setInterval(() => (now.value = Date.now()), MS_PER_SECOND)
  },
  { immediate: true },
)

onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer)
})

/** A write that failed is not recording, whatever the session id still says. */
const recording = computed(() => props.state.sessionId !== null && props.state.failure === null)

const elapsed = computed(() => {
  const startedAt = props.state.startedAt
  if (startedAt === null) return '00:00:00'
  return stopwatch(Math.max(0, now.value - startedAt))
})

const samples = computed(() => props.state.packSamples + props.state.solarSamples)

/** `00:41:12`. Hours run past 24 rather than rolling over: a two-day watch is a two-day watch. */
function stopwatch(elapsedMs: number): string {
  const total = Math.floor(elapsedMs / MS_PER_SECOND)
  const hours = Math.floor(total / SECONDS_PER_HOUR)
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  const seconds = total % SECONDS_PER_MINUTE
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
}

/** Non-breaking spaces, so a sample count never wraps across the gap between its own digits. */
function grouped(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
</script>

<template>
  <p v-if="recording" class="plate-line readout">
    <span aria-hidden="true" class="mark">■</span>
    <span>RECORDING · {{ elapsed }} · {{ grouped(samples) }} samples</span>
  </p>
  <p v-else-if="!usable" class="plate-line copy">
    NOT RECORDING — this browser will not keep a log.
  </p>
</template>

<style scoped>
.plate-line {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0;
  color: var(--ink-secondary);
  white-space: nowrap;
}

.mark {
  font-size: 0.7em;
  line-height: 1;
}
</style>
