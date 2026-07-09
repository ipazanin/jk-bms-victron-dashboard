<script setup lang="ts">
import type { ChargeState } from '../domain/solar/types'

defineProps<{ stage: ChargeState }>()

const STAGES: ChargeState[] = ['off', 'bulk', 'absorption', 'float']
</script>

<template>
  <ol class="stepper" :aria-label="`Charge stage: ${stage}`">
    <li v-for="step in STAGES" :key="step" :class="{ active: step === stage }">
      {{ step }}
    </li>
    <li v-if="!STAGES.includes(stage)" class="active">{{ stage }}</li>
  </ol>
</template>

<style scoped>
.stepper {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.stepper li {
  font-family: var(--font-label);
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-muted);
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--gridline);
  border-radius: 2px;
}

.stepper li.active {
  color: var(--plane);
  background: var(--solar);
  border-color: var(--solar);
  font-weight: 600;
}
</style>
