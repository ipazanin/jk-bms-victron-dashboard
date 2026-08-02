/**
 * Placing the pack's own clock face against the real one.
 *
 * Two things are true at once and the whole module is the difference between them. Relative
 * alignment is exact: the pack writes an adjacent pair of records whenever its clock is set — the
 * face before, then the face after — so every rewrite between an old record and now is on record,
 * and any stored record can be brought onto the current face by arithmetic that guesses nothing.
 * Absolute placement is not derivable at all: the pair says the clock moved, never which side of it
 * was right, so the whole timeline slides by one unknown constant no read supplies.
 *
 * That constant is bounded rather than invented. A read fixes the newest scheduled record to within
 * one sampling period of the moment it was taken, which is ±30 minutes about the midpoint — fine for
 * day buckets and not fine for anything finer. Reads land at different phases of that period, so
 * intervals intersect and the bound narrows for free with use. Only the owner can close it.
 *
 * Segments are intervals of SEQ, not of counter. That is the whole reason the ledger is ordered by
 * write order: a backward rewrite makes two segments overlap in counter space, so a counter-keyed
 * segment model has to declare records ambiguous that seq places without any ambiguity at all. The
 * ring already contains a −1 s rewrite, and the next correction on this pack will be about −7 h.
 *
 * Crystal drift within a segment is not modelled. Nothing here rewrites a stored counter.
 */

import { RTC_EPOCH_UTC_MS, decodeDetailLogRecord } from '../bms/detailLog'
import type { ClockBasis } from './ClockBasis'
import type { ClockErrorInterval } from './ClockErrorInterval'
import type { PackClockCalibration } from './PackClockCalibration'
import type { ResolvedInstant } from './ResolvedInstant'
import type { RingClockContext } from './RingClockContext'
import type { RingClockSegment } from './RingClockSegment'
import type { RingReadRow } from './RingReadRow'
import type { RingRecordRow } from './RingRecordRow'
import type { StoredRingLedger } from './StoredRingLedger'

/** The event a record carries when the pack's clock was set. */
const CLOCK_REWRITE_EVENT_CODE = 0x3b

/**
 * The pack samples on this period, not on 3,600 s: the device crystal is slow and every observed
 * gap between consecutive scheduled records is 3,601 with no exceptions. It is the width of the
 * window a single read can bound the clock error to.
 */
export const PACK_SAMPLING_PERIOD_SECONDS = 3_601

const MILLISECONDS_PER_MINUTE = 60_000

/**
 * Neither argument is read by the caller here — only the event code is wanted, and that byte moves
 * with neither. Decoding through the one decoder rather than reaching for the byte is what keeps a
 * correction to the record layout reinterpreting every stored row.
 */
const UNREAD_RING_INDEX = 0
const UNREAD_UTC_OFFSET_MINUTES = 0

/**
 * The instant the pack's clock face names, uncorrected: its counter laid on the RTC epoch and read
 * against the installation's standard offset, which is in force all year because the counter is a
 * standard-time wall clock rather than a local one.
 */
export function packFaceInstant(packClockSeconds: number, packUtcOffsetMinutes: number): number {
  return (
    RTC_EPOCH_UTC_MS + packClockSeconds * 1000 - packUtcOffsetMinutes * MILLISECONDS_PER_MINUTE
  )
}

/**
 * Reads the rewrites out of the ledger, walking it in seq order.
 *
 * Runs of rewrite records pair off from the start of the run: `(0,1)`, `(2,3)`, and so on. That is
 * not a convention but a reading of the data — on the captured ring the run 794–797 pairs into a
 * +25,268 s step and a no-op, where the alternative pairing produces a nonsensical +613 s.
 *
 * A run of odd length is one half of a pair lost to the ring's tail or to pruning. Its whole pairs
 * are returned and the leftover is counted, never guessed at: an unpaired rewrite means the step
 * across it is unknown, and a screen has to be able to say so.
 */
export function calibrationsIn(records: readonly RingRecordRow[]): {
  readonly paired: readonly PackClockCalibration[]
  readonly unpaired: number
} {
  const paired: PackClockCalibration[] = []
  let unpaired = 0
  let run: RingRecordRow[] = []

  const closeRun = (): void => {
    for (let at = 0; at + 1 < run.length; at += 2) {
      const before = run[at]
      const after = run[at + 1]
      paired.push({
        atSeq: after.seq,
        beforeCounterSeconds: before.packClockSeconds,
        afterCounterSeconds: after.packClockSeconds,
        stepSeconds: after.packClockSeconds - before.packClockSeconds,
      })
    }
    if (run.length % 2 === 1) unpaired += 1
    run = []
  }

  for (const record of records) {
    if (isClockRewrite(record)) {
      run.push(record)
      continue
    }
    closeRun()
  }
  closeRun()

  return { paired, unpaired }
}

/**
 * Cuts the ledger at every rewrite, on the record carrying the new face.
 *
 * `toCurrentFaceSeconds` is the sum of the steps recorded strictly after a segment, so adding it to
 * any counter inside that segment states the same instant on the face the pack is reading today.
 * The current segment's is zero by construction.
 */
export function ringClockSegments(
  calibrations: readonly PackClockCalibration[],
): readonly RingClockSegment[] {
  const ordered = [...calibrations].sort((left, right) => left.atSeq - right.atSeq)
  const segments: RingClockSegment[] = []

  let toSeq = Number.MAX_SAFE_INTEGER
  let toCurrentFaceSeconds = 0
  for (let at = ordered.length - 1; at >= 0; at -= 1) {
    segments.unshift({ fromSeq: ordered[at].atSeq, toSeq, toCurrentFaceSeconds })
    toSeq = ordered[at].atSeq
    toCurrentFaceSeconds += ordered[at].stepSeconds
  }
  // seq is handed out from zero and only ever rises, so the oldest segment starts below every row.
  segments.unshift({ fromSeq: 0, toSeq, toCurrentFaceSeconds })

  return segments
}

/** The segment a row belongs to. Segments tile the whole of seq space, so this always answers. */
export function segmentAt(
  segments: readonly RingClockSegment[],
  seq: number,
): RingClockSegment {
  for (let at = segments.length - 1; at >= 0; at -= 1) {
    if (seq >= segments[at].fromSeq) return segments[at]
  }
  return segments[0]
}

/**
 * Everything one ledger knows about its own clock, gathered once.
 *
 * The browser's offset stands in until the owner confirms the installation's zone, and the context
 * says which of the two it is carrying — a guess that reads like an answer is the failure this
 * flag exists to prevent.
 */
export function ringClockContextOf(
  ledger: StoredRingLedger,
  browserOffsetMinutes: number,
): RingClockContext {
  const { paired, unpaired } = calibrationsIn(ledger.records)
  const confirmedOffset = ledger.device?.packUtcOffsetMinutes ?? null

  return {
    packUtcOffsetMinutes: confirmedOffset ?? browserOffsetMinutes,
    offsetIsGuessed: confirmedOffset === null,
    segments: ringClockSegments(paired),
    calibrations: paired,
    unpairedCalibrations: unpaired,
    reads: ledger.reads,
    ownerAheadSeconds: ledger.device?.packClockAheadSeconds ?? null,
  }
}

/**
 * How far the pack's clock ran ahead of the real one over a given segment, or null when nothing
 * anchors this ledger to a real clock at all.
 *
 * Every read is folded onto the current segment's face first, so a measurement taken before a
 * rewrite still constrains one taken after it — which is exactly what makes the bound narrow. The
 * captured pair proves it: a read at 09:49 bounds the pre-rewrite face, a read at 13:14 bounds the
 * post-rewrite one, and together they place the current face inside 35 minutes where either alone
 * gives an hour.
 *
 * An owner's pin replaces the measurements rather than joining them; it is an answer, not another
 * observation.
 */
export function clockErrorOf(
  context: RingClockContext,
  segment: RingClockSegment,
): ClockErrorInterval | null {
  const current = currentFaceErrorOf(context)
  if (current === null) return null

  const backToSegmentMs = segment.toCurrentFaceSeconds * 1000
  return {
    lowMs: current.lowMs - backToSegmentMs,
    highMs: current.highMs - backToSegmentMs,
    observations: current.observations,
  }
}

/**
 * A stored record placed on the real clock, with the half-width that placed it.
 *
 * The stored counter is not touched. What is returned is the pack's own face moved by the
 * correction in force over that record's segment, and an unresolved segment yields the raw face
 * with an infinite bound rather than a plausible instant: a record whose day nobody knows is still
 * counted in the totals, and is simply never bucketed.
 */
export function resolveRingInstant(
  record: RingRecordRow,
  context: RingClockContext,
): ResolvedInstant {
  const segment = segmentAt(context.segments, record.seq)
  const face = packFaceInstant(record.packClockSeconds, context.packUtcOffsetMinutes)
  const error = clockErrorOf(context, segment)
  if (error === null) {
    return { at: face, uncertaintyMs: Number.POSITIVE_INFINITY, basis: 'unresolved' }
  }

  return {
    at: face - (error.lowMs + error.highMs) / 2,
    uncertaintyMs: (error.highMs - error.lowMs) / 2,
    basis: basisOf(context, segment),
  }
}

function basisOf(context: RingClockContext, segment: RingClockSegment): ClockBasis {
  if (context.ownerAheadSeconds !== null) return 'owner-pinned'
  const measured = measurementsOf(context)
  if (measured.some((each) => each.segment === segment)) return 'measured'
  return measured.length > 0 ? 'propagated' : 'unresolved'
}

interface FaceMeasurement {
  readonly segment: RingClockSegment
  readonly lowMs: number
  readonly highMs: number
}

/**
 * The error over the CURRENT face, as every read and any pin together bound it.
 *
 * Intersecting is the whole point: each read rules out part of what the last one allowed. Should
 * two ever contradict each other outright — a drifting crystal, or a rewrite the ring no longer
 * holds both halves of — the newest read is kept alone rather than the pair widened, because the
 * newest is the only one that is still a statement about the face in force now.
 */
function currentFaceErrorOf(context: RingClockContext): ClockErrorInterval | null {
  if (context.ownerAheadSeconds !== null) {
    const pinned = context.ownerAheadSeconds * 1000
    return { lowMs: pinned, highMs: pinned, observations: 0 }
  }

  let lowMs = Number.NEGATIVE_INFINITY
  let highMs = Number.POSITIVE_INFINITY
  let observations = 0

  for (const measurement of measurementsOf(context)) {
    const low = Math.max(lowMs, measurement.lowMs)
    const high = Math.min(highMs, measurement.highMs)
    if (low >= high) {
      lowMs = measurement.lowMs
      highMs = measurement.highMs
      observations = 1
      continue
    }
    lowMs = low
    highMs = high
    observations += 1
  }

  return observations === 0 ? null : { lowMs, highMs, observations }
}

/** Oldest read first, so a contradiction leaves the newest standing. */
function measurementsOf(context: RingClockContext): readonly FaceMeasurement[] {
  return [...context.reads]
    .sort((left, right) => left.observedAt - right.observedAt)
    .flatMap((read) => {
      const measurement = measurementOf(read, context)
      return measurement === null ? [] : [measurement]
    })
}

function measurementOf(read: RingReadRow, context: RingClockContext): FaceMeasurement | null {
  if (read.newestSampleCounter === null || read.newestSampleSeq === null) return null

  const segment = segmentAt(context.segments, read.newestSampleSeq)
  const face = packFaceInstant(read.newestSampleCounter, context.packUtcOffsetMinutes)
  const lowMs = face - read.observedAt + segment.toCurrentFaceSeconds * 1000
  return { segment, lowMs, highMs: lowMs + PACK_SAMPLING_PERIOD_SECONDS * 1000 }
}

function isClockRewrite(record: RingRecordRow): boolean {
  const decoded = decodeDetailLogRecord(record.bytes, UNREAD_RING_INDEX, {
    packUtcOffsetMinutes: UNREAD_UTC_OFFSET_MINUTES,
  })
  return decoded.eventCode === CLOCK_REWRITE_EVENT_CODE
}
