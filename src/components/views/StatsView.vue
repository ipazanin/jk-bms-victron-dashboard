<script setup lang="ts">
/**
 * The pack's own history, scoped to a range the reader chooses.
 *
 * Every figure on this page comes out of the ring the BMS keeps for itself — one snapshot an hour,
 * held on the device until a read brings it here, then merged into a per-device ledger that only
 * ever grows. Sessions are the Log tab's subject and never this one's, so nothing here is folded
 * from a recording and nothing here waits for one.
 *
 * The solar controller has no counterpart. It answers its tunnel and refuses the history registers,
 * so there is no PV or house series to re-source and none is left waiting behind an empty card.
 *
 * Wall time is derived rather than stored, and it arrives with the uncertainty that produced it. The
 * provenance line above the cards states that once for the whole page, because every record on one
 * ledger shares one correction — a badge per record would repeat the same sentence eight hundred
 * times and read as though the records disagreed.
 *
 * Below the range-scoped cards are the two facts that belong to the pack rather than to a window:
 * the lifetime counters off whatever frame is on the instruments now, and the event logbook from the
 * last time this browser read one. Last of all is the read receipt: what the most recent stored-log
 * read carried, what filing it did, and where the pack's clock stands against this browser's.
 */
import { computed, onMounted, ref, watch } from 'vue'

import { browserStandardUtcOffsetMinutes } from '../../application/browserZone'
import { ampHours, amps, duration, relativeAge, volts } from '../../application/format'
import { useHistoryBrowser } from '../../application/history/historyBrowser'
import {
  ringEnergyBuckets,
  ringEventsPerDay,
  ringRangeSummary,
  ringTrack,
} from '../../application/history/ringRange'
import type { UnattributedStep } from '../../application/history/ringRange'
import { bucketUnitFor, windowFor } from '../../application/history/statsRange'
import type { RangeKind } from '../../application/history/statsRange'
import { eventWallTime } from '../../application/logbook'
import { hashOf } from '../../application/route'
import { useTelemetry } from '../../application/telemetry'
import type { DetailLogOutcome } from '../../domain/bms/DetailLogOutcome'
import {
  PACK_SAMPLING_PERIOD_SECONDS,
  clockErrorOf,
  packFaceInstant,
  resolveRingInstant,
  ringClockContextOf,
} from '../../domain/history/ringClock'
import type { DeviceKey, TimeWindow } from '../../domain/history/types'
import EnergyInOut from '../stats/EnergyInOut.vue'
import EventsPerDay from '../stats/EventsPerDay.vue'
import PackTimeline from '../stats/PackTimeline.vue'
import RangeFilter from '../stats/RangeFilter.vue'
import SummaryTiles from '../stats/SummaryTiles.vue'

const telemetry = useTelemetry()
const {
  battery,
  bmsState,
  detailLog,
  detailLogError,
  detailLogReading,
  device,
  logbook,
  readDetailLog,
  ringFilingNote,
  ringIngest,
  source,
} = telemetry
const browser = useHistoryBrowser()

const MS_PER_SECOND = 1000
const SAMPLING_PERIOD_MS = PACK_SAMPLING_PERIOD_SECONDS * MS_PER_SECOND
/** Under this the correction is tighter than a printed minute, so the ± is dropped rather than
 *  rounded to zero. The pack timeline uses the same floor for its own bracket. */
const UNCERTAINTY_FLOOR_MS = 60_000

/**
 * The default is the week, so a freshly read ledger lands as bars on first paint. `now` is frozen
 * and refreshed only when a range is picked or a read lands, never on a timer: a window recomputed
 * every second would reflow the whole page and trip the steadiness check.
 */
const range = ref<RangeKind>('week')
const now = ref(Date.now())

/**
 * The two dates behind the Custom range, owned here so the filter stays a pure control. Defaults to
 * the last seven days — the same span the Week preset covers — so switching to Custom moves nothing
 * until the reader picks a date.
 */
const customWindow = ref<TimeWindow>({ from: Date.now() - 6 * 86_400_000, to: Date.now() })

onMounted(() => {
  void browser.refresh().catch(() => undefined)
})

function selectRange(kind: RangeKind): void {
  now.value = Date.now()
  range.value = kind
}

function selectCustom(window: TimeWindow): void {
  customWindow.value = window
  now.value = Date.now()
}

// ── which pack ──────────────────────────────────────────────────────────────

const ledgers = computed(() => browser.ringLedgers.value)
const packKey = ref<DeviceKey | null>(null)

/** The list arrives most recently read first, which is the default this page wants. A key that no
 *  longer lists — a ledger deleted here or in another tab — falls back to the same rule. */
watch(
  ledgers,
  (rows) => {
    const held = packKey.value
    if (held !== null && rows.some((row) => row.deviceKey === held)) return
    packKey.value = rows[0]?.deviceKey ?? null
  },
  { immediate: true },
)

watch(
  packKey,
  (key) => {
    if (key !== null) void browser.loadRingLedger(key).catch(() => undefined)
  },
  { immediate: true },
)

/** A read that landed is new data and a new clock measurement, so the frozen window is re-taken. */
watch(detailLog, () => {
  now.value = Date.now()
})

// ── the ledger, and the clock that dates it ─────────────────────────────────

const ledger = computed(() => browser.ringLedger.value)
const records = computed(() => ledger.value?.records ?? [])

/**
 * Null only before a ledger is in hand. The browser's standard offset stands in for the pack's
 * installation zone until the owner confirms one, and the context says which of the two it carries.
 */
const clock = computed(() => {
  const held = ledger.value
  if (held === null) return null
  return ringClockContextOf(held, browserStandardUtcOffsetMinutes(now.value))
})

/** The oldest instant this ledger can place, for the All range. Records the clock cannot place are
 *  counted in every total regardless of window, so leaving them out of the span costs nothing. */
const oldestDatedAt = computed(() => {
  const context = clock.value
  if (context === null) return null
  for (const row of records.value) {
    const instant = resolveRingInstant(row, context)
    if (instant.basis !== 'unresolved') return instant.at
  }
  return null
})

const rangeWindow = computed(() =>
  windowFor(range.value, now.value, { oldest: oldestDatedAt.value, custom: customWindow.value }),
)
const bucketUnit = computed(() => bucketUnitFor(rangeWindow.value))

const summary = computed(() =>
  clock.value === null ? null : ringRangeSummary(records.value, clock.value, rangeWindow.value),
)
const energyBuckets = computed(() =>
  clock.value === null
    ? []
    : ringEnergyBuckets(records.value, clock.value, rangeWindow.value, bucketUnit.value),
)
const eventDays = computed(() =>
  clock.value === null ? [] : ringEventsPerDay(records.value, clock.value, rangeWindow.value),
)
const track = computed(() =>
  clock.value === null ? null : ringTrack(records.value, clock.value, rangeWindow.value),
)

/**
 * The step trace is drawn wherever the buckets are days, which is the same span it stays legible
 * over — roughly a month and a half of hourly records. Past that it is thousands of steps in a few
 * hundred pixels and the bars are the honest instrument.
 */
const showTrace = computed(() => bucketUnit.value === 'day')

// ── what the page says about its own clock ──────────────────────────────────

/** The stretch the pack's clock is in now. Segments tile seq space, so the last is always the one. */
const currentSegment = computed(() => clock.value?.segments[clock.value.segments.length - 1] ?? null)

const clockError = computed(() => {
  const context = clock.value
  const segment = currentSegment.value
  if (context === null || segment === null) return null
  return clockErrorOf(context, segment)
})

const isPinned = computed(() => clock.value?.ownerAheadSeconds !== null)

const clockMidpointMs = computed(() => {
  const error = clockError.value
  return error === null ? null : (error.lowMs + error.highMs) / 2
})

/** One sentence about where every time on this page came from. */
const provenance = computed(() => {
  const context = clock.value
  const error = clockError.value
  if (context === null) return null
  if (error === null) {
    return 'No read has placed the pack against your own clock yet, so nothing below is dated. Read the stored log and the correction follows.'
  }

  const rewrites = context.calibrations.filter((each) => each.stepSeconds !== 0).length
  const rewriteNote =
    rewrites === 0
      ? ''
      : ` ${rewrites === 1 ? 'One clock rewrite is' : `${rewrites} clock rewrites are`} on record and accounted for.`

  if (isPinned.value) {
    return `Times are the pack's own clock, corrected by the ${aheadLabel(error.lowMs)} you pinned.${rewriteNote}`
  }
  const half = (error.highMs - error.lowMs) / 2
  return `The pack's clock runs about ${aheadLabel(clockMidpointMs.value ?? 0)} fast — measured across ${error.observations} read${error.observations === 1 ? '' : 's'}, to within ${spanLabel(half)}. Times below are corrected by that.${rewriteNote}`
})

const unpairedNote = computed(() => {
  const unpaired = clock.value?.unpairedCalibrations ?? 0
  if (unpaired === 0) return null
  return unpaired === 1
    ? 'One clock rewrite is only half in the ring; records before it may be out by an unknown amount.'
    : `${unpaired} clock rewrites are only half in the ring; records before them may be out by an unknown amount.`
})

const undatedNote = computed(() => {
  const undated = summary.value?.undatedRecords ?? 0
  if (undated === 0) return null
  return `${undated} record${undated === 1 ? ' falls' : 's fall'} in a stretch whose clock this browser cannot place. ${undated === 1 ? 'It is' : 'They are'} counted in the totals and left out of the day buckets.`
})

// ── what the fold refused, each on its own line ─────────────────────────────

/** How each refusal is worded. The counter snap is the pack correcting itself and reads as such;
 *  the other two are stretches whose two ends are not an hour apart and are not comparable. */
const REFUSAL_COPY: Readonly<Record<UnattributedStep, (steps: number, ah: string) => string>> = {
  'counter-snap': (steps, ah) =>
    `The pack reset its own charge counter ${steps === 1 ? 'once' : `${steps} times`} in this range, ${ah} of it. That is the BMS correcting itself at the end of a charge, so it is left out of the figures above.`,
  'clock-rewrite': (steps, ah) =>
    `${steps} hour${steps === 1 ? '' : 's'} span a clock rewrite (${ah}) and are left out: the two readings either side were not taken an hour apart.`,
  gap: (steps, ah) =>
    `${steps} hour${steps === 1 ? '' : 's'} span a hole in the record (${ah}) and are left out rather than bridged.`,
}

const refusals = computed(() => {
  const tallies = summary.value?.unattributed
  if (tallies === undefined) return []
  return (Object.keys(REFUSAL_COPY) as UnattributedStep[])
    .filter((kind) => tallies[kind].steps > 0)
    .map((kind) => ({ kind, text: REFUSAL_COPY[kind](tallies[kind].steps, ampHours(tallies[kind].ah, 0)) }))
})

/** How far back this browser's copy goes, and whether the pack or the budget set that edge. */
const ledgerStart = computed(() => {
  const held = ledger.value
  const context = clock.value
  if (held === null || context === null || held.records.length === 0) return null

  const first = resolveRingInstant(held.records[0], context)
  const when = first.basis === 'unresolved' ? null : dayStamp.format(first.at)
  if (when === null) return null
  return held.retainedFromSeq === null
    ? `The stored log starts ${when} — that is as far back as the pack itself went at the first read.`
    : `Kept records start ${when}. Older ones were dropped to stay inside the archive's budget.`
})

// ── lifetime counters ────────────────────────────────────────────────────────

const connectHref = hashOf({ name: 'connect' })

/** Present whenever a pack is on the instruments — live, remembered or a browsed session. */
const lifetime = computed(() => {
  const pack = battery.value
  const info = device.value
  if (pack === null && info === null) return null
  return {
    cycleCount: pack?.cycleCount ?? null,
    cycledCapacity: pack?.cycledCapacity ?? null,
    powerOnCount: info?.powerOnCount ?? null,
    uptimeSeconds: pack?.uptimeSeconds ?? info?.uptimeSeconds ?? null,
    model: info?.model ?? null,
  }
})

// ── device logbook ────────────────────────────────────────────────────────────

const stamp = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

const dayStamp = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })

/** Newest first, each with a real date when the boot instant is known, else elapsed-since-boot. */
const logbookRows = computed(() => {
  const stored = logbook.value
  if (stored === null) return []
  return [...stored.events].reverse().map((event) => {
    const wall = eventWallTime(stored, event)
    return {
      key: `${event.secondsSinceBoot}:${event.code}`,
      label: event.label,
      when: wall === null ? `+${duration(event.secondsSinceBoot)}` : stamp.format(wall),
    }
  })
})

const logbookAge = computed(() => {
  const stored = logbook.value
  if (stored === null) return null
  return stamp.format(stored.fetchedAt)
})

// ── the read receipt ─────────────────────────────────────────────────────────

/**
 * The pack's counter rendered exactly as the pack holds it — read with UTC getters, no zone
 * applied, so it spells the pack's own zone on standard time. It is shown beside the resolved
 * instant because it is the one figure here that is a fact about the device rather than about the
 * offset the caller supplied.
 */
const packCounterFace = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** Everything the outcome sentence needs, from either a live transfer or a stored journal row. */
interface TransportFigures {
  readonly outcome: DetailLogOutcome
  readonly elapsedMs: number
  readonly notificationBytes: number
  readonly notificationCount: number
  readonly assembledFrameCount: number
  readonly logFrameCount: number
  readonly recordCount: number
}

/**
 * The newest read, preferring the one this tab just took.
 *
 * A transfer dies on navigation and the journal does not, so the card is fed from the ledger
 * whenever there is no live transfer in hand — which is what makes the receipt worth reopening the
 * page for. The per-frame headers and the layout check below need the decoded records and exist
 * only while the transfer does.
 */
const lastRead = computed<{ readonly at: number | null; readonly figures: TransportFigures } | null>(
  () => {
    const transfer = detailLog.value
    if (transfer !== null) {
      return {
        at: null,
        figures: {
          outcome: transfer.outcome,
          elapsedMs: transfer.elapsedMs,
          notificationBytes: transfer.notificationBytes,
          notificationCount: transfer.notificationCount,
          assembledFrameCount: transfer.assembledFrameCount,
          logFrameCount: transfer.frames.length,
          recordCount: transfer.records.length,
        },
      }
    }
    const journaled = ledger.value?.reads[0]
    if (journaled === undefined) return null
    return {
      at: journaled.observedAt,
      figures: {
        outcome: journaled.outcome,
        elapsedMs: journaled.elapsedMs,
        notificationBytes: journaled.notificationBytes,
        notificationCount: journaled.notificationCount,
        assembledFrameCount: journaled.assembledFrameCount,
        logFrameCount: journaled.logFrameCount,
        recordCount: journaled.recordsReceived,
      },
    }
  },
)

const outcomeSentence = computed(() =>
  lastRead.value === null ? null : describeOutcome(lastRead.value.figures),
)

function describeOutcome(figures: TransportFigures): string {
  const seconds = (figures.elapsedMs / MS_PER_SECOND).toFixed(1)
  if (figures.outcome === 'no-answer') {
    return `Nothing came back — not one byte in ${seconds} s. The pack does not answer this command.`
  }
  if (figures.outcome === 'torn-burst') {
    return `${figures.notificationBytes} bytes arrived across ${figures.notificationCount} notifications and not one frame assembled from them. The pack answered; the reply was torn up in transit.`
  }
  if (figures.outcome === 'other-frames') {
    return `${figures.assembledFrameCount} frames assembled in ${seconds} s and not one was a detail log. The link is carrying whole frames; this firmware answers 0xA7 with no stored log.`
  }
  return `${figures.logFrameCount} log frames, ${figures.recordCount} records, ${figures.notificationBytes} bytes in ${seconds} s.`
}

/** What filing that read did, from this tab's own merge when it has one, else from the journal. */
const filingSentence = computed(() => {
  const merged = ringIngest.value
  const journaled = ledger.value?.reads[0]
  const figures =
    merged !== null
      ? merged
      : journaled === undefined
        ? null
        : {
            appended: journaled.recordsAppended,
            overlap: journaled.overlap,
            ringShift: journaled.ringShift,
            gapDeclared: journaled.gapDeclared,
            runsDiscarded: journaled.runsDiscarded,
          }
  if (figures === null) return null

  const parts: string[] = []
  if (figures.gapDeclared) {
    parts.push(
      'No record overlapped what this browser already holds, so the two stretches are kept apart rather than joined end to end.',
    )
  } else if (figures.overlap > 0 && figures.ringShift !== null) {
    parts.push(
      `${figures.overlap} of the records were already held; ${figures.appended === 0 ? 'nothing was new' : `${figures.appended} were new and are now filed`}.`,
    )
  } else if (figures.appended > 0) {
    parts.push(`${figures.appended} records filed.`)
  }
  if (figures.runsDiscarded > 0) {
    parts.push(
      `${figures.runsDiscarded} stretch${figures.runsDiscarded === 1 ? '' : 'es'} of the reply were too short to place and were discarded.`,
    )
  }
  return parts.length === 0 ? null : parts.join(' ')
})

/** Why a read is not in the archive: the pack could not be named, or the archive refused the write. */
const filingFailure = computed(() => {
  const note = ringFilingNote.value
  if (note !== null) return note
  const failure = ringIngest.value?.failure ?? null
  return failure === null ? null : `The archive could not keep this read: ${failure}.`
})

/** One line per frame, so a whole burst's chunking can be read off a single run. */
const frameLines = computed(() => {
  const transfer = detailLog.value
  if (transfer === null) return []
  return transfer.frames.map((header, position) => ({
    key: position,
    text: `#${position} · byte 5 0x${header.unidentifiedByte.toString(16).padStart(2, '0')} · first record ${header.firstRecordIndex} · carries ${header.recordCount}`,
  }))
})

/** By the pack's own counter rather than by ring index, which wraps and can be read out of order. */
const newestRecord = computed(() => {
  const transfer = detailLog.value
  if (transfer === null || transfer.records.length === 0) return null
  return transfer.records.reduce((newest, record) => (record.packClockMs > newest.packClockMs ? record : newest))
})

/**
 * How far behind the pack this browser's copy has fallen, and what that costs.
 *
 * Measured off the journal rather than off a record's resolved time: a successful read always
 * carries the ring's head, so the read's own wall clock states the same age without borrowing any
 * of the pack clock's uncertainty to do it.
 */
const staleness = computed(() => {
  const answered = ledger.value?.reads.find((read) => read.outcome === 'records-read')
  if (answered === undefined) return 'No stored log has been read into this browser yet.'
  const since = Math.floor((now.value - answered.observedAt) / SAMPLING_PERIOD_MS)
  return `Last read ${relativeAge(answered.observedAt, now.value)} — about ${since} record${since === 1 ? '' : 's'} since.`
})

// ── the clock panel ──────────────────────────────────────────────────────────

const zoneLine = computed(() => {
  const context = clock.value
  if (context === null) return null
  const browserOffset = browserStandardUtcOffsetMinutes(now.value)
  const read = `Read as ${utcLabel(context.packUtcOffsetMinutes)}.`
  if (!context.offsetIsGuessed) {
    return context.packUtcOffsetMinutes === browserOffset
      ? `${read} You confirmed that zone.`
      : `${read} You confirmed that zone; this browser stands at ${utcLabel(browserOffset)}.`
  }
  return `${read} That is this browser's own standard offset, not the pack's — confirm it if the pack lives here, change it if it lives elsewhere.`
})

const calibrationRows = computed(() => {
  const context = clock.value
  if (context === null) return []
  return context.calibrations.map((calibration) => ({
    key: calibration.atSeq,
    before: packCounterFace.format(
      packFaceInstant(calibration.beforeCounterSeconds, context.packUtcOffsetMinutes),
    ),
    after: packCounterFace.format(
      packFaceInstant(calibration.afterCounterSeconds, context.packUtcOffsetMinutes),
    ),
    step: calibration.stepSeconds === 0 ? 'no change' : aheadLabel(calibration.stepSeconds * MS_PER_SECOND),
  }))
})

const clockIntervalLine = computed(() => {
  const error = clockError.value
  if (error === null) return 'No read has measured the pack against this browser yet.'
  if (isPinned.value) {
    return `Pinned: the pack's clock runs ${aheadLabel(error.lowMs)} ahead of yours. Nothing below carries an uncertainty.`
  }
  return `The pack's clock reads between ${aheadLabel(error.lowMs)} and ${aheadLabel(error.highMs)} ahead of yours, across ${error.observations} read${error.observations === 1 ? '' : 's'}. Another read narrows that.`
})

/** The measured estimate is only worth pinning while it is an estimate and there is one to pin. */
const canPin = computed(() => !isPinned.value && clockMidpointMs.value !== null && packKey.value !== null)

async function confirmZone(): Promise<void> {
  const key = packKey.value
  const context = clock.value
  if (key === null || context === null) return
  await browser.setPackClock(key, {
    utcOffsetMinutes: context.packUtcOffsetMinutes,
    aheadSeconds: context.ownerAheadSeconds,
  })
}

async function pinMeasured(): Promise<void> {
  const key = packKey.value
  const context = clock.value
  const midpoint = clockMidpointMs.value
  if (key === null || context === null || midpoint === null) return
  // Pinning states the zone too: an error measured against one offset is not a statement about
  // another, so the two are written together rather than left to disagree.
  await browser.setPackClock(key, {
    utcOffsetMinutes: context.packUtcOffsetMinutes,
    aheadSeconds: Math.round(midpoint / MS_PER_SECOND),
  })
}

async function unpin(): Promise<void> {
  const key = packKey.value
  const context = clock.value
  if (key === null || context === null) return
  await browser.setPackClock(key, {
    utcOffsetMinutes: context.packUtcOffsetMinutes,
    aheadSeconds: null,
  })
}

// ── this pack's stored rows ──────────────────────────────────────────────────

const confirmingDelete = ref(false)

const held = computed(() => {
  const rows = records.value
  const context = clock.value
  if (context === null || rows.length === 0) return null

  const oldest = resolveRingInstant(rows[0], context)
  const newest = resolveRingInstant(rows[rows.length - 1], context)
  const span =
    oldest.basis === 'unresolved' || newest.basis === 'unresolved'
      ? null
      : `${dayStamp.format(oldest.at)} – ${dayStamp.format(newest.at)}`
  return { rows: rows.length, span }
})

async function removeLedger(): Promise<void> {
  const key = packKey.value
  confirmingDelete.value = false
  if (key === null) return
  await browser.deleteRingLedger(key)
}

// ── formatting ───────────────────────────────────────────────────────────────

/** A signed clock offset as the reader would say it: '7 h 01 m', '−12 min', '8 s'. */
function aheadLabel(ms: number): string {
  const total = Math.round(Math.abs(ms) / MS_PER_SECOND)
  const sign = ms < 0 ? '−' : ''
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${sign}${hours} h ${String(minutes).padStart(2, '0')} m`
  if (minutes > 0) return `${sign}${minutes} min`
  return `${sign}${seconds} s`
}

/** A half-width, said the way a tolerance is said. */
function spanLabel(halfWidthMs: number): string {
  if (halfWidthMs < UNCERTAINTY_FLOOR_MS) return 'under a minute'
  const minutes = Math.round(halfWidthMs / 60_000)
  return minutes < 90 ? `${minutes} minutes` : `${(minutes / 60).toFixed(1)} hours`
}

/** A zone offset written the way a zone is written, so +60 reads as the reader would say it. */
function utcLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '−' : '+'
  const total = Math.abs(offsetMinutes)
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return minutes === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${String(minutes).padStart(2, '0')}`
}
</script>

<template>
  <section class="stats" data-testid="stats-view">
    <header class="head">
      <h2 class="head-title">Stats &amp; history</h2>
      <p class="copy head-sub">
        The pack's own hourly record — charge, voltage, cell spread and what it logged — scoped to a
        range you choose.
      </p>
    </header>

    <div class="body">
      <!-- One panel for the whole range section when this browser has never read a ring. There is
           deliberately no per-card empty state and nothing solar-shaped: the controller refuses its
           history registers, so a placeholder there would wait for data that cannot arrive. -->
      <section v-if="ledgers.length === 0" class="card" data-testid="stats-no-ring">
        <header class="card-head">
          <h3 class="plate">Nothing read from this pack yet</h3>
        </header>
        <p class="copy state">
          The pack keeps its own log — about a month of hourly snapshots — and it stays on the pack
          until it is read. <a :href="connectHref">Connect the BMS</a> and read the stored log; every
          read adds whatever is new since the last one.
        </p>
        <div class="actions">
          <button
            type="button"
            :disabled="bmsState !== 'live' || detailLogReading"
            @click="readDetailLog()"
          >
            {{ detailLogReading ? 'Reading…' : 'Read stored log' }}
          </button>
          <span v-if="bmsState !== 'live'" class="muted">Connect the BMS first.</span>
        </div>
      </section>

      <template v-else>
        <!-- One filter row scopes every card below it: which pack, and which window of its log. -->
        <RangeFilter
          :model-value="range"
          :custom="customWindow"
          :ledgers="ledgers"
          :pack="packKey"
          @update:model-value="selectRange"
          @update:custom="selectCustom"
          @update:pack="packKey = $event"
        />

        <!-- One statement for the whole page: every record on a ledger shares one correction. -->
        <p v-if="provenance" class="copy provenance">{{ provenance }}</p>

        <SummaryTiles v-if="summary" :summary="summary" />

        <div v-if="summary" class="caveats">
          <p class="muted">
            Charge and discharge that cancel inside one hour are invisible at this cadence, so every
            energy figure here is a floor rather than a total.
          </p>
          <p v-for="refusal in refusals" :key="refusal.kind" class="muted">{{ refusal.text }}</p>
          <p v-if="undatedNote" class="muted">{{ undatedNote }}</p>
          <p v-if="unpairedNote" class="muted">{{ unpairedNote }}</p>
          <p v-if="ledgerStart" class="muted">{{ ledgerStart }}</p>
        </div>

        <PackTimeline v-if="showTrace" :track="track" :loading="browser.ringLoading.value" />

        <EnergyInOut :buckets="energyBuckets" :unit="bucketUnit" :estimated="true" />

        <EventsPerDay :days="eventDays" :range="range" />
      </template>

      <!-- Lifetime counters, straight off the pack. -->
      <section v-if="lifetime !== null" class="card">
        <header class="card-head">
          <h3 class="plate">Lifetime</h3>
          <p class="muted">Since the pack was commissioned{{ lifetime.model ? ` · ${lifetime.model}` : '' }}</p>
        </header>
        <dl class="lifetime-tiles">
          <div v-if="lifetime.cycleCount !== null" class="chip">
            <dt>Cycles</dt>
            <dd class="secondary-figure">{{ lifetime.cycleCount }}</dd>
          </div>
          <div v-if="lifetime.cycledCapacity !== null" class="chip">
            <dt>Cycled capacity</dt>
            <dd class="secondary-figure">{{ ampHours(lifetime.cycledCapacity, 0) }}</dd>
          </div>
          <div v-if="lifetime.powerOnCount !== null" class="chip">
            <dt>Power-ons</dt>
            <dd class="secondary-figure">{{ lifetime.powerOnCount }}</dd>
          </div>
          <div v-if="lifetime.uptimeSeconds !== null" class="chip">
            <dt>Uptime</dt>
            <dd class="secondary-figure">{{ duration(lifetime.uptimeSeconds) }}</dd>
          </div>
        </dl>
      </section>

      <!-- The device's own event log. -->
      <section class="card">
        <header class="card-head">
          <h3 class="plate">Device logbook</h3>
          <p v-if="logbookAge !== null" class="muted">
            Read from the pack {{ logbookAge }}. Power cycles and protection events, back to first power-on.
          </p>
        </header>

        <p v-if="logbookRows.length === 0" class="copy state">
          <template v-if="source === 'live'">Waiting for the pack to send its logbook…</template>
          <template v-else>
            No logbook read yet. <a :href="connectHref">Connect the BMS</a> and it is fetched
            automatically; it then stays here for review.
          </template>
        </p>

        <ul v-else class="logbook">
          <li v-for="row in logbookRows" :key="row.key" class="event">
            <span class="when readout">{{ row.when }}</span>
            <span class="what">{{ row.label }}</span>
          </li>
        </ul>
      </section>

      <!-- The read receipt: what came back, what filing it did, and where the clock stands. -->
      <section class="card" data-testid="stats-read-receipt">
        <header class="card-head">
          <h3 class="plate">The pack's stored log</h3>
          <p class="muted">
            Fetched by itself when this browser's copy falls a day behind, and any time you ask. What
            comes back is kept, and feeds the cards above.
          </p>
        </header>

        <div class="actions">
          <button
            type="button"
            :disabled="bmsState !== 'live' || detailLogReading"
            @click="readDetailLog()"
          >
            {{ detailLogReading ? 'Reading…' : 'Read stored log' }}
          </button>
          <span v-if="bmsState !== 'live'" class="muted">Connect the BMS first.</span>
          <span v-else-if="detailLogReading" class="muted">
            Waiting on the pack. It has up to thirty seconds, and ends early once the reply goes quiet.
          </span>
          <span v-else class="muted">{{ staleness }}</span>
        </div>

        <p v-if="detailLogError !== null" class="copy failure">{{ detailLogError }}</p>

        <template v-if="lastRead !== null">
          <p class="copy outcome">
            <template v-if="lastRead.at !== null">Read {{ stamp.format(lastRead.at) }}. </template>
            {{ outcomeSentence }}
          </p>

          <p v-if="filingSentence" class="copy filed">{{ filingSentence }}</p>
          <p v-if="filingFailure" class="copy failure">{{ filingFailure }}</p>

          <dl class="lifetime-tiles">
            <div class="chip">
              <dt>Raw bytes</dt>
              <dd class="secondary-figure">{{ lastRead.figures.notificationBytes }}</dd>
            </div>
            <div class="chip">
              <dt>Notifications</dt>
              <dd class="secondary-figure">{{ lastRead.figures.notificationCount }}</dd>
            </div>
            <div class="chip">
              <dt>Log frames</dt>
              <dd class="secondary-figure">{{ lastRead.figures.logFrameCount }}</dd>
            </div>
            <div class="chip">
              <dt>Elapsed</dt>
              <dd class="secondary-figure">{{ (lastRead.figures.elapsedMs / 1000).toFixed(1) }} s</dd>
            </div>
          </dl>

          <ul v-if="frameLines.length > 0" class="frames">
            <li v-for="line in frameLines" :key="line.key" class="readout frame">{{ line.text }}</li>
          </ul>

          <!-- The layout check, on screen rather than left to be remembered: the newest stored
               snapshot beside what the instruments read right now. Wrong offsets or a wrong stride
               show up here as a voltage and a current that do not match the pack in front of you. -->
          <div v-if="newestRecord !== null" class="compare">
            <p class="muted">
              Newest stored record, ring index {{ newestRecord.index }}. Pack counter reads
              <span class="readout">{{ packCounterFace.format(newestRecord.packClockMs) }}</span> —
              resolved against the offset the read was decoded with, that is
              <span class="readout">{{ stamp.format(newestRecord.recordedAt) }}</span
              >.
            </p>
            <dl class="lifetime-tiles">
              <div class="chip">
                <dt>Stored pack voltage</dt>
                <dd class="secondary-figure">{{ volts(newestRecord.packVoltage, 2) }}</dd>
              </div>
              <div class="chip">
                <dt>Live pack voltage</dt>
                <dd class="secondary-figure">{{ battery === null ? '—' : volts(battery.packVoltage, 2) }}</dd>
              </div>
              <div class="chip">
                <dt>Stored current</dt>
                <dd class="secondary-figure">{{ amps(newestRecord.current) }}</dd>
              </div>
              <div class="chip">
                <dt>Live current</dt>
                <dd class="secondary-figure">{{ battery === null ? '—' : amps(battery.current) }}</dd>
              </div>
            </dl>
          </div>
        </template>

        <!-- The clock panel: which zone the counter was read against, every rewrite the ring holds,
             and where the pack's face sits against this browser's. -->
        <div v-if="clock !== null" class="panel">
          <h4 class="panel-title">The pack's clock</h4>

          <p class="copy">{{ zoneLine }}</p>
          <p class="copy">{{ clockIntervalLine }}</p>

          <div class="actions">
            <button v-if="clock.offsetIsGuessed" type="button" @click="confirmZone()">
              Confirm this zone
            </button>
            <button v-if="canPin" type="button" @click="pinMeasured()">Pin as exact</button>
            <button v-if="isPinned" type="button" @click="unpin()">Clear the pin</button>
          </div>

          <div v-if="calibrationRows.length > 0" class="table-scroll">
            <table class="grid-table">
              <caption class="muted">
                Every clock rewrite the ring still holds, as the pack's own face either side of it.
                Records keep the face they were written with; the correction is applied on read.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Face before</th>
                  <th scope="col">Face after</th>
                  <th scope="col">Step</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in calibrationRows" :key="row.key">
                  <td class="readout-cell">{{ row.before }}</td>
                  <td class="readout-cell">{{ row.after }}</td>
                  <td class="readout-cell">{{ row.step }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- What this browser is holding for the pack, and the one control that gives it back. -->
        <div v-if="held !== null" class="panel">
          <h4 class="panel-title">Kept here</h4>
          <p class="copy">
            {{ held.rows }} record{{ held.rows === 1 ? '' : 's' }} held for this pack<template
              v-if="held.span"
            >, {{ held.span }}</template
            >. They are outside the recording budget: pruning a session can never take them, and they
            can never take a session.
          </p>
          <div class="actions">
            <button type="button" @click="confirmingDelete = true">Delete this pack's log</button>
          </div>
          <div v-if="confirmingDelete" class="actions">
            <p class="copy">
              Delete every stored record for this pack? The pack keeps its own ring, so a later read
              recovers whatever it still holds — about a month — and nothing older.
            </p>
            <button type="button" class="danger" @click="removeLedger()">Delete</button>
            <button type="button" @click="confirmingDelete = false">Keep</button>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.stats {
  container-type: inline-size;
}

.head {
  padding: clamp(1rem, 3vw, 1.75rem) var(--pad) 0;
}

.head-title {
  margin: 0;
  font-family: var(--font-body);
  font-weight: 600;
  font-size: clamp(1.35rem, 1rem + 1.6vw, 1.85rem);
  letter-spacing: -0.01em;
  color: var(--ink);
}

.head-sub {
  margin: 0.4rem 0 0;
}

.body {
  display: flex;
  flex-direction: column;
  gap: clamp(1rem, 2.5vw, 1.5rem);
  padding: 1.25rem var(--pad) 2.5rem;
}

/* The one provenance sentence, set apart from the cards it qualifies. */
.provenance {
  margin: 0;
  color: var(--ink-secondary);
}

/* What the fold refused and why, each on its own line under the tiles it is missing from. */
.caveats {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.caveats p {
  margin: 0;
}

/* Cards — the warm container the instruments sit in. */
.card {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
  padding: var(--pad);
}

.card-head {
  margin-bottom: 1rem;
}

.card-head h3 {
  margin: 0;
}

.card-head .muted {
  margin: 0.35rem 0 0;
}

.state {
  margin: 0 0 1rem;
}

.state a {
  color: var(--pack-ink);
}

/* Lifetime — inset chips on the card, a step down from the summary tiles above. */
.lifetime-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.75rem;
  margin: 0;
}

.chip {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.85rem 0.95rem;
  background: var(--raised);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
}

.chip dt {
  font-family: var(--font-label);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
}

.chip dd {
  margin: 0;
  color: var(--ink);
}

/* Logbook */
.logbook {
  list-style: none;
  margin: 0;
  padding: 0;
}

.event {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--gridline);
}

.event:first-child {
  padding-top: 0;
}

.event:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.when {
  flex: none;
  width: 8.5rem;
  color: var(--ink-muted);
  font-size: 0.8125rem;
}

.what {
  color: var(--ink);
}

/* The read receipt */
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}

.actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--card-border);
  color: var(--ink);
  border-radius: var(--r-sm);
  padding: 0.6rem 1rem;
  min-height: var(--tap);
  font-family: var(--font-label);
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 600;
}

.actions button:hover:not(:disabled) {
  border-color: var(--ink-secondary);
}

.actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.actions button.danger {
  color: var(--status-critical-ink);
  border-color: var(--status-critical);
}

.actions .copy {
  flex-basis: 100%;
  margin: 0;
}

.outcome {
  margin: 1rem 0 0.5rem;
}

.filed {
  margin: 0 0 1rem;
  color: var(--ink-secondary);
}

.failure {
  margin: 1rem 0 0;
  color: var(--status-serious);
}

/* The frame headers are the paging evidence, so all of them are listed; the box scrolls rather
   than pushing the comparison below it off the screen. */
.frames {
  list-style: none;
  margin: 1rem 0 0;
  padding: 0.6rem 0.75rem;
  background: var(--raised);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  max-height: 12rem;
  overflow: auto;
}

.frame {
  font-size: 0.75rem;
  color: var(--ink-secondary);
  white-space: nowrap;
}

.compare {
  margin-top: 1.25rem;
  padding-top: 1rem;
  border-top: 1px solid var(--gridline);
}

.compare > .muted {
  margin: 0 0 0.85rem;
}

/* The clock and storage panels, each a fenced-off section of the receipt. */
.panel {
  margin-top: 1.25rem;
  padding-top: 1rem;
  border-top: 1px solid var(--gridline);
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.panel-title {
  margin: 0;
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-muted);
}

.panel .copy {
  margin: 0;
}

/* The one wide child scrolls inside its own box; the page body never scrolls sideways. */
.table-scroll {
  overflow-x: auto;
}

.grid-table {
  width: 100%;
  min-width: 24rem;
  border-collapse: collapse;
  font-size: 0.8125rem;
}

.grid-table caption {
  text-align: left;
  margin-bottom: 0.5rem;
}

.grid-table th {
  font-family: var(--font-label);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
  font-weight: 600;
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--gridline);
}

.grid-table td {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--gridline);
  color: var(--ink);
}

.readout-cell {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

@container (max-width: 560px) {
  .when {
    width: 6.5rem;
  }
}
</style>
