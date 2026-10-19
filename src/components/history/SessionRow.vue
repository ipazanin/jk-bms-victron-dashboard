<script setup lang="ts">
import { computed } from 'vue'

import { ampHoursSigned, clockTime } from '../../application/format'
import { useArchiveWorkspace } from '../../application/backup/useArchiveWorkspace'

import type { SessionListing } from '../../application/history/port'
import { hashOf } from '../../application/route'
import { clockBandFor, coverageSegments, linearScale } from '../../domain/history/geometry'
import type { CoverageClass, CoverageRun, SessionRecord } from '../../domain/history/types'

const { readOnly } = useArchiveWorkspace()

const props = defineProps<{
  listing: SessionListing

  now: number
}>()

const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

const MIN_RUN_PERCENT = 0.4

const COVERAGE_NAMES: Readonly<Record<CoverageClass, string>> = {
  both: 'both radios',
  'pack-only': 'pack only',
  'solar-only': 'solar only',
  foreign: 'another source',
  none: 'no data',
}

const record = computed(() => props.listing.record)

const endedAt = computed(() => record.value.endedAt ?? props.now)

const lengthMs = computed(() => {
  const span = endedAt.value - record.value.startedAt
  if (span > 0) return span
  return Math.max(record.value.packSamples, record.value.solarSamples) * MS_PER_SECOND
})

const band = computed(() => clockBandFor(record.value.startedAt, endedAt.value))

const segments = computed(() => {
  const window = { from: band.value.from, to: band.value.to }
  const scale = linearScale(window.from, window.to, 0, 100)
  const runs: CoverageRun[] = []

  for (const run of record.value.coverage) runs.push(run)

  return coverageSegments(runs, window, scale, MIN_RUN_PERCENT)
})

const midnight = computed(() => band.value.ticks.find((tick) => tick.hour === 0) ?? null)

const solarSeen = computed(() => record.value.solarSamples > 0)

const houseOutAh = computed(() => {
  const ledger = record.value.ledger
  return -(ledger.solarAh - ledger.packAh)
})

const trimmedMs = computed(() => {
  const retainedFrom = record.value.retainedFrom
  if (retainedFrom === null) return null
  const cut = retainedFrom - record.value.startedAt
  return cut > 0 ? cut : null
})

const coverageSentence = computed(() => {
  const totals = new Map<CoverageClass, number>()
  for (const run of record.value.coverage) {
    totals.set(run.kind, (totals.get(run.kind) ?? 0) + (run.to - run.from))
  }
  const parts: string[] = []
  for (const [kind, total] of totals) parts.push(`${COVERAGE_NAMES[kind]} ${spacedSpan(total)}`)
  return parts.length === 0 ? 'No coverage recorded.' : `Coverage: ${parts.join(', ')}.`
})

function dayWords(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

function compactSpan(elapsedMs: number): string {
  const minutes = Math.round(elapsedMs / MS_PER_MINUTE)
  const hours = Math.floor(minutes / 60)
  if (hours === 0) return `${minutes}m`
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

function spacedSpan(elapsedMs: number): string {
  const days = Math.floor(elapsedMs / MS_PER_DAY)
  const hours = Math.floor((elapsedMs % MS_PER_DAY) / MS_PER_HOUR)
  const minutes = Math.round((elapsedMs % MS_PER_HOUR) / MS_PER_MINUTE)
  if (days > 0) return `${days} d ${hours} h ${minutes} m`
  if (hours > 0) return `${hours} h ${minutes} m`
  return `${minutes} m`
}

function stopwatch(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / MS_PER_SECOND))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function stateOfChargeWords(row: SessionRecord): string {
  const first = row.ledger.stateOfChargeFirst
  const last = row.ledger.stateOfChargeLast
  if (first === null || last === null) return '—'
  return `${first}→${last} %`
}
</script>

<template>
  <a class="row" :href="hashOf({ name: 'session', id: record.id })">
    <span class="cell watch">
      <span class="day">{{ dayWords(record.startedAt) }}</span>
      <span class="clock">{{ clockTime(record.startedAt) }}→{{ clockTime(endedAt) }}</span>
    </span>

    <span class="cell figure length">
      <span class="cell-label">Length</span>
      <span v-if="record.state === 'open'" class="live">{{ readOnly ? 'Open at capture' : 'Recording' }} · {{ stopwatch(lengthMs) }}</span>
      <span v-else>{{ compactSpan(lengthMs) }}</span>
    </span>

    <span class="cell figure">
      <span class="cell-label">Solar in</span>
      <span class="solar-ink">{{ solarSeen ? ampHoursSigned(record.ledger.solarAh) : '—' }}</span>
    </span>

    <span class="cell figure">
      <span class="cell-label">Boat out</span>
      <span class="house-ink">{{ solarSeen ? ampHoursSigned(houseOutAh) : '—' }}</span>
    </span>

    <span class="cell figure pack">
      <span class="cell-label">Pack</span>
      <span>{{ stateOfChargeWords(record) }}</span>
      <span class="pack-ink">{{ ampHoursSigned(record.ledger.packAhWholeSession) }}</span>
    </span>

    <span class="chevron" aria-hidden="true">›</span>

    <span class="band" role="img" :aria-label="coverageSentence">
      <span
        v-for="(segment, index) in segments"
        :key="`${segment.kind}-${index}`"
        class="run"
        :class="segment.kind"
        :style="{ left: `${segment.x}%`, width: `${segment.width}%` }"
        :title="COVERAGE_NAMES[segment.kind]"
      />
      <span
        v-if="midnight"
        class="seam"
        :style="{ left: `${midnight.position * 100}%` }"
        aria-hidden="true"
      />
    </span>

    <span v-if="band.clipped" class="note copy">
      <span aria-hidden="true">»&nbsp;</span>
      <template v-if="lengthMs > MS_PER_DAY">longer than a day — {{ spacedSpan(lengthMs) }}</template>
      <template v-else>{{ spacedSpan(lengthMs) }} — the band shows the part that fits.</template>
    </span>
    <span v-if="trimmedMs !== null" class="note copy">
      Raw samples from the first {{ spacedSpan(trimmedMs) }} are no longer retained here. Hourly history may still cover that time.
    </span>
    <span v-if="record.continues !== null" class="note copy">
      Continues the session above, after this tab was closed.
    </span>
  </a>
</template>

<style scoped>

.row {
  display: grid;
  grid-template-columns: var(
    --session-columns,
    minmax(11rem, 1.6fr) 6.5rem 6.5rem 6.5rem 9rem 1.25rem
  );
  align-items: baseline;
  column-gap: 1rem;
  row-gap: 0.35rem;
  padding: 0.6rem 0;
  min-height: var(--tap);
  border-top: 1px solid var(--gridline);
  color: inherit;
  text-decoration: none;
}

.row:hover {
  background: var(--raised);
}

.cell {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 0.875rem;
  display: flex;
  gap: 0.5rem;
  min-width: 0;
}

.watch {
  color: var(--ink);
}

.clock {
  color: var(--ink-secondary);
}

.figure {
  justify-content: flex-end;
  text-align: right;
  white-space: nowrap;
}

.pack {
  gap: 0.75rem;
}

.live {
  color: var(--ink-secondary);
}

.pack-ink {
  color: var(--pack-ink);
}
.solar-ink {
  color: var(--solar-ink);
}
.house-ink {
  color: var(--house-ink);
}

.cell-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.chevron {
  color: var(--ink-muted);
  text-align: right;
}

.band {
  grid-column: 1 / -1;
  position: relative;
  display: block;
  height: 8px;
  margin-top: 0.2rem;
}

.run {
  position: absolute;
  bottom: 0;
  height: 8px;
}

.run.both {
  background: var(--coverage-both);
}

.run.pack-only {
  background: var(--coverage-partial);
}

.run.solar-only {
  height: 4px;
  background: var(--coverage-partial);
}

.run.foreign {
  background:
    repeating-linear-gradient(
      45deg,
      transparent 0 3px,
      var(--surface) 3px 5px
    ),
    var(--coverage-both);
}

.run.none {
  height: 1px;
  background: var(--coverage-none);
}

.seam {
  position: absolute;
  bottom: 0;
  height: 10px;
  width: 1px;
  background: var(--baseline);
}

.note {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--ink-muted);
}

@container sessions (max-width: 48rem) {
  .row {
    grid-template-columns: 1fr 1fr 1fr;
    column-gap: 0.75rem;
  }

  .watch {
    grid-column: 1 / 3;
    flex-direction: column;
    gap: 0;
  }

  .length {
    justify-content: flex-end;
  }

  .band {
    order: 1;
  }

  .figure:not(.length) {
    order: 2;
    flex-direction: column;
    align-items: flex-start;
    text-align: left;
    gap: 0.15rem;
  }

  .figure:not(.length) > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pack {
    align-items: flex-start;
  }

  .chevron {
    display: none;
  }

  .note {
    order: 3;
  }

  .cell-label {
    position: static;
    width: auto;
    height: auto;
    clip-path: none;
    font-family: var(--font-label);
    font-size: 0.6875rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-muted);
  }
}
</style>
