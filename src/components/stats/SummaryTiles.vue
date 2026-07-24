<script setup lang="ts">
/**
 * The active range's headline figures — six tiles, no plot, so no hover layer.
 *
 * A range that recorded nothing is not the same claim as a range that recorded exactly zero: the
 * energy, pack-net and recorded-time figures fall back to an em dash rather than asserting a flat
 * reading nobody took. Deepest SoC carries its own null independently of that gate, because a
 * session can run with no plausible SoC sample even inside a range that otherwise recorded plenty.
 * The warnings total is likewise independent: it is tallied from the warnings inside the precise
 * window and is exact whether or not any day-bucket landed, so it prints the real count rather than
 * an em dash even when no energy was recorded.
 */
import { computed } from 'vue'

import { ampHours, hours, kilowattHours } from '../../application/format'
import type { RangeSummary } from '../../application/history/statsRange'

const props = defineProps<{ summary: RangeSummary }>()

/** `days` counts recorded buckets, not calendar days spanned — zero of them is the honest "nothing
 *  on record for this window" the other sums cannot distinguish from their own zero. */
const isEmpty = computed(() => props.summary.days === 0)

const energyIn = computed(() => (isEmpty.value ? '—' : ampHours(props.summary.solarAh, 0)))
const energyOut = computed(() => (isEmpty.value ? '—' : kilowattHours(props.summary.houseWh / 1000)))
const packNet = computed(() => (isEmpty.value ? '—' : signedAmpHours(props.summary.packAh)))

const deepestSoc = computed(() => {
  const soc = props.summary.deepestSoc
  return soc === null ? '—' : `${soc}%`
})

const warningsTotal = computed(() => props.summary.errors.total)
const warnings = computed(() => `${warningsTotal.value}`)
const hasWarnings = computed(() => warningsTotal.value > 0)

const recorded = computed(() => (isEmpty.value ? '—' : hours(props.summary.recordedMs / 3_600_000)))

/** Signed amp-hours at whole precision, the sign decided after rounding so a net that rounds flat
 *  reads '0 Ah' rather than the meaningless '−0 Ah'. */
function signedAmpHours(value: number): string {
  const rounded = Math.round(value)
  return `${rounded === 0 ? 0 : rounded} Ah`
}
</script>

<template>
  <dl class="tiles" data-testid="stats-summary" aria-label="Range summary">
    <div class="tile">
      <dt class="label"><i class="dot solar" aria-hidden="true" />Energy in</dt>
      <dd class="figure secondary-figure">{{ energyIn }}</dd>
    </div>

    <div class="tile">
      <dt class="label"><i class="dot house" aria-hidden="true" />Energy out</dt>
      <dd class="figure secondary-figure">{{ energyOut }}</dd>
    </div>

    <div class="tile">
      <dt class="label"><i class="dot pack" aria-hidden="true" />Pack net</dt>
      <dd class="figure ledger-figure">{{ packNet }}</dd>
    </div>

    <div class="tile">
      <dt class="label">Deepest SoC</dt>
      <dd class="figure secondary-figure">{{ deepestSoc }}</dd>
    </div>

    <div class="tile">
      <dt class="label"><i v-if="hasWarnings" class="dot warning" aria-hidden="true" />Warnings</dt>
      <dd class="figure secondary-figure">{{ warnings }}</dd>
    </div>

    <div class="tile">
      <dt class="label">Recorded</dt>
      <dd class="figure secondary-figure">{{ recorded }}</dd>
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

.dot.solar {
  background: var(--solar);
}
.dot.house {
  background: var(--house);
}
.dot.pack {
  background: var(--pack);
}
.dot.warning {
  background: var(--status-warning);
}

.figure {
  margin: 0;
  color: var(--ink);
}
</style>
