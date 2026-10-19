<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { duration } from '../../application/format'
import type { SessionHour } from '../../domain/history/SessionHour'
import type { SessionHourCurrent } from '../../domain/history/SessionHourCurrentIntegral'
import type { CoverageClass } from '../../domain/history/types'
import ImportantMoments from './ImportantMoments.vue'

const props = defineProps<{
  hours: readonly SessionHour[]
  selectedHour: SessionHour | null
}>()
const emit = defineEmits<{ select: [hourStart: number | null] }>()
const PAGE_HOURS = 24
const page = ref(0)
const sorted = computed(() => [...props.hours].sort((first, last) => first.hourStart - last.hourStart))
const pages = computed(() => Math.max(1, Math.ceil(sorted.value.length / PAGE_HOURS)))
const shown = computed(() => sorted.value.slice(page.value * PAGE_HOURS, (page.value + 1) * PAGE_HOURS))
const inspected = computed(() => props.selectedHour ?? shown.value[0] ?? null)
const reconstructed = computed(() => props.hours.filter((hour) => hour.basis === 'reconstructed').length)
const coverageLabels: Record<CoverageClass, string> = {
  both: 'counted together',
  foreign: 'another charging source',
  'pack-only': 'pack only',
  'solar-only': 'solar only',
  none: 'unknown',
}
watch(pages, (count) => { page.value = Math.min(page.value, count - 1) })
watch(page, () => emit('select', null))

function instant(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  })
}

function envelope(hour: SessionHour, metric: SessionHourCurrent): string {
  const extremes = hour.metrics[metric]
  if (extremes.minimum === null || extremes.maximum === null) return 'Not observed'
  return `${extremes.minimum.toFixed(1)} to ${extremes.maximum.toFixed(1)} A`
}

function average(hour: SessionHour, metric: SessionHourCurrent): string {
  const current = hour.currentIntegrals[metric]
  return current.observedMs > 0 ? `${(current.integral / current.observedMs).toFixed(1)} A mean` : 'No measured duration'
}

function coverage(hour: SessionHour): string {
  return (Object.keys(coverageLabels) as CoverageClass[])
    .filter((kind) => hour.coverageMs[kind] > 0)
    .map((kind) => `${duration(hour.coverageMs[kind] / 1_000)} ${coverageLabels[kind]}`)
    .join(', ') || 'Single observation, no measured duration'
}
</script>

<template>
  <section class="hours card">
    <header>
      <h3 class="plate">Hourly history · {{ hours.length }} retained {{ hours.length === 1 ? 'hour' : 'hours' }}</h3>
      <p class="copy">UTC hours shown in your local time. Each row keeps observed ranges and weighted current means. Missing hours are unknown.</p>
      <p v-if="reconstructed" class="copy">{{ reconstructed }} {{ reconstructed === 1 ? 'hour' : 'hours' }} reconstructed from available raw samples. Earlier missing samples cannot be recovered.</p>
      <p v-if="reconstructed < hours.length" class="copy">Recorded hours were calculated as readings arrived. The whole-session ledger remains the original total.</p>
      <button v-if="selectedHour" type="button" class="action" @click="emit('select', null)">Show whole-session ledger</button>
    </header>
    <div class="table-scroll">
      <table>
        <caption class="muted">Select a whole retained hour to inspect its ledger and important moments. Partial-hour totals are unavailable.</caption>
        <thead><tr><th>Hour</th><th>Pack current</th><th>Solar current</th><th>Solar − pack</th><th>Coverage</th></tr></thead>
        <tbody>
          <tr v-for="hour in shown" :key="hour.hourStart" :class="{ selected: selectedHour?.hourStart === hour.hourStart }">
            <td>
              <button type="button" class="action" :aria-pressed="selectedHour?.hourStart === hour.hourStart" @click="emit('select', hour.hourStart)">{{ instant(hour.hourStart) }}</button>
              <small>{{ hour.basis === 'recorded' ? 'Recorded' : 'Reconstructed' }} · {{ duration((hour.to - hour.from) / 1_000) }} clock span</small>
              <small v-if="hour.clockAdjusted">Recording clock moved backward. Durations may overlap on the clock.</small>
            </td>
            <td>{{ envelope(hour, 'packCurrentA') }}<small>{{ average(hour, 'packCurrentA') }}</small></td>
            <td>{{ envelope(hour, 'solarCurrentA') }}<small>{{ average(hour, 'solarCurrentA') }}</small></td>
            <td>{{ envelope(hour, 'houseCurrentA') }}<small>{{ average(hour, 'houseCurrentA') }}</small></td>
            <td>{{ coverage(hour) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <nav v-if="pages > 1" aria-label="Hourly history pages">
      <button type="button" class="action" :disabled="page === 0" @click="page -= 1">Earlier hours</button>
      <span class="muted">Page {{ page + 1 }} of {{ pages }}</span>
      <button type="button" class="action" :disabled="page + 1 === pages" @click="page += 1">Later hours</button>
    </nav>
    <div v-if="inspected" class="inspection">
      <p class="copy">Retained span: {{ instant(inspected.from) }} to {{ instant(inspected.to) }}. Coverage totals do not locate every outage within the hour.</p>
      <ImportantMoments :moments="inspected.moments" />
    </div>
  </section>
</template>

<style scoped>
.hours { padding: var(--pad); display: grid; gap: 1rem; }
header { display: grid; gap: 0.5rem; }
h3, p { margin: 0; }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
caption { text-align: left; padding-bottom: 0.75rem; }
th, td { text-align: left; vertical-align: top; padding: 0.65rem; border-bottom: 1px solid var(--gridline); min-width: 9rem; }
small { display: block; color: var(--ink-secondary); margin-top: 0.35rem; }
.selected { background: var(--raised); }
nav { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem; }
.inspection { border-top: 1px solid var(--gridline); padding-top: 1rem; display: grid; gap: 1rem; }
</style>
