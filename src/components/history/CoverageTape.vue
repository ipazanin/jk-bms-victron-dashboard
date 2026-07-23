<script setup lang="ts">
/**
 * When the radios were reporting, and the control that re-integrates the ledger over part of it.
 *
 * This is what makes the ledger's window sentence checkable rather than a disclaimer. The identity
 * `house = solar − pack` only holds where both radios reported and the pack was not being charged
 * from somewhere else, and on a real boat that is never the whole session — so the tape sits
 * immediately under the figures it qualifies.
 *
 * Coverage is carried by structure, not by a hue: bar height and interruption, in ink tokens.
 * It is an epistemic state rather than a fourth entity, and two shades of near-black would measure
 * about 1.4:1 against this surface and vanish on a phone in daylight.
 *
 * A selection lands on pointer-up rather than on every move. Re-integrating walks every sample
 * inside it, and a twelve-hour session would otherwise re-fold its whole account once per pixel of
 * drag; the preview during the drag is local and costs nothing.
 */
import { computed, ref } from 'vue'

import { useMediaQuery } from '../../application/useMediaQuery'
import { coverageSegments, linearScale } from '../../domain/history/geometry'
import type { CoverageClass, CoverageRun, TimeWindow } from '../../domain/history/types'

const props = defineProps<{
  coverage: readonly CoverageRun[]
  window: TimeWindow
  selection: TimeWindow | null
  cursorAt: number | null
}>()

const emit = defineEmits<{
  select: [TimeWindow | null]
  scrub: [number | null]
}>()

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000

/** Percent of the tape. Below this a run is a hairline nobody can find. */
const MIN_RUN_PERCENT = 0.4

/** How far the nudge pair moves the selection, and how wide a selection it creates from nothing. */
const NUDGE_MS = MS_PER_HOUR

const COVERAGE_NAMES: Readonly<Record<CoverageClass, string>> = {
  both: 'both',
  'pack-only': 'pack only',
  'solar-only': 'solar only',
  foreign: 'another source',
  none: 'no data',
}

const COVERAGE_GLYPHS: Readonly<Record<CoverageClass, string>> = {
  both: '██',
  'pack-only': '▒▒',
  'solar-only': '▁▁',
  foreign: '▨▨',
  none: '··',
}

const compact = useMediaQuery('(max-width: 720px)')

const track = ref<HTMLElement | null>(null)
/** The edge the pointer is moving, or 'new' while a fresh drag is being drawn. */
const dragging = ref<'new' | 'from' | 'to' | null>(null)
const draft = ref<TimeWindow | null>(null)

const spanMs = computed(() => Math.max(1, props.window.to - props.window.from))

const segments = computed(() =>
  coverageSegments(
    props.coverage,
    props.window,
    linearScale(props.window.from, props.window.to, 0, 100),
    MIN_RUN_PERCENT,
  ),
)

/** The drag in progress if there is one, else what the view has settled on. */
const shown = computed(() => draft.value ?? props.selection)

const shownBox = computed(() => {
  const window = shown.value
  if (window === null) return null
  return {
    left: percentOf(window.from),
    width: Math.max(0, percentOf(window.to) - percentOf(window.from)),
  }
})

const totals = computed(() => {
  const byKind = new Map<CoverageClass, number>()
  for (const run of props.coverage) {
    const from = Math.max(run.from, props.window.from)
    const to = Math.min(run.to, props.window.to)
    if (to <= from) continue
    byKind.set(run.kind, (byKind.get(run.kind) ?? 0) + (to - from))
  }
  return [...byKind].map(([kind, total]) => ({ kind, total }))
})

const cursorPercent = computed(() =>
  props.cursorAt === null ? null : percentOf(props.cursorAt),
)

const summary = computed(() => {
  if (totals.value.length === 0) return 'No coverage recorded for this session.'
  const parts = totals.value.map(
    ({ kind, total }) => `${COVERAGE_NAMES[kind]} for ${compactSpan(total)}`,
  )
  return `Coverage across the session: ${parts.join(', ')}.`
})

function percentOf(at: number): number {
  return Math.min(100, Math.max(0, ((at - props.window.from) / spanMs.value) * 100))
}

function atFromClientX(clientX: number): number | null {
  const element = track.value
  if (element === null) return null

  const bounds = element.getBoundingClientRect()
  if (bounds.width === 0) return null

  const fraction = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width))
  return props.window.from + fraction * spanMs.value
}

function onPointerDown(event: PointerEvent): void {
  const at = atFromClientX(event.clientX)
  if (at === null) return

  ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
  dragging.value = 'new'
  draft.value = { from: at, to: at }
  emit('scrub', at)
}

function onHandleDown(event: PointerEvent, edge: 'from' | 'to'): void {
  const window = props.selection
  if (window === null) return

  event.stopPropagation()
  ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
  dragging.value = edge
  draft.value = window
}

function onPointerMove(event: PointerEvent): void {
  const at = atFromClientX(event.clientX)
  if (at === null) return

  emit('scrub', at)
  const held = draft.value
  if (dragging.value === null || held === null) return

  if (dragging.value === 'from') draft.value = { from: at, to: held.to }
  else if (dragging.value === 'to') draft.value = { from: held.from, to: at }
  else draft.value = { from: held.from, to: at }
}

function onPointerUp(): void {
  const held = draft.value
  dragging.value = null
  draft.value = null
  if (held === null) return

  const from = Math.min(held.from, held.to)
  const to = Math.max(held.from, held.to)
  // A drag that never moved is not an empty window: it is a cleared selection.
  emit('select', to - from < MS_PER_MINUTE ? null : { from, to })
}

/**
 * The nudge pair, which is the only control that can resolve a minute on a phone: a 358px tape
 * across an eight-hour session is about eighty seconds per fingertip, and the readout must not
 * advertise a precision the control cannot reach.
 */
function nudge(direction: -1 | 1): void {
  const current = props.selection
  if (current === null) {
    const from = direction === 1 ? props.window.from : Math.max(props.window.from, props.window.to - NUDGE_MS)
    emit('select', { from, to: Math.min(props.window.to, from + NUDGE_MS) })
    return
  }

  const width = current.to - current.from
  const from = Math.min(
    props.window.to - width,
    Math.max(props.window.from, current.from + direction * NUDGE_MS),
  )
  emit('select', { from, to: from + width })
}

function clock(at: number): string {
  const when = new Date(at)
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
}

/** `9h51m`, `41m` — the tightest form, for a legend that has to fit five entries on a phone. */
function compactSpan(elapsedMs: number): string {
  const minutes = Math.round(elapsedMs / MS_PER_MINUTE)
  const hours = Math.floor(minutes / 60)
  if (hours === 0) return `${minutes}m`
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

/** `6h 00m` — the selection chip, where the figure is read rather than scanned in a row. */
function spacedSpan(elapsedMs: number): string {
  const minutes = Math.round(elapsedMs / MS_PER_MINUTE)
  const hours = Math.floor(minutes / 60)
  if (hours === 0) return `${minutes}m`
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}
</script>

<template>
  <section class="tape">
    <header class="head">
      <h2 class="plate">Coverage</h2>
      <p class="readout ends">
        <span>{{ clock(window.from) }}</span>
        <span>{{ clock(window.to) }}</span>
      </p>
    </header>

    <div
      ref="track"
      class="track"
      role="img"
      :aria-label="summary"
      data-testid="coverage-tape"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="emit('scrub', null)"
    >
      <span
        v-for="(segment, index) in segments"
        :key="`${segment.kind}-${index}`"
        class="run"
        :class="segment.kind"
        :style="{ left: `${segment.x}%`, width: `${segment.width}%` }"
        :title="COVERAGE_NAMES[segment.kind]"
      />

      <span
        v-if="cursorPercent !== null"
        class="crosshair"
        :style="{ left: `${cursorPercent}%` }"
        aria-hidden="true"
      />

      <template v-if="shownBox">
        <span
          class="selection"
          :style="{ left: `${shownBox.left}%`, width: `${shownBox.width}%` }"
          aria-hidden="true"
        />
        <!--
          Pointer affordances only. A handle that carried a slider role but did not answer an arrow
          key would be a control that lies about what it can do; the nudge pair below is the
          keyboard equivalent, and it is also the only control that resolves a minute on a phone.
        -->
        <span
          v-if="selection"
          class="handle"
          :style="{ left: `${shownBox.left}%` }"
          aria-hidden="true"
          @pointerdown="(event) => onHandleDown(event, 'from')"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
        />
        <span
          v-if="selection"
          class="handle"
          :style="{ left: `${shownBox.left + shownBox.width}%` }"
          aria-hidden="true"
          @pointerdown="(event) => onHandleDown(event, 'to')"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
        />
      </template>
    </div>

    <p class="legend readout">
      <span v-for="entry in totals" :key="entry.kind" class="key">
        <b class="glyph" :class="entry.kind">{{ COVERAGE_GLYPHS[entry.kind] }}</b>
        {{ COVERAGE_NAMES[entry.kind] }} {{ compactSpan(entry.total) }}
      </span>
    </p>

    <div class="controls">
      <p class="copy">
        {{
          compact
            ? 'Drag to select part of the session.'
            : 'Drag to re-integrate the ledger over part of the session.'
        }}
      </p>

      <span v-if="selection" class="chip readout">
        Selection · {{ spacedSpan(selection.to - selection.from) }}
        <button type="button" class="nudge" @click="emit('select', null)">Clear</button>
      </span>

      <span class="nudges">
        <button type="button" class="nudge" @click="nudge(-1)">◀ 1h</button>
        <button type="button" class="nudge" @click="nudge(1)">1h ▶</button>
      </span>
    </div>
  </section>
</template>

<style scoped>
.tape {
  padding: var(--pad);
  border-top: 1px solid var(--gridline);
  /* A drag that begins on the tape must not sweep a text selection across the legend below it. */
  user-select: none;
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.5rem;
}

.head h2 {
  margin: 0;
}

.ends {
  display: flex;
  gap: 1.25rem;
  margin: 0;
  color: var(--ink-secondary);
}

/*
 * The hit area is a full tap target even though the marks inside it are 10px: a boat is a moving
 * platform read with wet hands, and a 10px drag target is not a control.
 */
.track {
  position: relative;
  height: var(--tap);
  touch-action: pan-y;
  cursor: crosshair;
}

.run {
  position: absolute;
  bottom: calc(var(--tap) / 2 - 5px);
  height: 10px;
}

.run.both {
  background: var(--coverage-both);
}

.run.pack-only {
  background: var(--coverage-partial);
}

/* Half height and bottom-aligned: one radio reported, and the bar says so by its size. */
.run.solar-only {
  height: 5px;
  background: var(--coverage-partial);
}

/* The same bar, cut by surface-coloured diagonals: the pack was charging from something no radio
   here measures, so the run is interrupted rather than recoloured. */
.run.foreign {
  background:
    repeating-linear-gradient(45deg, transparent 0 3px, var(--surface) 3px 5px),
    var(--coverage-both);
}

.run.none {
  height: 1px;
  background: var(--coverage-none);
}

.crosshair {
  position: absolute;
  top: 4px;
  bottom: 4px;
  width: 1px;
  background: var(--ink-secondary);
  pointer-events: none;
}

.selection {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border-left: 1px solid var(--ink);
  border-right: 1px solid var(--ink);
  background: rgba(127, 127, 127, 0.18);
  pointer-events: none;
}

.handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: var(--tap);
  margin-left: calc(var(--tap) / -2);
  cursor: ew-resize;
}

.handle::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(50% - 1px);
  width: 2px;
  background: var(--ink);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.25rem;
  margin: 0.35rem 0 0;
  font-size: 0.8125rem;
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

.glyph.both,
.glyph.foreign {
  color: var(--coverage-both);
}

.glyph.pack-only,
.glyph.solar-only {
  color: var(--coverage-partial);
}

/* The band's own no-data mark is a --coverage-none hairline, which is right for absence and wrong
   for a legend entry: at 1.4:1 on the light surface nobody would read the words beside it. */
.glyph.none {
  color: var(--ink-muted);
}

.controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.6rem 1rem;
  margin-top: 0.6rem;
}

.controls .copy {
  margin: 0;
  flex: 1 1 16rem;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--ink);
}

.nudges {
  display: inline-flex;
  gap: 0.5rem;
}

.nudge {
  background: transparent;
  border: 1px solid var(--gridline);
  color: var(--ink-secondary);
  border-radius: 2px;
  padding: 0.2rem 0.7rem;
  min-height: var(--tap);
  display: inline-flex;
  align-items: center;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.nudge:hover {
  color: var(--ink);
  border-color: var(--baseline);
}
</style>
