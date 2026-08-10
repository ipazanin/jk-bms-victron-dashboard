<script setup lang="ts">
/**
 * Whether anything is being written down, said plainly.
 *
 * Deliberately not red. Red is a status token on this page and recording is not a fault; a
 * recording indicator borrowing the alarm palette would make every session look like an incident.
 *
 * It says nothing at all when the archive is usable and no session is open — there is no honest
 * claim to make about a link that has not started. It says nothing while the lease of a session
 * just opened is still undecided, for exactly the same reason. Every negative case it does print
 * names its cause, because "not recording" without a reason reads as a bug.
 *
 * Another tab holding the recording lease is one of those causes and an ordinary one, so it is
 * worded as the plain fact it is: the watch is being written down, just not here.
 */
import { computed, onUnmounted, ref, watch } from 'vue'

import { groupedCount } from '../application/format'
import type { HistoryAvailability } from '../application/history/port'
import type { RecorderState } from '../application/history/SessionRecorder'

const props = defineProps<{
  state: RecorderState
  /** Null until the storage probe answers. Not a refusal, so the plate stays quiet through it
   *  rather than printing a line it would have to take back. */
  availability: HistoryAvailability | null
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

/**
 * A session whose archive stopped taking its rows is not recording, whatever the session id still
 * says — and neither is one opened on an observation whose lease is not this tab's. The line that
 * then prints is the archive's own, below, because a store that went away can say why and a refused
 * write cannot.
 */
const recording = computed(
  () =>
    props.state.sessionId !== null &&
    props.state.failure === null &&
    props.state.lease === 'held',
)

/**
 * A session is built on the observation that opened it and the lease is claimed on the step behind
 * it, so there is one frame where the session may yet be dropped whole. Nothing is printed across
 * it: a stopwatch that starts and vanishes is worse than a stopwatch that starts late.
 */
const undecided = computed(
  () => props.state.sessionId !== null && props.state.lease === 'undecided',
)

/** False once the probe has answered that this browser will keep no archive at all. */
const usable = computed(() => props.availability === null || props.availability.usable)

/**
 * The one unusable archive the owner can do something about without leaving the page, so it gets
 * its own line: the generic one would blame a browser that refused nothing.
 */
const heldByOlderTab = computed(() => props.availability?.reason === 'open-blocked')

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
</script>

<template>
  <template v-if="!undecided">
    <p v-if="recording" class="plate-line readout">
      <span aria-hidden="true" class="mark">■</span>
      <span>RECORDING · {{ elapsed }} · {{ groupedCount(samples) }} samples</span>
    </p>
    <p v-else-if="state.lease === 'refused'" class="plate-line copy">
      NOT RECORDING — another tab of this page is keeping the log.
    </p>
    <p v-else-if="heldByOlderTab" class="plate-line copy">
      NOT RECORDING — an older version of this page is open in another tab.
    </p>
    <p v-else-if="!usable" class="plate-line copy">
      NOT RECORDING — this browser will not keep a log.
    </p>
    <p v-else-if="state.failure !== null" class="plate-line copy">
      NOT RECORDING — the log could not be written to.
    </p>
  </template>
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
