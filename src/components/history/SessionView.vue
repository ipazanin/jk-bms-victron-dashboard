<script setup lang="ts">
/**
 * One session, in the reading order: claim, proof, evidence, moment, narrative, numbers.
 *
 * The ledger comes first because it is the answer; the coverage tape comes immediately after it
 * because it is what makes the ledger's window sentence checkable rather than a disclaimer; the
 * ribbon is the same claim with time added. Then the scrub readout, which is the thesis made
 * operable — the archive is the dashboard with a time control, so it is the real `ShuntAmmeter`
 * fed from a stored instant rather than a second instrument that happens to look similar.
 *
 * Nothing here re-runs the alarm engine. The entries carry the annunciator's own words as they
 * read at the time, and grading an hours-old spread against today's thresholds would annunciate a
 * past that never happened that way.
 */
import { computed, ref, watch } from 'vue'

import CoverageTape from './CoverageTape.vue'
import EntryList from './EntryList.vue'
import SessionRibbon from './SessionRibbon.vue'
import ShuntLedger from './ShuntLedger.vue'
import ShuntAmmeter from '../ShuntAmmeter.vue'
import StatusChip from '../StatusChip.vue'
import { useHistoryBrowser } from '../../application/history/historyBrowser'
import { hashOf, navigate, route } from '../../application/route'
import { useMediaQuery } from '../../application/useMediaQuery'
import { deriveHouse } from '../../domain/dcBus'
import { MAX_SAMPLE_GAP_MS } from '../../domain/history/join'
import type { PairedSample } from '../../domain/history/join'
import type { SessionId, TimeWindow } from '../../domain/history/types'

/** Optional because the route already carries it. Bind it when the shell has the id to hand. */
const props = defineProps<{ id?: SessionId }>()

const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000
const BYTES_PER_MB = 1_000_000

/** The cross-check agrees within the looser of an absolute floor and a proportional band: 2 Ah is
 *  below what a 1 Hz integral can resolve on a 280 Ah bank, and 10% is what a real day drifts. */
const CROSS_CHECK_FLOOR_AH = 2
const CROSS_CHECK_FRACTION = 0.1

const TABLE_PAGE_ROWS = 240

const browser = useHistoryBrowser()
const { loaded, loading, missing, failure, account, selection, exportSize, exportState } = browser

const compact = useMediaQuery('(max-width: 720px)')

const cursorAt = ref<number | null>(null)
const confirmingDelete = ref(false)
const tableStart = ref(0)

/**
 * Which session this is, taken from the route rather than from a prop. Loading and unloading it
 * belongs to whatever owns the route: the decoded samples are tens of megabytes and the hold that
 * keeps pruning off them outlives this component, so a second owner here would fight the first.
 * All this view does with the id is reset what it has scrolled and scrubbed.
 */
const sessionId = computed<SessionId | null>(
  () => props.id || (route.value.name === 'session' ? route.value.id : null),
)

watch(sessionId, () => {
  cursorAt.value = null
  confirmingDelete.value = false
  tableStart.value = 0
})

const record = computed(() => loaded.value?.record ?? null)

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

/** Re-integrated over the brush when there is one, which is the whole point of the brush. */
const ledger = computed(() => account.value?.ledger ?? null)

/** Never the brushed runs: the tape is the control the brush is drawn on, so it has to keep
 *  showing the whole session or a selection could not be widened again. */
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

/** The window sentence, printed BEFORE the figures rather than as a footnote after them. */
const windowSentence = computed(() => {
  const folded = ledger.value
  if (folded === null) return ''
  return `Both radios agreed for ${spacedSpan(folded.countedMs)} of the ${spacedSpan(brushedMs.value)}. Only that window is counted.`
})

const brushedMs = computed(() => {
  const window = selection.value
  return window === null ? sessionMs.value : window.to - window.from
})

const ledgerHeading = computed(() => {
  const window = selection.value
  if (window === null) return 'Session ledger'
  return `Ledger · ${clock(window.from)} → ${clock(window.to)}`
})

/** How long the pack took more than the panels gave. Null when it never did, which is the only
 *  case where the ledger draws no unmeasured bar and there is nothing to explain. */
const foreignMs = computed(() => {
  const folded = ledger.value
  return folded === null || folded.foreignAhFloor <= 0 ? null : folded.foreignMs
})

/**
 * Our integral against the BMS's own coulomb counter, over a deliberately different window: the
 * whole pack-up time, since pack current is known whenever the BMS is up. It reads the stored
 * ledger and never the brushed one — a brush narrows what is counted, and the caption promising
 * the whole session would then be printed over a figure taken from part of it.
 *
 * It uses remainingCapacity rather than stateOfCharge, which quantises at 1%: on a 280 Ah bank
 * that is 2.8 Ah, and a `Δ 0.3 Ah ✓` claim would be beyond what the measurement can support.
 */
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

/**
 * The deepest instant of the session, which is what the readout shows with no cursor: it is the
 * one moment a reader would otherwise have to hunt for, and the session already knows it.
 */
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

/** Shaped once per page rather than in the template, where each cell would re-difference the row. */
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
  return `Rows ${grouped(first)}–${grouped(last)} of ${grouped(rows)}, oldest first`
})

const exportNote = computed(() => {
  const size = exportSize.value
  if (size === null) return ''
  return `Every sample exactly as the radios reported it. ${grouped(size.rows)} rows, about ${(size.bytes / BYTES_PER_MB).toFixed(1)} MB.`
})

function onScrub(at: number | null): void {
  cursorAt.value = at
}

/** One stored instant at a time, for a reader who cannot land a fingertip on a second. */
function stepCursor(direction: -1 | 1): void {
  const rows = loaded.value?.timeline ?? []
  if (rows.length === 0) return

  const at = activeAt.value
  const index = at === null ? 0 : indexNear(at)
  cursorAt.value = rows[Math.min(rows.length - 1, Math.max(0, index + direction))].at
}

/**
 * Slides the read window by half its width. The store returns at most a day per read, so a session
 * longer than that is browsed a window at a time rather than hydrated whole.
 */
function shiftWindow(direction: 'earlier' | 'later'): void {
  const session = sessionWindow.value
  const shown = loaded.value?.window
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
  if (id === null) return
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

/** Null inside a real hole: the nearest stored row is not a reading about this instant, and the
 *  readout must go blank rather than show a sample from minutes away as though it were now. */
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

function clock(at: number): string {
  const when = new Date(at)
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
}

function clockSeconds(at: number): string {
  return `${clock(at)}:${String(new Date(at).getSeconds()).padStart(2, '0')}`
}

/** `12 h 24 m`, `41 min`, `8 m` — the form that sits inside a sentence. */
function spacedSpan(elapsedMs: number): string {
  if (elapsedMs < MS_PER_MINUTE) return `${Math.round(elapsedMs / MS_PER_SECOND)} s`
  if (elapsedMs < MS_PER_HOUR) return `${Math.round(elapsedMs / MS_PER_MINUTE)} min`
  const days = Math.floor(elapsedMs / MS_PER_DAY)
  const hours = Math.floor((elapsedMs % MS_PER_DAY) / MS_PER_HOUR)
  const minutes = Math.round((elapsedMs % MS_PER_HOUR) / MS_PER_MINUTE)
  if (days > 0) return `${days} d ${hours} h ${minutes} m`
  return `${hours} h ${minutes} m`
}

/** `12h 24m`, for the header, where the span sits between two clock times. */
function tightSpan(elapsedMs: number): string {
  const minutes = Math.round(elapsedMs / MS_PER_MINUTE)
  const hours = Math.floor(minutes / 60)
  if (hours === 0) return `${minutes}m`
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** The sign is decided after rounding, so a figure that rounds to zero carries no direction. */
function signedAh(value: number, digits = 1): string {
  const rounded = Number(value.toFixed(digits))
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : ''
  return `${sign}${Math.abs(rounded).toFixed(digits)} Ah`
}

/** Non-breaking spaces, so a row count never wraps across the gap between its own digits. */
function grouped(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
</script>

<template>
  <section class="session">
    <header class="head">
      <a class="back" :href="hashOf({ name: 'log' })">‹ Log</a>

      <template v-if="loaded && record && sessionWindow">
        <h2 class="title">
          {{ loaded.label }} · {{ dayWords(record.startedAt) }} ·
          {{ clock(sessionWindow.from) }} → {{ clock(sessionWindow.to) }} ·
          {{ tightSpan(sessionMs) }}
        </h2>
        <p class="readout facts">
          {{ grouped(totalSamples) }} samples at 1 Hz ·
          {{ silences.count }} {{ silences.count === 1 ? 'gap' : 'gaps' }} totalling
          {{ spacedSpan(silences.total) }}<template v-if="identityLine"> · {{ identityLine }}</template>
        </p>
        <p v-if="totalSamples === 0" class="copy">
          No samples. The BMS connected but sent nothing before the link went quiet.
        </p>
        <p v-if="loaded.unreadableChunks > 0" class="copy">
          This browser holds a log recorded by a newer version of this page. It is left untouched.
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
        <button type="button" class="action" @click="confirmingDelete = true">Delete session</button>
        <button type="button" class="action" @click="navigate({ name: 'dashboard' })">
          Back to live
        </button>
      </div>

      <p v-if="exportState === 'done'" class="copy" role="status">Downloaded.</p>
      <p v-else-if="exportNote" class="copy">{{ exportNote }}</p>

      <div v-if="confirmingDelete && record" class="confirm">
        <p class="copy">
          Delete this session? {{ spacedSpan(sessionMs) }}, {{ grouped(totalSamples) }} samples.
          This cannot be undone.
        </p>
        <button type="button" class="action danger" @click="remove()">Delete</button>
        <button type="button" class="action" @click="confirmingDelete = false">Keep</button>
      </div>
    </header>

    <p v-if="missing !== null" class="notice copy" role="status">
      That session was dropped to make room.
    </p>
    <p v-else-if="failure !== null" class="notice copy" role="status">{{ failure }}</p>
    <p v-else-if="loading && !loaded" class="notice copy" role="status">Reading the session…</p>

    <template v-if="loaded && record && ledger">
      <section class="band">
        <header class="band-head">
          <h3 class="plate">{{ ledgerHeading }}</h3>
          <p class="muted">house = solar − pack, integrated</p>
        </header>
        <p class="copy window">{{ windowSentence }}</p>

        <ShuntLedger :ledger="ledger" :solar-seen="solarSeen" />

        <!-- The figure and its ≥ are on the bar itself, inside the ledger; this is only the
             sentence that says what the floor is a floor on. -->
        <div v-if="foreignMs !== null" class="unmeasured">
          <details v-if="compact">
            <summary class="copy">Why this is a floor</summary>
            <p class="copy">
              The pack took more than the panels gave for {{ spacedSpan(foreignMs) }} — an
              alternator or shore charger was on the bus. This is a floor: the house was drawing at
              the same time, so the real figure is higher.
            </p>
          </details>
          <p v-else class="copy">
            The pack took more than the panels gave for {{ spacedSpan(foreignMs) }} — an
            alternator or shore charger was on the bus. This is a floor: the house was drawing at
            the same time, so the real figure is higher.
          </p>
        </div>

        <div v-if="crossCheck" class="crosscheck">
          <span class="plate">Charge cross-check</span>
          <span class="muted">over the whole {{ spacedSpan(sessionMs) }}, not the counted window</span>
          <span class="readout numbers">
            integrated {{ signedAh(crossCheck.integrated) }} · BMS counted
            {{ crossCheck.first.toFixed(1) }} → {{ crossCheck.last.toFixed(1) }} Ah =
            {{ signedAh(crossCheck.counted) }} · Δ {{ Math.abs(crossCheck.delta).toFixed(1) }} Ah
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

      <CoverageTape
        :coverage="coverage"
        :window="loaded.window"
        :selection="selection"
        :cursor-at="cursorAt"
        @select="browser.select($event)"
        @scrub="onScrub"
      />

      <SessionRibbon
        :timeline="loaded.timeline"
        :window="loaded.window"
        :cursor-at="cursorAt"
        :cursor-sample="activeSample"
        :window-clamped="loaded.windowClamped"
        :session-ms="sessionMs"
        @scrub="onScrub"
        @shift="shiftWindow"
      />

      <section class="band scrub">
        <header class="band-head">
          <h3 class="plate">
            <template v-if="activeAt === null">At —</template>
            <template v-else>At {{ clockSeconds(activeAt) }}</template>
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

      <EntryList :entries="record.entries" :cursor-at="cursorAt" @scrub="onScrub" />

      <section class="band">
        <details>
          <summary class="plate">Show the numbers</summary>

          <table class="twin">
            <caption class="muted">{{ tableCaption }}</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Pack A</th>
                <th scope="col">Solar A</th>
                <th scope="col">House A</th>
                <th scope="col">House W</th>
                <th scope="col">SOC %</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in tableRows" :key="row.at">
                <td>{{ clockSeconds(row.at) }}</td>
                <td>{{ row.packA }}</td>
                <td>{{ row.solarA }}</td>
                <td>{{ row.houseA }}</td>
                <td>{{ row.houseW }}</td>
                <td>{{ row.stateOfCharge }}</td>
              </tr>
            </tbody>
          </table>

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
  background: var(--surface);
}

.head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 1.25rem var(--pad);
  border-bottom: 1px solid var(--gridline);
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
  border: 1px solid var(--gridline);
  color: var(--ink-secondary);
  border-radius: 2px;
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
  padding: 0.75rem var(--pad);
  border-bottom: 1px solid var(--gridline);
  color: var(--ink);
}

.band {
  padding: var(--pad);
  border-top: 1px solid var(--gridline);
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
