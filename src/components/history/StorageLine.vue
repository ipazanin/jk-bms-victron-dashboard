<script setup lang="ts">
import { computed, ref } from 'vue'

import type { ArchiveUsage } from '../../application/history/historyBrowser'
import type { HistoryAvailability } from '../../application/history/port'
import {
  LOCAL_CAPACITY_MIB,
  loadLocalCapacityMiB,
  saveLocalCapacityMiB,
} from '../../application/history/localCapacity'
import { PRUNE_TARGET_RATIO } from '../../domain/history/budget'

const props = defineProps<{
  usage: ArchiveUsage | null
  availability: HistoryAvailability | null
}>()

const selectedCapacity = ref(loadLocalCapacityMiB())
const failure = ref<string | null>(null)
const capacityChanged = ref(false)
const MIB_BYTES = 1024 * 1024

const meter = computed(() => {
  const usage = props.usage
  if (usage?.rawBytes === undefined) return null
  const capacity = capacityChanged.value
    ? selectedCapacity.value * MIB_BYTES
    : usage.rawCapacityBytes ?? selectedCapacity.value * MIB_BYTES
  return {
    used: (usage.rawBytes / MIB_BYTES).toFixed(1),
    capacity: capacity / MIB_BYTES,
    fill: Math.min(1, Math.max(0, usage.rawBytes / capacity)),
  }
})

function changeCapacity(event: Event): void {
  const requested = Number((event.target as HTMLSelectElement).value)
  const capacity = LOCAL_CAPACITY_MIB.find((candidate) => candidate === requested)
  if (capacity === undefined) return
  try {
    saveLocalCapacityMiB(capacity)
    selectedCapacity.value = capacity
    capacityChanged.value = true
    failure.value = null
  } catch {
    failure.value = 'This browser could not save the recording allowance.'
  }
}
</script>

<template>
  <div v-if="availability?.usable" class="storage">
    <label class="copy allowance">
      Raw recording allowance on this browser
      <select :value="selectedCapacity" @change="changeCapacity">
        <option v-for="capacity in LOCAL_CAPACITY_MIB" :key="capacity" :value="capacity">
          {{ capacity }} MiB
        </option>
      </select>
    </label>
    <div v-if="meter" class="track" role="img" :aria-label="`${meter.used} of ${meter.capacity} MiB of raw recordings used`">
      <div class="fill" :style="{ width: `${meter.fill * 100}%` }" />
      <div class="target" :style="{ left: `${PRUNE_TARGET_RATIO * 100}%` }" />
    </div>
    <p v-if="meter" class="readout figures">{{ meter.used }} of {{ meter.capacity }} MiB of raw recordings</p>
    <p class="copy">
      At the limit, the oldest raw chunks are removed after their hourly summaries are saved.
      Raw samples stay on this browser. Hourly summaries and important moments can be backed up.
    </p>
    <p v-if="capacityChanged" class="copy" role="status">The new allowance applies when recording next writes to storage.</p>
    <p v-if="failure" class="copy" role="alert">{{ failure }}</p>
    <p v-if="availability.persisted === true" class="copy">The browser has agreed to retain this storage.</p>
    <p v-else class="copy">The browser may clear this storage when space runs low. Back up the history you want to keep.</p>
  </div>
</template>

<style scoped>
.storage {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: var(--pad);
}

.allowance {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}

select {
  min-height: var(--tap);
  color: var(--ink);
  background: var(--raised);
  border: 1px solid var(--gridline);
  border-radius: 3px;
  padding: 0.4rem 0.6rem;
}

.track {
  position: relative;
  height: 10px;
  background: var(--raised);
  border: 1px solid var(--gridline);
  border-radius: 2px;
  overflow: hidden;
}

.fill {
  height: 100%;
  background: var(--ink-muted);
}

.target {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--baseline);
}

.figures {
  margin: 0;
  color: var(--ink-secondary);
}

.copy {
  margin: 0;
}
</style>
