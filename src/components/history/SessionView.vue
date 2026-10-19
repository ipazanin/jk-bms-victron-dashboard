<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import CoverageTape from './CoverageTape.vue'
import EntryList from './EntryList.vue'
import SessionRibbon from './SessionRibbon.vue'
import SessionHours from './SessionHours.vue'
import ShuntLedger from './ShuntLedger.vue'
import ShuntAmmeter from '../ShuntAmmeter.vue'
import StatusChip from '../StatusChip.vue'
import { COMPACT_QUERY } from '../../application/breakpoints'
import { ampHoursSigned, clockTime, clockTimeWithSeconds, groupedCount } from '../../application/format'
import { useHistoryBrowser } from '../../application/history/historyBrowser'
import { MAX_RENDER_WINDOW_MS } from '../../application/history/port'
import { useArchiveWorkspace } from '../../application/backup/useArchiveWorkspace'
import { hashOf, navigate, route } from '../../application/route'
import { useMediaQuery } from '../../application/useMediaQuery'
import { deriveHouse } from '../../domain/dcBus'
import { MAX_SAMPLE_GAP_MS } from '../../domain/history/join'
import type { PairedSample } from '../../domain/history/join'
import type { SessionId, TimeWindow } from '../../domain/history/types'

const props = defineProps<{ id?: SessionId }>()

const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

const CROSS_CHECK_FLOOR_AH = 2
const CROSS_CHECK_FRACTION = 0.1

const TABLE_PAGE_ROWS = 240

const browser = useHistoryBrowser()
const { readOnly } = useArchiveWorkspace()
const { loaded, loading, missing, failure, account, selection, selectedHour, exportState } = browser

const compact = useMediaQuery(COMPACT_QUERY)

const cursorAt = ref<number | null>(null)
const confirmingDelete = ref(false)
const tableStart = ref(0)

const sessionId = computed<SessionId | null>(
  () => props.id || (route.value.name === 'session' ? route.value.id : null),
)

watch(sessionId, () => {
  cursorAt.value = null
  confirmingDelete.value = false
  tableStart.value = 0
})

const record = computed(() => loaded.value?.record ?? null)
const hasRaw = computed(() => (loaded.value?.timeline.length ?? 0) > 0)

const sessionWindow = computed<TimeWindow | null>(() => {
  const row = record.value
  if (row === null) return null
  return { from: row.startedAt, to: row.endedAt ?? row.heartbeatAt }
})

const sessionMs = computed(() => {
  const window = sessionWindow.value
  const row = record.value
  if (window === null || row === null) return 0
  const span = window.to - window.from
  if (span > 0) return span
  return Math.max(row.packSamples, row.solarSamples) * MS_PER_SECOND
})

const ledger = computed(() => account.value?.ledger ?? null)

const coverage = computed(() => record.value?.coverage ?? [])

const solarSeen = computed(() => (record.value?.solarSamples ?? 0) > 0)

const totalSamples = computed(() =>
  record.value === null ? 0 : record.value.packSamples + record.value.solarSamples,
)

const silences = computed(() => {
  const runs = (record.value?.coverage ?? []).filter((run) => run.kind === 'none')
  const total = runs.reduce((sum, run) => sum + (run.to - run.from), 0)
  return { count: runs.length, total }
})

const identityLine = computed(() => {
  const info = record.value?.deviceInfo
  if (!info) return null
  return `${info.model} fw ${info.softwareVersion}`
})

const windowSentence = computed(() => {
  const folded = ledger.value
  if (folded === null) return ''
  const clockAdjusted = selectedHour.value === null
    ? loaded.value?.hours.some((hour) => hour.clockAdjusted)
    : selectedHour.value.clockAdjusted === true
  if (clockAdjusted) {
    return `Both radios contributed ${spacedSpan(folded.countedMs)} of counted time. The recording clock moved backward, so clock times overlap.`
  }
  return `Both radios agreed for ${spacedSpan(folded.countedMs)} of the ${spacedSpan(brushedMs.value)}. Only that window is counted.`
})

const brushedMs = computed(() => {
  const window = selection.value
  return window === null ? sessionMs.value : window.to - window.from
})

const ledgerHeading = computed(() => {
  const window = selection.value
  if (window === null) return 'Session ledger'
  return `${selectedHour.value === null ? 'Raw selection' : 'Hourly ledger'} · ${clockTime(window.from)} → ${clockTime(window.to)}`
})

const foreignMs = computed(() => {
  const folded = ledger.value
  return folded === null || folded.foreignAhFloor <= 0 ? null : folded.foreignMs
})

const crossCheck = computed(() => {
  const folded = record.value?.ledger ?? null
  if (folded === null) return null

  const first = folded.remainingCapacityFirstAh
  const last = folded.remainingCapacityLastAh
  if (first === null || last === null) return null

  const integrated = folded.packAhWholeSession
  const counted = last - first
  const delta = integrated - counted
  const scale = Math.max(Math.abs(integrated), Math.abs(counted))
  const tolerance = Math.max(CROSS_CHECK_FLOOR_AH, scale * CROSS_CHECK_FRACTION)

  return {
    first,
    last,
    integrated,
    counted,
    delta,
    agree: Math.abs(delta) <= tolerance,
    percentApart: scale === 0 ? 0 : Math.round((Math.abs(delta) / scale) * 100),
  }
})

const deepest = computed<PairedSample | null>(() => {
  const rows = loaded.value?.timeline ?? []
  let found: PairedSample | null = null
  let lowest = Number.POSITIVE_INFINITY
  for (const row of rows) {
    if (row.pack === null) continue
    if (row.pack.stateOfCharge < lowest) {
      lowest = row.pack.stateOfCharge
      found = row
    }
  }
  return found
})

const activeAt = computed(() => cursorAt.value ?? deepest.value?.at ?? null)

const activeSample = computed<PairedSample | null>(() => {
  const at = activeAt.value
  return at === null ? null : sampleAt(at)
})

const activeHouse = computed(() => {
  const sample = activeSample.value
  const pack = sample?.pack ?? null
  const solarCurrent = sample?.solar?.batteryCurrentA ?? null
  if (pack === null || solarCurrent === null) return null
  return deriveHouse(pack.currentA, solarCurrent, pack.packVoltageV)
})

const tableRows = computed(() => {
  const rows = loaded.value?.timeline ?? []
  return rows.slice(tableStart.value, tableStart.value + TABLE_PAGE_ROWS).map((row) => {
    const house = houseOf(row)
    return {
      at: row.at,
      packA: row.pack === null ? '—' : row.pack.currentA.toFixed(2),
      solarA: row.solar?.batteryCurrentA == null ? '—' : row.solar.batteryCurrentA.toFixed(1),
      houseA: house === null ? '—' : house.currentA.toFixed(1),
      houseW: house === null ? '—' : String(Math.round(house.powerW)),
      stateOfCharge: row.pack === null ? '—' : String(row.pack.stateOfCharge),
    }
  })
})

const tableCaption = computed(() => {
  const rows = loaded.value?.timeline.length ?? 0
  if (rows === 0) return '— no samples —'
  const first = tableStart.value + 1
  const last = Math.min(rows, tableStart.value + TABLE_PAGE_ROWS)
  return `Rows ${groupedCount(first)}–${groupedCount(last)} of ${groupedCount(rows)}, oldest first`
})

const exportNote = computed(() => {
  const session = loaded.value
  if (session === null) return ''
  return `Download includes ${session.hours.length} hourly summaries, their important moments, and all raw samples still retained.`
})

function onScrub(at: number | null): void {
  if (at !== null && sampleAt(at) === null) {
    const hour = loaded.value?.hours.find((summary) => at >= summary.from && at <= summary.to)
    if (hour !== undefined) browser.selectHour(hour.hourStart)
  }
  cursorAt.value = at
}

function stepCursor(direction: -1 | 1): void {
  const rows = loaded.value?.timeline ?? []
  if (rows.length === 0) return

  const at = activeAt.value
  const index = at === null ? 0 : indexNear(at)
  cursorAt.value = rows[Math.min(rows.length - 1, Math.max(0, index + direction))].at
}

function shiftWindow(direction: 'earlier' | 'later'): void {
  const session = sessionWindow.value
  const shown = loaded.value?.rawWindow
  const id = sessionId.value
  if (!session || !shown || id === null) return

  const width = shown.to - shown.from
  const step = (direction === 'earlier' ? -1 : 1) * (width / 2)
  const from = Math.min(session.to - width, Math.max(session.from, shown.from + step))
  cursorAt.value = null
  void browser.loadSession(id, { from, to: from + width }).catch(() => undefined)
}

async function remove(): Promise<void> {
  const id = sessionId.value
  if (id === null || readOnly.value) return
  await browser.deleteSession(id)
  navigate({ name: 'log' })
}

function pageTable(direction: -1 | 1): void {
  const rows = loaded.value?.timeline.length ?? 0
  const next = tableStart.value + direction * TABLE_PAGE_ROWS
  tableStart.value = Math.min(Math.max(0, rows - 1), Math.max(0, next))
}

function indexNear(at: number): number {
  const rows = loaded.value?.timeline ?? []
  let low = 0
  let high = rows.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (rows[middle].at < at) low = middle + 1
    else high = middle
  }
  if (low > 0 && Math.abs(rows[low - 1].at - at) <= Math.abs(rows[low].at - at)) return low - 1
  return low
}

function sampleAt(at: number): PairedSample | null {
  const rows = loaded.value?.timeline ?? []
  if (rows.length === 0) return null
  const nearest = rows[indexNear(at)]
  return Math.abs(nearest.at - at) <= MAX_SAMPLE_GAP_MS ? nearest : null
}

function houseOf(sample: PairedSample): { currentA: number; powerW: number } | null {
  const pack = sample.pack
  const solarCurrent = sample.solar?.batteryCurrentA ?? null
  if (pack === null || solarCurrent === null) return null
  const house = deriveHouse(pack.currentA, solarCurrent, pack.packVoltageV)
  return house.plausible ? house : null
}

function dayWords(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

function spacedSpan(elapsedMs: number): string {
  if (elapsedMs < MS_PER_MINUTE) return `${Math.round(elapsedMs / MS_PER_SECOND)} s`
  if (elapsedMs < MS_PER_HOUR) return `${Math.round(elapsedMs / MS_PER_MINUTE)} min`
  const days = Math.floor(elapsedMs / MS_PER_DAY)
  const hours = Math.floor((elapsedMs % MS_PER_DAY) / MS_PER_HOUR)
  const minutes = Math.round((elapsedMs % MS_PER_HOUR) / MS_PER_MINUTE)
  if (days > 0) return `${days} d ${hours} h ${minutes} m`
  return `${hours} h ${minutes} m`
}

function tightSpan(elapsedMs: number): string {
  const minutes = Math.round(elapsedMs / MS_PER_MINUTE)
  const hours = Math.floor(minutes / 60)
  if (hours === 0) return `${minutes}m`
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}
</script>

<template>
  <section class="session">
    <header class="head">
      <a class="back" :href="hashOf({ name: 'log' })">‹ Log</a>

      <template v-if="loaded && record && sessionWindow">
        <h2 class="title">
          {{ loaded.label }} · {{ dayWords(record.startedAt) }} ·
          {{ clockTime(sessionWindow.from) }} → {{ clockTime(sessionWindow.to) }} ·
          {{ tightSpan(sessionMs) }}
        </h2>
        <p class="readout facts">
          {{ groupedCount(totalSamples) }} samples originally recorded at 1 Hz ·
          {{ silences.count }} {{ silences.count === 1 ? 'gap' : 'gaps' }} totalling
          {{ spacedSpan(silences.total) }}<template v-if="identityLine"> · {{ identityLine }}</template>
        </p>
        <p v-if="totalSamples === 0 && loaded.hours.length === 0" class="copy">
          No samples. The BMS connected but sent nothing before the link went quiet.
        </p>
        <p v-if="loaded.unreadableChunks > 0" class="copy">
          Part of this log is stored in a layout this version of the page does not read. It is left
          untouched.
        </p>
      </template>

      <div class="actions">
        <button
          type="button"
          class="action"
          :disabled="exportState === 'working' || !loaded"
          @click="browser.downloadSession()"
        >
          Download JSON
        </button>
        <button v-if="!readOnly" type="button" class="action" @click="confirmingDelete = true">Delete session</button>
        <button type="button" class="action" @click="navigate({ name: 'dashboard' })">
          Back to live
        </button>
      </div>

      <p v-if="exportState === 'done'" class="copy" role="status">Downloaded.</p>
      <p v-else-if="exportNote" class="copy">{{ exportNote }}</p>

      <div v-if="!readOnly && confirmingDelete && record" class="confirm">
        <p class="copy">
          Delete this session? {{ spacedSpan(sessionMs) }}, {{ groupedCount(totalSamples) }} samples.
          This cannot be undone.
        </p>
        <button type="button" class="action danger" @click="remove()">Delete</button>
        <button type="button" class="action" @click="confirmingDelete = false">Keep</button>
      </div>
    </header>

    <p v-if="missing !== null" class="notice copy card" role="status">
      That session was dropped to make room.
    </p>
    <p v-else-if="failure !== null" class="notice copy card" role="status">{{ failure }}</p>
    <p v-else-if="loading && !loaded" class="notice copy card" role="status">Reading the session…</p>

    <template v-if="loaded && record && ledger">
      <section class="band card">
        <header class="band-head">
          <h3 class="plate">{{ ledgerHeading }}</h3>
          <p class="muted">boat = solar − pack, integrated</p>
        </header>
        <p class="copy window">{{ windowSentence }}</p>
        <p v-if="selectedHour" class="copy">{{ selectedHour.basis === 'recorded' ? 'Calculated while recording.' : 'Reconstructed from the raw samples that were still available.' }} This selection covers one retained hour span.</p>

        <ShuntLedger :ledger="ledger" :solar-seen="solarSeen" />

        <div v-if="foreignMs !== null" class="unmeasured">
          <details v-if="compact">
            <summary class="copy">Why this is a floor</summary>
            <p class="copy">
              The pack took more than the panels gave for {{ spacedSpan(foreignMs) }} — an
              alternator or shore charger was on the bus. This is a floor: the boat was drawing at
              the same time, so the real figure is higher.
            </p>
          </details>
          <p v-else class="copy">
            The pack took more than the panels gave for {{ spacedSpan(foreignMs) }} — an
            alternator or shore charger was on the bus. This is a floor: the boat was drawing at
            the same time, so the real figure is higher.
          </p>
        </div>

        <div v-if="crossCheck" class="crosscheck">
          <span class="plate">Charge cross-check</span>
          <span class="muted">over the whole {{ spacedSpan(sessionMs) }}, not the counted window</span>
          <span class="readout numbers">
            integrated {{ ampHoursSigned(crossCheck.integrated) }} · BMS counted
            {{ crossCheck.first.toFixed(1) }} → {{ crossCheck.last.toFixed(1) }} Ah =
            {{ ampHoursSigned(crossCheck.counted) }} · Δ {{ Math.abs(crossCheck.delta).toFixed(1) }} Ah
          </span>
          <StatusChip
            :level="crossCheck.agree ? 'good' : 'warning'"
            :label="crossCheck.agree ? 'agree' : `${crossCheck.percentApart} % apart`"
          />
          <p v-if="!crossCheck.agree" class="copy">
            Our integral and the BMS's own counter do not match. Samples were probably missed —
            check the coverage tape for gaps before trusting the ledger.
          </p>
        </div>
      </section>

      <SessionHours
        v-if="loaded.hours.length > 0"
        :key="record.id"
        :hours="loaded.hours"
        :selected-hour="selectedHour"
        @select="browser.selectHour($event)"
      />

      <p v-if="!hasRaw" class="notice copy card">
        No raw samples are available in this view. Hourly history and important moments are shown above when retained.
        Selected moments cannot recreate the original trace or partial-hour totals.
      </p>
      <p v-else class="notice copy card">
        Raw detail below shows the retained samples in the current window. Hourly history above covers all retained hours in this session.
      </p>
      <nav v-if="sessionWindow && sessionMs > MAX_RENDER_WINDOW_MS" class="paging card" aria-label="Raw recording window">
        <button type="button" class="action" :disabled="loaded.rawWindow.from <= sessionWindow.from" @click="shiftWindow('earlier')">Earlier raw window</button>
        <span class="copy">{{ dayWords(loaded.rawWindow.from) }} {{ clockTime(loaded.rawWindow.from) }} to {{ dayWords(loaded.rawWindow.to) }} {{ clockTime(loaded.rawWindow.to) }}</span>
        <button type="button" class="action" :disabled="loaded.rawWindow.to >= sessionWindow.to" @click="shiftWindow('later')">Later raw window</button>
      </nav>

      <CoverageTape
        v-if="hasRaw"
        class="card"
        :coverage="coverage"
        :window="loaded.window"
        :selection="selectedHour === null ? selection : null"
        :cursor-at="cursorAt"
        @select="browser.select($event)"
        @scrub="onScrub"
      />

      <SessionRibbon
        v-if="hasRaw"
        class="card"
        :timeline="loaded.timeline"
        :window="loaded.window"
        :cursor-at="cursorAt"
        :cursor-sample="activeSample"
        @scrub="onScrub"
      />

      <section v-if="hasRaw" class="band scrub card">
        <header class="band-head">
          <h3 class="plate">
            <template v-if="activeAt === null">At —</template>
            <template v-else>At {{ clockTimeWithSeconds(activeAt) }}</template>
          </h3>
          <p v-if="cursorAt === null && activeAt !== null" class="muted">
            the deepest point of the session. Move across the ribbon to pick a moment.
          </p>
          <span v-if="compact" class="stepper">
            <button type="button" class="action" @click="stepCursor(-1)">◀ Prev</button>
            <button type="button" class="action" @click="stepCursor(1)">Next ▶</button>
          </span>
        </header>

        <ShuntAmmeter
          v-if="activeSample?.pack"
          :pack-current="activeSample.pack.currentA"
          :pack-voltage="activeSample.pack.packVoltageV"
          :solar-current="activeSample.solar?.batteryCurrentA ?? null"
          :house-current="activeHouse?.currentA ?? null"
          :house-power="activeHouse?.powerW ?? null"
          :house-load-plausible="activeHouse?.plausible ?? null"
          :pv-power="activeSample.solar?.pvPowerW ?? null"
          :pack-reach="null"
          :solar-reach="null"
          :readout-span-ms="null"
          :pack-phase="'reading'"
          :solar-phase="activeSample.solar ? 'reading' : 'absent'"
          :stale="true"
        />
        <p v-else class="copy">No samples at this instant.</p>

        <p v-if="activeSample?.pack" class="readout instant">
          <span>SOC {{ activeSample.pack.stateOfCharge }} %</span>
          <span>SPREAD {{ Math.round(activeSample.pack.cellDeltaV * 1000) }} mV</span>
          <span>MOSFET {{ activeSample.pack.mosfetTemperatureC.toFixed(1) }} °C</span>
          <span>PACK {{ activeSample.pack.packVoltageV.toFixed(3) }} V</span>
        </p>
        <p class="copy">Per-cell voltages are not kept. The Log stores the spread, not the ladder.</p>
      </section>

      <EntryList class="card" :entries="record.entries" :cursor-at="cursorAt" @scrub="onScrub" />

      <section v-if="hasRaw" class="band card">
        <details>
          <summary class="plate">Show the numbers</summary>

          <div class="table-scroll">
            <table class="twin">
              <caption class="muted">{{ tableCaption }}</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Pack A</th>
                  <th scope="col">Solar A</th>
                  <th scope="col">Boat A</th>
                  <th scope="col">Boat W</th>
                  <th scope="col">SOC %</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in tableRows" :key="row.at">
                  <td>{{ clockTimeWithSeconds(row.at) }}</td>
                  <td>{{ row.packA }}</td>
                  <td>{{ row.solarA }}</td>
                  <td>{{ row.houseA }}</td>
                  <td>{{ row.houseW }}</td>
                  <td>{{ row.stateOfCharge }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="paging">
            <button type="button" class="action" :disabled="tableStart === 0" @click="pageTable(-1)">
              Older
            </button>
            <button
              type="button"
              class="action"
              :disabled="tableStart + TABLE_PAGE_ROWS >= loaded.timeline.length"
              @click="pageTable(1)"
            >
              Newer
            </button>
          </div>
        </details>
      </section>
    </template>
  </section>
</template>

<style scoped>
.session {
  --stack-gap: clamp(0.75rem, 1.5vw, 1.25rem);
  display: flex;
  flex-direction: column;
  gap: var(--stack-gap);
  padding-block: var(--stack-gap);
}

.head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0 var(--pad);
}

.back {
  color: var(--ink-secondary);
  font-family: var(--font-label);
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-decoration: none;
  min-height: var(--tap);
  display: inline-flex;
  align-items: center;
}

.back:hover {
  color: var(--ink);
}

.title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
}

.facts {
  margin: 0;
  color: var(--ink-secondary);
}

.head .copy {
  margin: 0;
}

.actions,
.confirm,
.paging,
.stepper {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.confirm .copy {
  flex-basis: 100%;
}

.action {
  background: transparent;
  border: 1px solid var(--card-border);
  color: var(--ink-secondary);
  border-radius: var(--r-sm);
  padding: 0.25rem 0.8rem;
  min-height: var(--tap);
  display: inline-flex;
  align-items: center;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.action:hover:not(:disabled) {
  color: var(--ink);
  border-color: var(--baseline);
}

.action:disabled {
  opacity: 0.5;
  cursor: default;
}

.danger {
  border-color: var(--status-critical-ink);
  color: var(--status-critical-ink);
}

.notice {
  margin: 0;
  padding: var(--pad);
  color: var(--ink);
}

.band {
  padding: var(--pad);
}

.band-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.5rem 1rem;
  margin-bottom: 0.4rem;
}

.band-head h3 {
  margin: 0;
}

.window {
  margin: 0 0 0.9rem;
}

.unmeasured {
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--gridline);
}

.unmeasured .copy,
.crosscheck .copy {
  margin: 0.35rem 0 0;
}

.crosscheck {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem 0.9rem;
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--gridline);
}

.crosscheck .numbers {
  color: var(--ink-secondary);
}

.crosscheck .copy {
  flex-basis: 100%;
}

.instant {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.5rem;
  margin: 0.75rem 0 0.35rem;
  color: var(--ink-secondary);
}

.scrub .copy {
  margin: 0;
}

summary {
  cursor: pointer;
  min-height: var(--tap);
  display: flex;
  align-items: center;
}

.table-scroll {
  overflow-x: auto;
}

.twin {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 0.8125rem;
  margin-top: 0.5rem;
}

.twin caption {
  text-align: left;
  margin-bottom: 0.5rem;
}

.twin th,
.twin td {
  text-align: right;
  padding: 0.2rem 0.5rem;
  border-bottom: 1px solid var(--gridline);
}

.twin th:first-child,
.twin td:first-child {
  text-align: left;
}

.twin th {
  color: var(--ink-muted);
  font-weight: 500;
}

.paging {
  margin-top: 0.75rem;
}
</style>
