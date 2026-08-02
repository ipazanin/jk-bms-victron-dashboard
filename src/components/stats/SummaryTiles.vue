<script setup lang="ts">
/**
 * The active range's headline figures — six tiles, no plot, so no hover layer.
 *
 * Every figure is the pack's own. A range the ring never covered is not the same claim as a range
 * that covered zero, so the three figures folded across records fall back to an em dash rather than
 * asserting a reading nobody took. The three extremes carry their own nulls independently of that
 * gate: a window can hold records whose cell extremes never separated. The event total is exact
 * whether or not anything else landed, so it prints its real count — including zero.
 */
import { computed } from 'vue'

import { ampHours, hours } from '../../application/format'
import type { RingRangeSummary } from '../../application/history/ringRange'

const props = defineProps<{ summary: RingRangeSummary }>()

const MS_PER_HOUR = 3_600_000

/** No record in the window is the honest "the ring covered nothing here" the sums cannot express. */
const isEmpty = computed(() => props.summary.records === 0)

const onRecord = computed(() =>
  isEmpty.value ? '—' : hours(props.summary.coveredMs / MS_PER_HOUR),
)
const charged = computed(() => (isEmpty.value ? '—' : ampHours(props.summary.chargedAh, 0)))
const drawn = computed(() => (isEmpty.value ? '—' : ampHours(props.summary.drawnAh, 0)))

const deepestCharge = computed(() => {
  const ratio = props.summary.deepestChargeRatio
  return ratio === null ? '—' : `${Math.round(ratio * 100)}%`
})

const cellSpread = computed(() => {
  const spread = props.summary.widestCellSpreadMv
  return spread === null ? '—' : `${spread} mV`
})

const events = computed(() => `${props.summary.events}`)
const hasEvents = computed(() => props.summary.events > 0)
</script>

<template>
  <dl class="tiles" data-testid="stats-summary" aria-label="Range summary">
    <div class="tile">
      <dt class="label">Hours on record</dt>
      <dd class="figure secondary-figure">{{ onRecord }}</dd>
    </div>

    <div class="tile">
      <dt class="label"><i class="dot charge" aria-hidden="true" />Charged</dt>
      <dd class="figure secondary-figure">{{ charged }}</dd>
    </div>

    <div class="tile">
      <dt class="label"><i class="dot draw" aria-hidden="true" />Drawn</dt>
      <dd class="figure secondary-figure">{{ drawn }}</dd>
    </div>

    <div class="tile">
      <dt class="label">Deepest charge</dt>
      <dd class="figure secondary-figure">{{ deepestCharge }}</dd>
    </div>

    <div class="tile">
      <dt class="label">Widest cell spread</dt>
      <dd class="figure secondary-figure">{{ cellSpread }}</dd>
    </div>

    <div class="tile">
      <dt class="label"><i v-if="hasEvents" class="dot event" aria-hidden="true" />Events</dt>
      <dd class="figure secondary-figure">{{ events }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 1rem;
  margin: 0;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: var(--pad);
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
}

.label {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0;
  font-family: var(--font-label);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
}

/* The only color in the row, each dot paired with the text label beside it so identity never
   rides on hue alone. */
.dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

.dot.charge {
  background: var(--pack);
}
.dot.draw {
  background: var(--house);
}
.dot.event {
  background: var(--status-warning);
}

.figure {
  margin: 0;
  color: var(--ink);
}
</style>
