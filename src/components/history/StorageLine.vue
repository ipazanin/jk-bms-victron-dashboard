<script setup lang="ts">
/**
 * How much of the archive is spent, and who has promised to keep it.
 *
 * The budget is counted in samples and printed in bytes. Both halves of the sentence are derived
 * from the same row width, so the meter and the figures cannot disagree — which they would the
 * moment one side came from `navigator.storage.estimate()`, a number that is padded by design,
 * lags the browser's own accounting and is absent entirely on several platforms.
 *
 * The persistence line is the browser's answer repeated, never improved on. A browser that will
 * not say whether it will keep the data has not promised to keep it, and that is what is printed:
 * Chrome incognito reports exactly this while holding the whole archive in memory, and dressing it
 * up as durability is the one failure a storage line must not have.
 */
import { computed } from 'vue'

import type { ArchiveUsage } from '../../application/history/historyBrowser'
import type { HistoryAvailability } from '../../application/history/port'
import { PRUNE_TARGET_RATIO } from '../../domain/history/budget'
import { PACK_SAMPLE_BYTES, SOLAR_SAMPLE_BYTES } from '../../domain/history/columns'

const props = defineProps<{
  usage: ArchiveUsage | null
  availability: HistoryAvailability | null
}>()

/**
 * A row's cost, averaged across the two streams. The exact figure depends on the mix of pack and
 * solar rows, which the counter does not carry apart, so this is a stated approximation rather
 * than a measurement — it is the same approximation on both sides of "of", which is what matters.
 */
const MEAN_SAMPLE_BYTES = (PACK_SAMPLE_BYTES + SOLAR_SAMPLE_BYTES) / 2
const BYTES_PER_MB = 1_000_000

/**
 * iPadOS reports itself as a Mac, and the seven-day eviction applies there too, so the touch count
 * is what separates a real desktop from a tablet claiming to be one.
 */
const onApplePortable = ((): boolean => {
  if (typeof navigator === 'undefined') return false
  const agent = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(agent)) return true
  return /Macintosh/.test(agent) && navigator.maxTouchPoints > 1
})()

const meter = computed(() => {
  const usage = props.usage
  if (usage === null) return null
  return {
    used: megabytes(usage.totalSamples * MEAN_SAMPLE_BYTES),
    capacity: megabytes(usage.capacitySamples * MEAN_SAMPLE_BYTES),
    /** Clamped: pruning lands a little over the cap before it lands under it. */
    fill: Math.min(1, Math.max(0, usage.usedRatio)),
    nearCapacity: usage.nearCapacity,
  }
})

const persisted = computed(() => props.availability?.persisted === true)

function megabytes(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`
}
</script>

<template>
  <div v-if="availability?.usable && meter" class="storage">
    <div
      class="track"
      role="img"
      :aria-label="`${meter.used} of ${meter.capacity} used, oldest deleted first`"
    >
      <div class="fill" :style="{ width: `${meter.fill * 100}%` }" />
      <!-- The mark pruning aims for, not the cap: it is where the oldest session starts to go. -->
      <div class="target" :style="{ left: `${PRUNE_TARGET_RATIO * 100}%` }" />
    </div>

    <p class="readout figures">{{ meter.used }} of {{ meter.capacity }} · oldest deleted first</p>

    <p v-if="meter.nearCapacity" class="copy">
      Near the limit. The oldest session goes when the next one starts.
    </p>

    <p v-if="persisted" class="copy">The browser has agreed to keep this until you delete it.</p>
    <p v-else class="copy">
      The browser has not promised to keep this. It may clear the log when the disk runs low.
      Download anything you want to keep.
    </p>

    <p v-if="onApplePortable" class="copy">
      iOS clears storage for sites you have not opened in seven days. Download anything you want to
      keep — there is nothing the page can do about it.
    </p>
  </div>
</template>

<style scoped>
.storage {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
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
