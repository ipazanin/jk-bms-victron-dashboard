<script setup lang="ts">
/**
 * One device and everything it recorded.
 *
 * The header carries no lifetime amp-hour figures, deliberately. Summing N ledgers would sum N
 * different windows — each session counts only the span where both radios agreed — and the total
 * would be presented here without the caveat the session view is scrupulous about one scroll
 * below. Sessions and hours are honest at this altitude; charge is not.
 *
 * The noon-to-noon ruler is drawn once for the group rather than under every row, because it is
 * the same ruler for all of them and repeating it would put four more look-alike verticals between
 * every pair of watches.
 */
import { computed } from 'vue'

import DeviceName from '../DeviceName.vue'
import SessionRow from './SessionRow.vue'
import type { SessionGroup } from '../../application/history/historyBrowser'
import { CLOCK_BAND_TICK_HOURS } from '../../domain/history/geometry'
import { deviceLabel } from '../../domain/history/identity'
import type { DeviceKey } from '../../domain/history/types'

const props = defineProps<{
  group: SessionGroup
  now: number
  /** Sticky only when the archive holds more than one device: with one there is nothing to lose
   *  track of, and a bar pinned to the top of a short list is just lost height. */
  sticky: boolean
}>()

const emit = defineEmits<{ rename: [DeviceKey, string | null] }>()

const MS_PER_HOUR = 3_600_000
const MS_PER_MINUTE = 60_000

const device = computed(() => props.group.device)

const isSolar = computed(() => device.value?.kind === 'solar')

const defaultLabel = computed(() => device.value?.defaultLabel ?? props.group.label)

/** The line under the name: what the hardware said about itself, never what we inferred. */
const identity = computed(() => {
  const record = device.value
  if (record === null) return null
  if (record.kind === 'solar') return 'Named by its encryption key. The key itself is never stored.'
  if (record.model === null || record.serialNumber === null) {
    return 'Bluetooth name only — this pack never sent its model or serial.'
  }
  return `${record.model} · SN ${record.serialNumber}`
})

const totals = computed(() => {
  const count = props.group.sessions.length
  return `${count} ${count === 1 ? 'session' : 'sessions'} · ${spacedTotal(props.group.recordedMs)}`
})

/** `54 h 02 m`. Minutes are padded so the column of totals down the page rules itself. */
function spacedTotal(elapsedMs: number): string {
  const hours = Math.floor(elapsedMs / MS_PER_HOUR)
  const minutes = Math.round((elapsedMs % MS_PER_HOUR) / MS_PER_MINUTE)
  if (hours === 0) return `${minutes} m`
  return `${hours} h ${String(minutes).padStart(2, '0')} m`
}
</script>

<template>
  <section class="group">
    <header class="head" :class="{ sticky }">
      <div class="naming">
        <h3 class="secondary-figure">{{ deviceLabel(device, group.label) }}</h3>
        <DeviceName
          :label="deviceLabel(device, group.label)"
          :default-label="defaultLabel"
          :noun="isSolar ? 'controller' : 'pack'"
          @rename="(label) => emit('rename', group.key, label)"
        />
      </div>
      <p v-if="identity" class="readout identity">{{ identity }}</p>
      <p class="readout totals">{{ totals }}</p>
    </header>

    <div class="columns">
      <span class="plate">Watch</span>
      <span class="plate right">Length</span>
      <span class="plate right">Solar in</span>
      <span class="plate right">House out</span>
      <span class="plate right">Pack</span>
      <span aria-hidden="true" />
    </div>

    <!--
      The shared ruler sits at quarter positions. A clock change makes one row's own midnight seam
      fall a little off this ruler; the row draws its seam where it really is, and this stays a
      legend for the band's structure rather than a scale claiming to measure it.
    -->
    <div class="ruler" aria-hidden="true">
      <span
        v-for="(hour, index) in CLOCK_BAND_TICK_HOURS"
        :key="index"
        class="tick"
        :style="{ left: `${(index / (CLOCK_BAND_TICK_HOURS.length - 1)) * 100}%` }"
      >
        {{ String(hour).padStart(2, '0') }}
      </span>
    </div>

    <SessionRow
      v-for="listing in group.sessions"
      :key="listing.record.id"
      :listing="listing"
      :now="now"
    />

    <p class="legend readout">
      <span class="key"><b class="glyph both">██</b> both radios</span>
      <span class="key"><b class="glyph partial">▒▒</b> pack only</span>
      <span class="key"><b class="glyph partial">▁▁</b> solar only</span>
      <span class="key"><b class="glyph both">▨▨</b> another source</span>
      <span class="key"><b class="glyph none">··</b> no data</span>
    </p>
  </section>
</template>

<style scoped>
/*
 * One declaration rules the column header and every row in the group: SessionRow reads this
 * inherited custom property, so the two can never be edited apart.
 */
.group {
  --session-columns: minmax(11rem, 1.6fr) 6.5rem 6.5rem 6.5rem 9rem 1.25rem;
  padding: 0 var(--pad) 1.25rem;
}

.head {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  column-gap: 1rem;
  padding: 1rem 0 0.75rem;
  background: var(--surface);
}

.sticky {
  position: sticky;
  top: 0;
  z-index: 1;
  border-bottom: 1px solid var(--gridline);
}

.naming {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.75rem;
  min-width: 0;
}

h3 {
  margin: 0;
}

.identity {
  grid-column: 1;
  margin: 0.15rem 0 0;
  font-size: 0.8125rem;
  color: var(--ink-muted);
}

.totals {
  grid-row: 1;
  grid-column: 2;
  margin: 0;
  text-align: right;
  color: var(--ink-secondary);
  white-space: nowrap;
}

.columns {
  display: grid;
  grid-template-columns: var(--session-columns);
  align-items: end;
  column-gap: 1rem;
  padding-bottom: 0.35rem;
}

.right {
  text-align: right;
}

.ruler {
  position: relative;
  height: 1.1rem;
  border-bottom: 1px solid var(--gridline);
}

.tick {
  position: absolute;
  bottom: 0.15rem;
  transform: translateX(-50%);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--ink-muted);
}

/* The two noons sit on the band's own edges, so centring them would hang half of each label
   outside the column it rules. */
.tick:first-child {
  transform: none;
}

.tick:last-child {
  transform: translateX(-100%);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.25rem;
  margin: 0.9rem 0 0;
  padding-top: 0.6rem;
  border-top: 1px solid var(--gridline);
  font-size: 0.75rem;
  color: var(--ink-secondary);
}

.key {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.glyph {
  font-weight: 400;
  letter-spacing: -0.05em;
}

.glyph.both {
  color: var(--coverage-both);
}
.glyph.partial {
  color: var(--coverage-partial);
}
/* The band's own no-data mark is a --coverage-none hairline, which is right for absence and wrong
   for a legend entry: at 1.4:1 on the light surface nobody would read the words beside it. */
.glyph.none {
  color: var(--ink-muted);
}

@media (max-width: 720px) {
  .head {
    grid-template-columns: 1fr;
  }

  .totals {
    grid-row: auto;
    grid-column: 1;
    text-align: left;
  }

  /* The row prints its own labels at this width, so the header row would only repeat them. */
  .columns {
    display: none;
  }
}
</style>
