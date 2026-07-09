<script setup lang="ts">
import { computed } from 'vue'

import StatusChip from './StatusChip.vue'
import type { Fault, FaultLevel, LinkState, Source } from '../application/telemetry'

const props = defineProps<{
  source: Source
  bmsState: LinkState
  solarState: LinkState
  faults: Fault[]
  worstFault: FaultLevel
}>()

const links = computed(() => {
  if (props.source === 'demo') return 'RECORDING'
  const parts: string[] = []
  if (props.bmsState === 'live') parts.push('BMS')
  if (props.solarState === 'live') parts.push('SOLAR')
  return parts.length ? parts.join(' + ') : 'NO LINK'
})

const summary = computed(() => (props.faults.length === 0 ? 'All nominal' : props.faults[0].title))
</script>

<template>
  <header class="annunciator">
    <div class="left">
      <span class="pulse" :class="{ on: source !== 'none' }" aria-hidden="true" />
      <span class="plate">{{ source === 'demo' ? 'Demo' : source === 'live' ? 'Live' : 'Idle' }}</span>
      <span class="readout links">{{ links }}</span>
    </div>

    <StatusChip :level="worstFault" :label="summary" />

    <span v-if="source === 'demo'" class="demo-tag">DEMO — recorded data</span>
  </header>

  <div v-if="faults.length" class="banners">
    <p v-for="fault in faults" :key="fault.title" class="banner" :class="fault.level">
      <StatusChip :level="fault.level" :label="fault.title" />
      <span class="detail">{{ fault.detail }}</span>
    </p>
  </div>
</template>

<style scoped>
.annunciator {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.75rem var(--pad);
  background: var(--surface);
  border-bottom: 1px solid var(--gridline);
}

.left {
  display: flex;
  align-items: center;
  gap: 0.6rem;
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

.demo-tag {
  margin-left: auto;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.1em;
  color: var(--plane);
  background: var(--ink-secondary);
  padding: 0.15rem 0.5rem;
  border-radius: 2px;
}

.banners {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-bottom: 1px solid var(--gridline);
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
