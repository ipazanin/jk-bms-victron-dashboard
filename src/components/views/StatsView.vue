<script setup lang="ts">
/**
 * History, scoped to a range the reader chooses.
 *
 * One filter row scopes every card below it. The summary tiles fold the range's headline figures;
 * the chart beneath them is range-appropriate — the short ranges (hour, day) get the per-sample
 * power timeline read across the window's sessions, the long ranges (week, month) get the daily
 * energy bars folded from cached ledgers, because the pack keeps no per-day series of its own. The
 * warnings-per-day card sits under both.
 *
 * Below the range-scoped cards are the two facts that belong to the pack rather than to a window:
 * the lifetime counters off whatever frame is on the instruments now, and the event logbook from
 * the last time this browser read one, kept so it can be reviewed off the boat.
 *
 * Last of all is a diagnostic that belongs to no window and is kept nowhere: an on-demand read of
 * the pack's stored detail log, which reports what the command produced rather than what it means.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import { ampHours, amps, duration, volts } from '../../application/format'
import { useHistoryBrowser } from '../../application/history/historyBrowser'
import {
  bucketUnitFor,
  chartForWindow,
  dailyBucketsIn,
  energyInOut,
  errorsPerDay,
  summarize,
  windowFor,
} from '../../application/history/statsRange'
import type { RangeKind } from '../../application/history/statsRange'
import type { DetailLogTransfer } from '../../domain/bms/DetailLogTransfer'
import type { TimeWindow } from '../../domain/history/types'
import { eventWallTime } from '../../application/logbook'
import { hashOf } from '../../application/route'
import { useTelemetry } from '../../application/telemetry'
import EnergyInOut from '../stats/EnergyInOut.vue'
import ErrorsPerDay from '../stats/ErrorsPerDay.vue'
import PowerTimeline from '../stats/PowerTimeline.vue'
import RangeFilter from '../stats/RangeFilter.vue'
import SummaryTiles from '../stats/SummaryTiles.vue'

const telemetry = useTelemetry()
const { battery, bmsState, detailLog, detailLogError, detailLogReading, device, logbook, readDetailLog, source } =
  telemetry
const browser = useHistoryBrowser()

/**
 * The default is the week, so the seeded few-day archive lands as bars on first paint. `now` is
 * frozen and refreshed only when a range is picked, never on a timer: a window recomputed every
 * second would reflow the whole page and trip the steadiness check.
 */
const range = ref<RangeKind>('week')
const now = ref(Date.now())

/**
 * The two dates behind the Custom range, owned here so the filter stays a pure control. Defaults to
 * the last seven days — the same span the Week preset covers — so switching to Custom moves nothing
 * until the reader picks a date.
 */
const customWindow = ref<TimeWindow>({ from: Date.now() - 6 * 86_400_000, to: Date.now() })

onMounted(() => {
  void browser.refresh().catch(() => undefined)
})

/** The Stats power read is this view's alone; releasing it on the way out lets pruning reclaim it. */
onUnmounted(() => browser.clearWindowPower())

function selectRange(kind: RangeKind): void {
  now.value = Date.now()
  range.value = kind
}

function selectCustom(window: TimeWindow): void {
  customWindow.value = window
  now.value = Date.now()
}

/** The archive's oldest instant feeds the All range; the picked dates feed Custom. */
const rangeWindow = computed(() =>
  windowFor(range.value, now.value, {
    oldest: browser.archive.value.oldestStartedAt,
    custom: customWindow.value,
  }),
)
/** A sub-day window reads per sample (PowerTimeline); a longer one folds into in/out bars. */
const chart = computed(() => chartForWindow(rangeWindow.value))
const bucketUnit = computed(() => bucketUnitFor(rangeWindow.value))

// ── range roll-ups (cheap; no chunk read) ───────────────────────────────────

const records = computed(() => browser.sessions.value.map((listing) => listing.record))
const buckets = computed(() => dailyBucketsIn(records.value, rangeWindow.value, now.value))
/** Energy in (solar) against out (house), bucketed at the range's own granularity, for the bar chart. */
const energyBuckets = computed(() => energyInOut(records.value, rangeWindow.value, bucketUnit.value))

/**
 * The uncapped warnings for the window when that read has resolved, else the capped browser list as
 * a non-blocking stand-in. Both summarize and errorsPerDay filter to the window, so the fallback is
 * exact for any range the recent 500 already cover and only undercounts a month over a large
 * archive — which is the read that resolves and corrects it.
 */
const rangeWarnings = computed(() => browser.windowWarnings.value ?? browser.warnings.value)
const summary = computed(() => summarize(buckets.value, rangeWarnings.value, rangeWindow.value))
const dailyErrors = computed(() => errorsPerDay(rangeWarnings.value, rangeWindow.value))

// ── per-sample power (short ranges only) ─────────────────────────────────────

const tracks = computed(() => browser.windowPower.value?.tracks ?? null)
const powerLoading = computed(() => browser.powerLoading.value)

/**
 * PowerTimeline labels its window 'hour' or 'day' by span, not by the range's name — a custom range
 * of a couple of hours reads as an hour, anything longer as a day. Only consumed under the 'power'
 * branch, so it is inert whenever the bars are showing.
 */
const powerRange = computed<'hour' | 'day'>(() =>
  rangeWindow.value.to - rangeWindow.value.from <= 90 * 60_000 ? 'hour' : 'day',
)

/**
 * A short range reads its window's samples across every overlapping session; a long range needs no
 * chunk at all. The uncapped warnings for the window are read for every range, so the tiles and the
 * per-day chart count the whole window rather than the capped recent list. Latest wins by token
 * inside the browser, so flicking between ranges supersedes a read still in flight.
 */
watch(
  rangeWindow,
  (window) => {
    void browser.loadWindowWarnings(window).catch(() => undefined)
    if (chartForWindow(window) === 'power') {
      void browser.loadWindowPower(window).catch(() => undefined)
    } else {
      browser.clearWindowPower()
    }
  },
  { immediate: true },
)

// ── lifetime counters ────────────────────────────────────────────────────────

const connectHref = hashOf({ name: 'connect' })

/** Present whenever a pack is on the instruments — live, remembered or a browsed session. */
const lifetime = computed(() => {
  const pack = battery.value
  const info = device.value
  if (pack === null && info === null) return null
  return {
    cycleCount: pack?.cycleCount ?? null,
    cycledCapacity: pack?.cycledCapacity ?? null,
    powerOnCount: info?.powerOnCount ?? null,
    uptimeSeconds: pack?.uptimeSeconds ?? info?.uptimeSeconds ?? null,
    model: info?.model ?? null,
  }
})

// ── device logbook ────────────────────────────────────────────────────────────

const stamp = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

/** Newest first, each with a real date when the boot instant is known, else elapsed-since-boot. */
const logbookRows = computed(() => {
  const stored = logbook.value
  if (stored === null) return []
  return [...stored.events].reverse().map((event) => {
    const wall = eventWallTime(stored, event)
    return {
      key: `${event.secondsSinceBoot}:${event.code}`,
      label: event.label,
      when: wall === null ? `+${duration(event.secondsSinceBoot)}` : stamp.format(wall),
    }
  })
})

const logbookAge = computed(() => {
  const stored = logbook.value
  if (stored === null) return null
  return stamp.format(stored.fetchedAt)
})

// ── stored detail log (diagnostic) ────────────────────────────────────────────

/**
 * The pack's counter rendered exactly as the pack holds it — read with UTC getters, no zone
 * applied, so it spells the pack's own zone on standard time. It is shown beside the resolved
 * instant because it is the one figure here that is a fact about the device rather than about the
 * offset the caller supplied.
 */
const packCounterFace = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function describeOutcome(transfer: DetailLogTransfer): string {
  const seconds = (transfer.elapsedMs / 1000).toFixed(1)
  if (transfer.outcome === 'no-answer') {
    return `Nothing came back — not one byte in ${seconds} s. The pack does not answer this command.`
  }
  if (transfer.outcome === 'torn-burst') {
    return `${transfer.notificationBytes} bytes arrived across ${transfer.notificationCount} notifications and not one frame assembled from them. The pack answered; the reply was torn up in transit.`
  }
  if (transfer.outcome === 'other-frames') {
    return `${transfer.frames.length} frames came back and none was a detail log. The command means something else on this firmware — the frame types below say what.`
  }
  return `${transfer.frames.length} frames, ${transfer.records.length} records, ${transfer.notificationBytes} bytes in ${seconds} s.`
}

const outcomeSentence = computed(() => {
  const transfer = detailLog.value
  return transfer === null ? null : describeOutcome(transfer)
})

/** One line per frame, so a whole burst's chunking can be read off a single run. */
const frameLines = computed(() => {
  const transfer = detailLog.value
  if (transfer === null) return []
  return transfer.frames.map((header, position) => ({
    key: position,
    text: `#${position} · type 0x${header.frameType.toString(16).padStart(2, '0')} · byte 5 0x${header.unidentifiedByte.toString(16).padStart(2, '0')} · first record ${header.firstRecordIndex} · carries ${header.recordCount}`,
  }))
})

/** By the pack's own counter rather than by ring index, which wraps and can be read out of order. */
const newestRecord = computed(() => {
  const transfer = detailLog.value
  if (transfer === null || transfer.records.length === 0) return null
  return transfer.records.reduce((newest, record) => (record.packClockMs > newest.packClockMs ? record : newest))
})
</script>

<template>
  <section class="stats" data-testid="stats-view">
    <header class="head">
      <h2 class="head-title">Stats &amp; history</h2>
      <p class="copy head-sub">
        Recorded energy, warnings and the pack's own logbook — scoped to a range you choose.
      </p>
    </header>

    <div class="body">
      <!-- One filter row scopes every card below it. -->
      <RangeFilter
        :model-value="range"
        :custom="customWindow"
        @update:model-value="selectRange"
        @update:custom="selectCustom"
      />

      <SummaryTiles :summary="summary" />

      <!-- Range-appropriate chart: a sub-day window reads per sample, a longer one folds to in/out bars. -->
      <section class="chart-section" aria-labelledby="chart-title">
        <h3 id="chart-title" class="section-title">
          {{ chart === 'bars' ? 'Energy over time' : 'Power over time' }}
        </h3>
        <PowerTimeline
          v-if="chart === 'power'"
          :tracks="tracks"
          :range="powerRange"
          :loading="powerLoading"
        />
        <EnergyInOut v-else :buckets="energyBuckets" :unit="bucketUnit" :estimated="true" />
      </section>

      <ErrorsPerDay :days="dailyErrors" :range="range" />

      <!-- Lifetime counters, straight off the pack. -->
      <section v-if="lifetime !== null" class="card">
        <header class="card-head">
          <h3 class="plate">Lifetime</h3>
          <p class="muted">Since the pack was commissioned{{ lifetime.model ? ` · ${lifetime.model}` : '' }}</p>
        </header>
        <dl class="lifetime-tiles">
          <div v-if="lifetime.cycleCount !== null" class="chip">
            <dt>Cycles</dt>
            <dd class="secondary-figure">{{ lifetime.cycleCount }}</dd>
          </div>
          <div v-if="lifetime.cycledCapacity !== null" class="chip">
            <dt>Cycled capacity</dt>
            <dd class="secondary-figure">{{ ampHours(lifetime.cycledCapacity, 0) }}</dd>
          </div>
          <div v-if="lifetime.powerOnCount !== null" class="chip">
            <dt>Power-ons</dt>
            <dd class="secondary-figure">{{ lifetime.powerOnCount }}</dd>
          </div>
          <div v-if="lifetime.uptimeSeconds !== null" class="chip">
            <dt>Uptime</dt>
            <dd class="secondary-figure">{{ duration(lifetime.uptimeSeconds) }}</dd>
          </div>
        </dl>
      </section>

      <!-- The device's own event log. -->
      <section class="card">
        <header class="card-head">
          <h3 class="plate">Device logbook</h3>
          <p v-if="logbookAge !== null" class="muted">
            Read from the pack {{ logbookAge }}. Power cycles and protection events, back to first power-on.
          </p>
        </header>

        <p v-if="logbookRows.length === 0" class="copy state">
          <template v-if="source === 'live'">Waiting for the pack to send its logbook…</template>
          <template v-else>
            No logbook read yet. <a :href="connectHref">Connect the BMS</a> and it is fetched
            automatically; it then stays here for review.
          </template>
        </p>

        <ul v-else class="logbook">
          <li v-for="row in logbookRows" :key="row.key" class="event">
            <span class="when readout">{{ row.when }}</span>
            <span class="what">{{ row.label }}</span>
          </li>
        </ul>
      </section>

      <!-- The pack's other store, read on demand and kept nowhere. -->
      <section class="card">
        <header class="card-head">
          <h3 class="plate">Stored detail log</h3>
          <p class="muted">
            Asks the pack for its own ring of sampled snapshots. Nothing is saved — what this reports
            is what came back, counted in raw notification bytes.
          </p>
        </header>

        <div class="actions">
          <button
            type="button"
            :disabled="bmsState !== 'live' || detailLogReading"
            @click="readDetailLog()"
          >
            {{ detailLogReading ? 'Reading…' : 'Read stored log' }}
          </button>
          <span v-if="bmsState !== 'live'" class="muted">Connect the BMS first.</span>
          <span v-else-if="detailLogReading" class="muted">
            Waiting on the pack. It has up to thirty seconds, and ends early once the reply goes quiet.
          </span>
        </div>

        <p v-if="detailLogError !== null" class="copy failure">{{ detailLogError }}</p>

        <template v-if="detailLog !== null">
          <p class="copy outcome">{{ outcomeSentence }}</p>

          <dl class="lifetime-tiles">
            <div class="chip">
              <dt>Raw bytes</dt>
              <dd class="secondary-figure">{{ detailLog.notificationBytes }}</dd>
            </div>
            <div class="chip">
              <dt>Notifications</dt>
              <dd class="secondary-figure">{{ detailLog.notificationCount }}</dd>
            </div>
            <div class="chip">
              <dt>Frames</dt>
              <dd class="secondary-figure">{{ detailLog.frames.length }}</dd>
            </div>
            <div class="chip">
              <dt>Elapsed</dt>
              <dd class="secondary-figure">{{ (detailLog.elapsedMs / 1000).toFixed(1) }} s</dd>
            </div>
          </dl>

          <ul v-if="frameLines.length > 0" class="frames">
            <li v-for="line in frameLines" :key="line.key" class="readout frame">{{ line.text }}</li>
          </ul>

          <!-- The layout check, on screen rather than left to be remembered: the newest stored
               snapshot beside what the instruments read right now. Wrong offsets or a wrong stride
               show up here as a voltage and a current that do not match the pack in front of you. -->
          <div v-if="newestRecord !== null" class="compare">
            <p class="muted">
              Newest stored record, ring index {{ newestRecord.index }}. Pack counter reads
              <span class="readout">{{ packCounterFace.format(newestRecord.packClockMs) }}</span> —
              resolved against this browser's standard offset that is
              <span class="readout">{{ stamp.format(newestRecord.recordedAt) }}</span
              >.
            </p>
            <dl class="lifetime-tiles">
              <div class="chip">
                <dt>Stored pack voltage</dt>
                <dd class="secondary-figure">{{ volts(newestRecord.packVoltage, 2) }}</dd>
              </div>
              <div class="chip">
                <dt>Live pack voltage</dt>
                <dd class="secondary-figure">{{ battery === null ? '—' : volts(battery.packVoltage, 2) }}</dd>
              </div>
              <div class="chip">
                <dt>Stored current</dt>
                <dd class="secondary-figure">{{ amps(newestRecord.current) }}</dd>
              </div>
              <div class="chip">
                <dt>Live current</dt>
                <dd class="secondary-figure">{{ battery === null ? '—' : amps(battery.current) }}</dd>
              </div>
            </dl>
          </div>
        </template>
      </section>
    </div>
  </section>
</template>

<style scoped>
.stats {
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

.body {
  display: flex;
  flex-direction: column;
  gap: clamp(1rem, 2.5vw, 1.5rem);
  padding: 1.25rem var(--pad) 2.5rem;
}

/* The chart's section label, sentence-case so it reads as a grouping heading distinct from the
   card's own uppercase plate title. */
.chart-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.section-title {
  margin: 0;
  font-family: var(--font-label);
  font-weight: 600;
  font-size: 0.9375rem;
  letter-spacing: 0.01em;
  color: var(--ink-secondary);
}

/* Cards — the warm container the instruments sit in. */
.card {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
  padding: var(--pad);
}

.card-head {
  margin-bottom: 1rem;
}

.card-head h3 {
  margin: 0;
}

.card-head .muted {
  margin: 0.35rem 0 0;
}

.state {
  margin: 0;
}

.state a {
  color: var(--pack-ink);
}

/* Lifetime — inset chips on the card, a step down from the summary tiles above. */
.lifetime-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.75rem;
  margin: 0;
}

.chip {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.85rem 0.95rem;
  background: var(--raised);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
}

.chip dt {
  font-family: var(--font-label);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
}

.chip dd {
  margin: 0;
  color: var(--ink);
}

/* Logbook */
.logbook {
  list-style: none;
  margin: 0;
  padding: 0;
}

.event {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--gridline);
}

.event:first-child {
  padding-top: 0;
}

.event:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.when {
  flex: none;
  width: 8.5rem;
  color: var(--ink-muted);
  font-size: 0.8125rem;
}

.what {
  color: var(--ink);
}

/* Stored detail log */
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}

.actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--card-border);
  color: var(--ink);
  border-radius: var(--r-sm);
  padding: 0.6rem 1rem;
  min-height: var(--tap);
  font-family: var(--font-label);
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 600;
}

.actions button:hover:not(:disabled) {
  border-color: var(--ink-secondary);
}

.actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.outcome {
  margin: 1rem 0;
}

.failure {
  margin: 1rem 0 0;
  color: var(--status-serious);
}

/* The frame headers are the paging evidence, so all of them are listed; the box scrolls rather
   than pushing the comparison below it off the screen. */
.frames {
  list-style: none;
  margin: 1rem 0 0;
  padding: 0.6rem 0.75rem;
  background: var(--raised);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  max-height: 12rem;
  overflow: auto;
}

.frame {
  font-size: 0.75rem;
  color: var(--ink-secondary);
  white-space: nowrap;
}

.compare {
  margin-top: 1.25rem;
  padding-top: 1rem;
  border-top: 1px solid var(--gridline);
}

.compare > .muted {
  margin: 0 0 0.85rem;
}

@container (max-width: 560px) {
  .when {
    width: 6.5rem;
  }
}
</style>
