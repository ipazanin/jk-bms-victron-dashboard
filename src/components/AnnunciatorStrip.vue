<script setup lang="ts">
/**
 * What the panel is reading, and what it has to say about it.
 *
 * An annunciator's whole job is to be believed, so two things it must never do are hard-coded
 * here rather than left to the severity model. It never reports a clean bill of health over
 * quantities nothing measured — an empty fault list under an unconnected radio is the absence of
 * an assessment, not the absence of a fault. And the fault lane is always occupied while a radio
 * is live, so a fault arriving does not shove the instruments below it down the page.
 */
import { computed } from 'vue'

import StatusChip from './StatusChip.vue'
import type { Fault, FaultLevel, LinkState, Source } from '../application/telemetry'

const props = defineProps<{
  source: Source
  bmsState: LinkState
  solarState: LinkState
  faults: Fault[]
  worstFault: FaultLevel
  /** The pack's name as the Log knows it, so the live page and the archive agree on what it is. */
  deviceLabel?: string | null
}>()

/**
 * The alarm engine runs over the live radios and over nothing else. A stored session carries the
 * annunciator text it had at the time and is never re-assessed, so in any other mode the fault
 * list is empty because nothing was examined — which is a different claim from all-clear, and the
 * chip and the watch list are both withheld rather than reworded.
 */
const watching = computed(() => props.source === 'live')

const links = computed(() => {
  const parts: string[] = []
  if (props.bmsState === 'live') parts.push('BMS')
  if (props.solarState === 'live') parts.push('SOLAR')
  return parts.length ? parts.join(' + ') : 'NO LINK'
})

const mode = computed(() => {
  if (props.source === 'live') return 'Live'
  return props.source === 'history' ? 'Stored' : 'Idle'
})

/** A claim about the fault list, which is what the engine computes — never a clean bill of health. */
const summary = computed(() => props.faults[0]?.title ?? 'No active faults')

/**
 * What the nominal row names must be true of the radios actually reporting. With no BMS on the
 * link there are no cells, no MOSFET and no breakers to watch, and saying otherwise would be the
 * same false assurance the empty-list chip is withheld to avoid.
 */
const watchList = computed(() =>
  props.bmsState === 'live'
    ? 'Cell balance, path resistance, MOSFET and cell temperature, breakers, charge level.'
    : 'Charger faults, and whether the two radios agree on the bus voltage.',
)
</script>

<template>
  <!-- One elevated card holds the reading and the watch list together, so the two read as one
       instrument rather than two flat bars stacked with a seam between them. -->
  <div class="strip card">
    <header class="annunciator">
      <div class="left">
        <span class="pulse" :class="{ on: watching }" aria-hidden="true" />
        <span class="plate">{{ mode }}</span>
        <span class="readout links">{{ links }}</span>
        <span v-if="deviceLabel" class="readout name">{{ deviceLabel }}</span>
      </div>

      <StatusChip v-if="watching" :level="worstFault" :label="summary" />
      <span v-else class="nothing">Nothing connected</span>

      <!-- The recording plate belongs on this line, at the right. It is passed in rather than
           imported so the strip stays a presentation component with no view of the archive. -->
      <span class="trailing"><slot /></span>
    </header>

    <div v-if="watching" class="banners" aria-live="polite">
      <p v-if="faults.length === 0" class="banner">
        <StatusChip level="good" label="Watching" />
        <span class="detail">{{ watchList }}</span>
      </p>
      <p v-for="fault in faults" :key="fault.title" class="banner" :class="fault.level">
        <StatusChip :level="fault.level" :label="fault.title" />
        <span class="detail">{{ fault.detail }}</span>
      </p>
    </div>
  </div>
</template>

<style scoped>
/* Sits above the Bus cards on the same stack rhythm: the gap below comes from the first card's
   own top padding, so only the gap above needs stating here. */
.strip {
  margin-top: clamp(0.75rem, 1.5vw, 1.25rem);
}

.annunciator {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.75rem var(--pad);
}

.left {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.pulse {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--ink-muted);
}

.pulse.on {
  background: var(--status-good);
  animation: breathe 2.4s ease-in-out infinite;
}

@keyframes breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.links {
  color: var(--ink-secondary);
}

.name {
  color: var(--ink);
}

.nothing {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--ink-muted);
}

.trailing {
  margin-left: auto;
}

/*
 * Rendered whenever a radio is live, occupied or not. The nominal row reuses the fault row's own
 * classes so the reserved height is the fault row's height by construction — a magic min-height
 * would drift the first time the padding or the border changes. A hairline keeps separating each
 * row from the one above it; the card edge now does the job the strip's own border used to.
 */
.banners {
  display: flex;
  flex-direction: column;
}

.banner {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin: 0;
  padding: 0.5rem var(--pad);
  border-top: 1px solid var(--gridline);
}

.detail {
  font-size: 0.875rem;
  color: var(--ink-secondary);
}
</style>
