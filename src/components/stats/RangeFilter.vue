<script setup lang="ts">
/**
 * The one filter row that scopes every card below it on the Stats page.
 *
 * A radio group, not a tab list: the segments narrow the SAME data to a different window — they
 * never swap in a different panel — which is exactly the distinction ARIA draws between `radiogroup`
 * and `tablist`. Roving tabindex keeps only the checked segment on the Tab order, so arrowing
 * between the options behaves like a native `<input type="radio">` group.
 *
 * 'Custom' reveals two date inputs; the window they define is owned by the parent (StatsView), so the
 * filter stays a pure control — it announces a range and a pair of dates, it holds no state of its own.
 */
import { computed } from 'vue'
import type { ComponentPublicInstance } from 'vue'

import type { RangeKind } from '../../application/history/statsRange'
import type { TimeWindow } from '../../domain/history/types'

interface RangeOption {
  readonly kind: RangeKind
  readonly label: string
}

/** Fixed order; the presets roll back from now, then All spans the archive, then Custom opens dates. */
const OPTIONS: readonly RangeOption[] = [
  { kind: 'hour', label: 'Hour' },
  { kind: 'day', label: 'Day' },
  { kind: 'week', label: 'Week' },
  { kind: 'month', label: 'Month' },
  { kind: 'all', label: 'All' },
  { kind: 'custom', label: 'Custom' },
]

const props = defineProps<{ modelValue: RangeKind; custom: TimeWindow }>()
const emit = defineEmits<{ 'update:modelValue': [RangeKind]; 'update:custom': [TimeWindow] }>()

/** Imperative focus targets for the roving-tabindex keyboard handler below; not reactive state. */
const buttons: (HTMLButtonElement | null)[] = []

function setButtonRef(index: number) {
  return (element: Element | ComponentPublicInstance | null): void => {
    buttons[index] = element instanceof HTMLButtonElement ? element : null
  }
}

function indexOf(kind: RangeKind): number {
  return OPTIONS.findIndex((option) => option.kind === kind)
}

function select(kind: RangeKind): void {
  if (kind !== props.modelValue) emit('update:modelValue', kind)
}

function onKeydown(event: KeyboardEvent): void {
  const current = Math.max(0, indexOf(props.modelValue))
  let next: number

  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      next = (current - 1 + OPTIONS.length) % OPTIONS.length
      break
    case 'ArrowRight':
    case 'ArrowDown':
      next = (current + 1) % OPTIONS.length
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = OPTIONS.length - 1
      break
    default:
      return
  }

  event.preventDefault()
  select(OPTIONS[next].kind)
  buttons[next]?.focus()
}

// ── custom date range ────────────────────────────────────────────────────────

/** A local yyyy-mm-dd for the native date input; padded so the browser accepts it in every locale. */
function toDateInput(ms: number): string {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Back to a local-midnight instant, or null for a half-typed value the input hands over mid-edit. */
function fromDateInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return null
  const [, year, month, day] = match
  return new Date(Number(year), Number(month) - 1, Number(day)).getTime()
}

const fromValue = computed(() => toDateInput(props.custom.from))
const toValue = computed(() => toDateInput(props.custom.to))

function onFrom(event: Event): void {
  const ms = fromDateInput((event.target as HTMLInputElement).value)
  if (ms !== null) emit('update:custom', { from: ms, to: props.custom.to })
}

function onTo(event: Event): void {
  const ms = fromDateInput((event.target as HTMLInputElement).value)
  if (ms !== null) emit('update:custom', { from: props.custom.from, to: ms })
}
</script>

<template>
  <div class="filter">
    <div
      class="range-filter"
      role="radiogroup"
      aria-orientation="horizontal"
      aria-label="Range"
      data-testid="stats-range-filter"
      @keydown="onKeydown"
    >
      <button
        v-for="(option, index) in OPTIONS"
        :key="option.kind"
        :ref="setButtonRef(index)"
        type="button"
        role="radio"
        class="segment"
        :class="{ selected: option.kind === modelValue }"
        :aria-checked="option.kind === modelValue"
        :tabindex="option.kind === modelValue ? 0 : -1"
        @click="select(option.kind)"
      >
        {{ option.label }}
      </button>
    </div>

    <div v-if="modelValue === 'custom'" class="custom-dates" data-testid="stats-custom-dates">
      <label class="date">
        <span class="date-label">From</span>
        <input type="date" class="date-input" :value="fromValue" @change="onFrom" />
      </label>
      <span class="date-sep" aria-hidden="true">→</span>
      <label class="date">
        <span class="date-label">To</span>
        <input type="date" class="date-input" :value="toValue" @change="onTo" />
      </label>
    </div>
  </div>
</template>

<style scoped>
.filter {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.range-filter {
  display: flex;
  width: 100%;
  padding: 3px;
  gap: 2px;
  background: var(--surface);
  border: 1px solid var(--card-border);
  border-radius: var(--r-pill);
}

.segment {
  flex: 1 1 0;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--tap);
  padding: 0 0.35rem;
  border: none;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--ink-secondary);
  font-family: var(--font-label);
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  white-space: nowrap;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}

.segment:hover {
  color: var(--ink);
}

.segment.selected {
  background: var(--raised);
  color: var(--ink);
  box-shadow: var(--shadow-1);
}

/* The two dates that appear only under Custom. */
.custom-dates {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.5rem 0.75rem;
}

.date {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.date-label {
  font-family: var(--font-label);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
}

.date-input {
  min-height: var(--tap);
  padding: 0 0.6rem;
  background: var(--raised);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 0.875rem;
  color-scheme: light dark;
}

.date-input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}

.date-sep {
  align-self: center;
  padding-bottom: 0.6rem;
  color: var(--ink-muted);
}

@media (max-width: 400px) {
  .segment {
    font-size: 0.6875rem;
    letter-spacing: 0.02em;
  }
}
</style>
