<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import DeviceGroup from './DeviceGroup.vue'
import LogTabs from './LogTabs.vue'
import StorageLine from './StorageLine.vue'
import { useHistoryBrowser } from '../../application/history/historyBrowser'
import { useTelemetry } from '../../application/telemetry'
import { useArchiveWorkspace } from '../../application/backup/useArchiveWorkspace'
import { hashOf } from '../../application/route'
import type { DeviceKey } from '../../domain/history/types'

const MS_PER_HOUR = 3_600_000
const MS_PER_MINUTE = 60_000
const TICK_MS = 30_000

const browser = useHistoryBrowser()
const { readOnly, selected } = useArchiveWorkspace()
const connectHref = hashOf({ name: 'connect' })
const { capabilities } = useTelemetry()

const currentTime = ref(Date.now())
const now = computed(() => selected.value?.exportedAt ?? currentTime.value)
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  void browser.refresh().catch(() => undefined)
  timer = setInterval(() => (currentTime.value = Date.now()), TICK_MS)
})

onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer)
})

const { availability, groups, archive, usage, missing, failure } = browser

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
  if (!readOnly.value) await browser.renameDevice(key, label)
}

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
      <h2 class="head-title">Log</h2>
      <p class="copy head-sub">
        Sessions from {{ selected?.source.label ?? 'this browser' }}. 1 Hz, exactly what the radios reported.
      </p>
      <p v-if="archive.sessions > 0" class="readout totals">{{ totals }}</p>
    </header>

    <LogTabs />

    <div class="body">
      <StorageLine v-if="!readOnly" class="card" :usage="usage" :availability="availability" />

      <p v-if="missing !== null" class="notice copy card" role="status">
        That session was dropped to make room.
      </p>

      <p v-if="failure !== null" class="notice copy card" role="status">{{ failure }}</p>

      <div v-if="blocked === 'version-newer'" class="card state-card">
        <p class="copy state">
          This browser holds a log recorded by a newer version of this page. It is left untouched.
        </p>
      </div>

      <div v-else-if="blocked === 'quota-exhausted'" class="card state-card">
        <p class="copy state">
          The log is full and the archive is not accepting new samples. The instruments are
          unaffected. Delete a session to make room.
        </p>
      </div>

      <div v-else-if="blocked === 'open-blocked'" class="card state-card">
        <p class="copy state">
          Another tab is running an older version of this page and is holding the log open. Close it
          and reload.
        </p>
      </div>

      <div v-else-if="blocked !== null" class="card state-card">
        <p class="state-title">This browser will not keep a log.</p>
        <p class="copy state">
          Storage is blocked, which is what private browsing normally does. The page still works as a
          live instrument and still remembers the last frame, but nothing is being written down.
        </p>
      </div>

      <DeviceGroup
        v-for="group in groups"
        :key="group.key"
        class="card"
        :group="group"
        :now="now"
        :sticky="groups.length > 1"
        @rename="rename"
      />

      <div
        v-if="groups.length === 0 && blocked === null && availability !== null"
        class="card state-card"
      >
        <template v-if="readOnly">
          <p class="state-title">No sessions in this saved copy.</p>
          <p class="copy state">Device history may still be available in Stats &amp; history.</p>
        </template>
        <template v-else-if="capabilities.canConnect">
          <p class="state-title">No sessions yet.</p>
          <p class="copy state">
            Recording starts on its own, the moment the BMS sends its first cell frame.
          </p>
        </template>
        <template v-else>
          <p class="state-title">Nothing recorded in this browser.</p>
          <p class="copy state">
            This browser cannot connect directly to the radios. Open an archive exported from another
            browser in <a :href="connectHref">Data &amp; backup</a> to browse its history here.
          </p>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.log {
  --stack-gap: clamp(0.75rem, 1.5vw, 1.25rem);
  container-type: inline-size;
}

.head {
  padding: clamp(1rem, 3vw, 1.75rem) var(--pad) 0;
}

.head-title {
  margin: 0;
  font-family: var(--font-body);
  font-weight: 600;
  font-size: clamp(1.35rem, 1rem + 1.6vw, 1.85rem);
  letter-spacing: -0.01em;
  color: var(--ink);
}

.head-sub {
  margin: 0.4rem 0 0;
}

.totals {
  margin: 0.5rem 0 0;
  color: var(--ink-secondary);
}

.body {
  display: flex;
  flex-direction: column;
  gap: var(--stack-gap);
  padding: var(--stack-gap) 0 2.5rem;
}

.notice {
  margin: 0;
  padding: var(--pad);
  color: var(--ink);
}

.state-card {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: var(--pad);
}

.state-title {
  margin: 0;
  font-family: var(--font-body);
  font-size: 1.125rem;
  font-weight: 600;
}

.state {
  margin: 0;
}
</style>
