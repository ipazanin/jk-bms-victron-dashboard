<script setup lang="ts">
/**
 * The archive, read from the top.
 *
 * One scrollable column, newest first, grouped by device. No search, no filters, no pagination — a
 * log is read from the top, and a control that hides rows is a control that can hide the row the
 * reader came for.
 *
 * Every unavailable state names its real cause. A generic empty state here would be the page's
 * biggest lie: a browser that cannot talk to Bluetooth at all and a browser whose storage is
 * blocked both show nothing, and the two need entirely different sentences from a reader who is
 * trying to work out whether the boat has a problem or the laptop does.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

import DeviceGroup from './DeviceGroup.vue'
import StorageLine from './StorageLine.vue'
import { useHistoryBrowser } from '../../application/history/historyBrowser'
import { useTelemetry } from '../../application/telemetry'
import type { DeviceKey } from '../../domain/history/types'

const MS_PER_HOUR = 3_600_000
const MS_PER_MINUTE = 60_000
/** Open sessions grow in the list, and a minute is the finest figure any row prints. */
const TICK_MS = 30_000

const browser = useHistoryBrowser()
const { capabilities } = useTelemetry()

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  void browser.refresh().catch(() => undefined)
  timer = setInterval(() => (now.value = Date.now()), TICK_MS)
})

onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer)
})

// Destructured so the template reads them as top-level refs, which `<script setup>` unwraps.
const { availability, groups, archive, usage, missing, failure } = browser

/** Null while the storage probe has not answered, which is not the same as unavailable. */
const blocked = computed(() => {
  const answer = availability.value
  if (answer === null || answer.usable) return null
  return answer.reason
})

const totals = computed(() => {
  const sessions = archive.value.sessions
  return `${sessions} ${sessions === 1 ? 'session' : 'sessions'} · ${spacedTotal(archive.value.recordedMs)} recorded`
})

async function rename(key: DeviceKey, label: string | null): Promise<void> {
  await browser.renameDevice(key, label)
}

/** `61 h 12 m`. Minutes are padded so totals down the page rule themselves. */
function spacedTotal(elapsedMs: number): string {
  const hours = Math.floor(elapsedMs / MS_PER_HOUR)
  const minutes = Math.round((elapsedMs % MS_PER_HOUR) / MS_PER_MINUTE)
  if (hours === 0) return `${minutes} m`
  return `${hours} h ${String(minutes).padStart(2, '0')} m`
}
</script>

<template>
  <section class="log">
    <header class="head">
      <h2 class="plate">Log</h2>
      <p class="copy">Every session this browser recorded. 1 Hz, exactly what the radios reported.</p>
      <p v-if="archive.sessions > 0" class="readout totals">{{ totals }}</p>
      <StorageLine :usage="usage" :availability="availability" />
    </header>

    <p v-if="missing !== null" class="notice copy" role="status">
      That session was dropped to make room.
    </p>

    <p v-if="failure !== null" class="notice copy" role="status">{{ failure }}</p>

    <template v-if="blocked === 'version-newer'">
      <p class="copy state">
        This browser holds a log recorded by a newer version of this page. It is left untouched.
      </p>
    </template>

    <template v-else-if="blocked === 'quota-exhausted'">
      <p class="copy state">
        The log is full and the archive is not accepting new samples. The instruments are
        unaffected. Delete a session to make room.
      </p>
    </template>

    <template v-else-if="blocked !== null">
      <p class="state-title">This browser will not keep a log.</p>
      <p class="copy state">
        Storage is blocked, which is what private browsing normally does. The page still works as a
        live instrument and still remembers the last frame, but nothing is being written down.
      </p>
    </template>

    <DeviceGroup
      v-for="group in groups"
      :key="group.key"
      :group="group"
      :now="now"
      :sticky="groups.length > 1"
      @rename="rename"
    />

    <template v-if="groups.length === 0 && blocked === null && availability !== null">
      <template v-if="capabilities.canConnect">
        <p class="state-title">No sessions yet.</p>
        <p class="copy state">
          Recording starts on its own, the moment the BMS sends its first cell frame.
        </p>
      </template>
      <template v-else>
        <p class="state-title">Nothing recorded in this browser.</p>
        <p class="copy state">
          The log lives in this browser and nowhere else, and this browser cannot talk to the
          hardware — so nothing was ever recorded here. It also cannot read what Chrome recorded on
          the same machine.
        </p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.log {
  background: var(--surface);
}

.head {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 1.25rem var(--pad);
  border-bottom: 1px solid var(--gridline);
}

.head h2 {
  margin: 0;
}

.head .copy {
  margin: 0;
}

.totals {
  margin: 0;
  color: var(--ink-secondary);
}

.notice {
  margin: 0;
  padding: 0.75rem var(--pad);
  border-bottom: 1px solid var(--gridline);
  color: var(--ink);
}

.state-title {
  margin: 0;
  padding: 1.25rem var(--pad) 0;
  font-family: var(--font-body);
  font-size: 1.125rem;
  font-weight: 600;
}

.state {
  margin: 0.4rem 0 0;
  padding: 0 var(--pad) 1.5rem;
}
</style>
