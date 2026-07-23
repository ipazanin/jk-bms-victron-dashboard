<script setup lang="ts">
import { computed } from 'vue'

import StatusChip from './StatusChip.vue'
import { ampHours, hours, volts } from '../application/format'
import type { BatterySnapshot } from '../domain/bms/types'
import type { Projection } from '../domain/dcBus'

const props = defineProps<{
  battery: BatterySnapshot
  projection: Projection | null
}>()

/** Percent. The mark the meter carries, the chip announces and the aria-label names. */
const LOW_MARK = 20

const fraction = computed(() => Math.min(1, Math.max(0, props.battery.stateOfCharge / 100)))
const low = computed(() => props.battery.stateOfCharge <= LOW_MARK)

const meterLabel = computed(() => {
  const charge = `${props.battery.stateOfCharge} percent charged`
  return low.value
    ? `${charge}, at or under the ${LOW_MARK} percent low mark`
    : `${charge}, over the ${LOW_MARK} percent low mark`
})

/**
 * The window the projection was measured over. A projection without its aperture is not a
 * projection, and a row holding ninety seconds of data must not round itself up into a claim
 * about five minutes.
 */
function aperture(overMs: number): string {
  const seconds = Math.round(overMs / 1000)
  if (seconds < 120) return `over ${seconds} s`
  return `over ${Math.round(seconds / 60)} min`
}

/**
 * One row, always present, because two mutually exclusive rows that can both vanish move
 * everything below them. Every state the projection can be in has words here, including the
 * two that decline to name a figure — a remembered or browsed session carries no window at all,
 * and a rate taken from an hours-old snapshot describes a boat that has since moved on.
 */
const runtime = computed(() => {
  const projection = props.projection
  if (projection === null) return '— no recent samples'
  if (projection.kind === 'collecting') return 'collecting…'
  if (projection.kind === 'holding') return `holding · ${aperture(projection.overMs)}`

  const destination = projection.kind === 'toFull' ? 'to full' : 'to empty'
  const figure = projection.hours === 0 ? 'full' : `${hours(projection.hours)} ${destination}`
  return `${figure} · ${aperture(projection.overMs)}`
})
</script>

<template>
  <section class="panel">
    <h2 class="plate">State of charge</h2>

    <div class="hero">
      <p class="hero-figure" :class="{ low }">{{ battery.stateOfCharge }}<span class="unit">%</span></p>
      <StatusChip v-if="low" level="warning" label="Low charge" />
    </div>

    <div class="scale">
      <div class="meter" role="img" :aria-label="meterLabel">
        <div class="fill" :style="{ width: `${fraction * 100}%` }" />
        <div class="threshold" :style="{ left: `${LOW_MARK}%` }" />
      </div>
      <!-- The tick is the number the meter is read against, so it is printed rather than hidden. -->
      <span class="mark muted" :style="{ left: `${LOW_MARK}%` }">{{ LOW_MARK }} %</span>
    </div>

    <dl class="stats">
      <div>
        <dt class="plate">Capacity</dt>
        <dd class="readout">{{ ampHours(battery.remainingCapacity) }} / {{ ampHours(battery.nominalCapacity) }}</dd>
      </div>
      <div>
        <dt class="plate">Pack</dt>
        <dd class="readout">{{ volts(battery.packVoltage, 2) }}</dd>
      </div>
      <div>
        <dt class="plate">Runtime</dt>
        <dd class="readout">{{ runtime }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.panel {
  padding: var(--pad);
}

.hero {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.hero-figure {
  margin: 0.5rem 0 0.75rem;
}

.hero-figure.low {
  color: var(--status-warning);
}

.unit {
  font-size: 1.5rem;
  font-weight: 500;
  color: var(--ink-secondary);
  margin-left: 0.15rem;
}

/* The bottom padding reserves the hanging tick label's row. The label is measured from the
   meter's height rather than from the scale's own bottom edge: `top: 100%` resolves against the
   padding box, which would land it past the space reserved for it and on top of the stats. */
.scale {
  --meter-height: 10px;
  position: relative;
  padding-bottom: 1.25rem;
}

.meter {
  position: relative;
  height: var(--meter-height);
  background: var(--raised);
  border-radius: 2px;
  overflow: hidden;
}

/* State of charge moves over minutes, so this glides once and never repeats. It is the one
   transition on the page that is not chasing a 1 Hz target. */
.fill {
  height: 100%;
  background: var(--pack);
  transition: width 400ms cubic-bezier(0.2, 0.7, 0.2, 1);
}

.threshold {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--baseline);
}

.mark {
  position: absolute;
  top: var(--meter-height);
  transform: translateX(-50%);
  margin-top: 0.3rem;
  white-space: nowrap;
}

.stats {
  display: grid;
  gap: 0.5rem;
  margin: 1rem 0 0;
}

.stats div {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

dt,
dd {
  margin: 0;
}

dd {
  color: var(--ink);
}
</style>
