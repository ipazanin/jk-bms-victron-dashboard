<script setup lang="ts">
/**
 * The faults this archive has kept, on the page where they fired.
 *
 * The annunciator above is a claim about now: a fault appears the moment it is true and, after its
 * off-delay, stops being displayed because it has stopped being true. That is correct for an
 * annunciator and useless as a record — a fault that stood for four seconds while nobody was
 * looking leaves the strip with nothing behind it. This is the record: one row per episode, written
 * once when the fault first appeared, oldest reachable at the bottom.
 *
 * It is deliberately a summary. The readings standing behind each warning — pack current, cell
 * spread, both temperatures, the MOSFET states, the boat load — are a grid too wide for a
 * dashboard card, and they live one link away in the Warnings log.
 *
 * Only the rows in view are rendered. A thousand warnings is a thousand rows the moment the archive
 * is old enough, and mounting them all costs a phone more than the card is worth. The trade is a
 * real one and it falls on assistive technology: a virtualised list cannot be traversed as a whole,
 * so the count is announced on the region and the full, unvirtualised list is a link away.
 */
import { computed, ref } from 'vue'

import { hashOf } from '../../application/route'
import type { WarningLevel, WarningRecord } from '../../domain/history/types'

const props = defineProps<{
  warnings: readonly WarningRecord[]
}>()

/** Pixels. Every row is exactly this tall, which is what lets the runway be a multiplication. */
const ROW_HEIGHT = 60
/** Rows in view. The card holds a fixed height whatever the archive does, so nothing below it moves. */
const VIEWPORT_ROWS = 6
/** Rows rendered beyond each edge, so a fast flick does not scroll into blank space. */
const OVERSCAN = 4

const scrollTop = ref(0)

const runwayHeight = computed(() => props.warnings.length * ROW_HEIGHT)
const firstRendered = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN),
)
const rendered = computed(() =>
  props.warnings.slice(firstRendered.value, firstRendered.value + VIEWPORT_ROWS + OVERSCAN * 2),
)
const offset = computed(() => firstRendered.value * ROW_HEIGHT)

function onScroll(event: Event): void {
  scrollTop.value = (event.target as HTMLElement).scrollTop
}

const warningsHref = hashOf({ name: 'warnings' })

/**
 * Warnings span sessions and days, so a bare clock time would put two different afternoons on
 * adjacent rows with nothing to tell them apart. Seconds are kept here and only here: an episode is
 * an instant rather than a duration, and which second a fault fired is what joins it to a trace.
 */
const stamp = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** The severity in words, so the tier never rides on the dot's colour alone. */
const TIER_WORDS: Readonly<Record<WarningLevel, string>> = {
  warning: 'Warning',
  serious: 'Serious',
  critical: 'Critical',
}

const regionLabel = computed(() =>
  props.warnings.length === 0
    ? 'Recorded warnings, none yet'
    : `Recorded warnings, ${props.warnings.length} kept, most recent first`,
)
</script>

<template>
  <section class="panel" data-testid="warning-ledger">
    <header class="head">
      <h2 class="plate">Recorded warnings</h2>
      <a class="more" :href="warningsHref">Open the log →</a>
    </header>

    <p v-if="warnings.length === 0" class="empty copy">
      Nothing recorded. A warning is filed the moment a fault first appears during a live session,
      and stays here with the readings that were standing behind it.
    </p>

    <div
      v-else
      class="viewport"
      role="region"
      :aria-label="regionLabel"
      tabindex="0"
      @scroll.passive="onScroll"
    >
      <div class="runway" :style="{ height: `${runwayHeight}px` }">
        <ul class="rows" :style="{ transform: `translateY(${offset}px)` }">
          <li
            v-for="warning in rendered"
            :key="`${warning.sessionId}:${warning.seq}`"
            class="row"
          >
            <span class="line">
              <span class="dot" :class="warning.level" aria-hidden="true" />
              <span class="tier" :class="warning.level">{{ TIER_WORDS[warning.level] }}</span>
              <span class="title">{{ warning.title }}</span>
              <span class="when readout">{{ stamp.format(warning.at) }}</span>
            </span>
            <span class="detail">{{ warning.detail }}</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel {
  padding: var(--pad);
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.more {
  flex: none;
}

.empty {
  margin: 0;
}

/* The height is the row count, not the content: a card that grew with the archive would move the
   footer under it every time a fault fired. */
.viewport {
  height: calc(6 * 60px);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.runway {
  position: relative;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  position: absolute;
  inset-inline: 0;
  top: 0;
  will-change: transform;
}

.row {
  height: 60px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.15rem;
  padding-right: 0.25rem;
  border-bottom: 1px solid var(--gridline);
}

.line {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
}

.dot.warning {
  background: var(--status-warning);
}

.dot.serious {
  background: var(--status-serious);
}

.dot.critical {
  background: var(--status-critical);
}

/* Fixed width so the titles rule down the card as the list scrolls past. */
.tier {
  flex: none;
  min-width: 4rem;
  font-family: var(--font-label);
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 600;
}

.tier.warning {
  color: var(--status-warning-ink);
}

.tier.serious {
  color: var(--status-serious-ink);
}

.tier.critical {
  color: var(--status-critical-ink);
}

.title {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.when {
  flex: none;
  color: var(--ink-secondary);
  font-size: 0.75rem;
}

/* One line, ellipsed. The row height is load-bearing — a detail that wrapped would put every row
   below it out of register with the runway it is positioned against. */
.detail {
  color: var(--ink-secondary);
  font-size: 0.8125rem;
  padding-left: calc(9px + 0.6rem);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
