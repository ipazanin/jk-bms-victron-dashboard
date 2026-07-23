/**
 * How much of the Log to keep, and what to give up first.
 *
 * The budget is counted in samples, never in bytes. The columnar layout makes byte cost a
 * deterministic function of row count, so a sample cap is exactly enforceable with no I/O at all;
 * `navigator.storage.estimate()` is padded by design, lags the browser's own quota accounting and
 * is absent in several of the browsers this has to degrade in, so it feeds one display line and
 * decides nothing.
 *
 * Two things are given up, in this order. Whole sessions go first, oldest first, because age is
 * the fairest thing to lose and a session that dies whole leaves no misleading fragment behind.
 * Only when nothing may be evicted — every remaining session is open, freshly heartbeating in
 * another tab, or on screen — is a single session cut at the head, and then it has to say so:
 * `retainedFrom` is the wall time of the first surviving row, so a view can never imply a session
 * began where its retained data begins.
 *
 * Protection is expressed over stored fields rather than over whatever the calling tab believes,
 * because the tab that overran the budget is rarely the tab whose session is at risk.
 *
 * This module decides; it does not act. The adapter executes the plan inside the same transaction
 * as the commit that overran the budget.
 */

import type { SessionId, StreamName } from './types'

/**
 * 2,000,000 rows across both streams is roughly 48 MB at these column widths — about 278 hours of
 * two-radio recording at 1 Hz, or 555 hours of pack-only. What argues against a larger cap is not
 * the quota, since Chromium offers a large fraction of the disk, but blast radius: eviction under
 * storage pressure is per-origin and total, so a fat origin is a more attractive target and what
 * it loses is the whole Log rather than its oldest slice.
 */
export const MAX_TOTAL_SAMPLES = 2_000_000

/** Prune down to here, not to the cap, or every subsequent seal fires another prune transaction. */
export const PRUNE_TARGET_RATIO = 0.9

/** A session under this many rows is deleted on close rather than kept as a row of noise. */
export const MIN_SESSION_SAMPLES = 10

/** Bounds session-row growth independently of the sample budget. */
export const MAX_SESSIONS = 500

/** Where one stored chunk sits, in the two coordinates pruning needs: sequence and wall time. */
export interface ChunkExtent {
  readonly stream: StreamName
  readonly seq: number
  readonly length: number
  /** Wall clock of the chunk's first row, which is what truncation reports as retainedFrom. */
  readonly baseAt: number
}

export interface ChunkRef {
  readonly stream: StreamName
  readonly seq: number
}

export interface PruneCandidate {
  readonly id: SessionId
  readonly startedAt: number
  readonly sealedSamples: number
  readonly state: 'open' | 'closed'
  readonly heartbeatAt: number
  readonly chunks: readonly ChunkExtent[]
}

export interface PruneProtection {
  readonly now: number
  /** Sessions whose heartbeat is fresher than this are live in some tab and are never touched. */
  readonly heartbeatStaleMs: number
  readonly viewedSessionId: SessionId | null
}

export interface PruneTruncation {
  readonly sessionId: SessionId
  readonly dropChunks: readonly ChunkRef[]
  readonly freedSamples: number
  /** Wall clock of the first row that survives. Always present, so the hole is always declarable. */
  readonly retainedFrom: number
}

export interface PrunePlan {
  readonly evict: readonly SessionId[]
  /** Only when eviction alone cannot reach the target: one session can exceed the whole budget. */
  readonly truncate: PruneTruncation | null
  readonly projectedTotal: number
}

/**
 * Chooses what to drop so the archive fits, given every session row and the counter they sum to.
 *
 * Nothing is chosen once the target is met, so the plan is empty in the ordinary case and the
 * caller can skip the work entirely.
 */
export function planPrune(
  candidates: readonly PruneCandidate[],
  totalSamples: number,
  protect: PruneProtection,
): PrunePlan {
  if (totalSamples <= MAX_TOTAL_SAMPLES && candidates.length <= MAX_SESSIONS) {
    return { evict: [], truncate: null, projectedTotal: totalSamples }
  }

  const oldestFirst = [...candidates].sort((left, right) => left.startedAt - right.startedAt)
  const target = Math.floor(MAX_TOTAL_SAMPLES * PRUNE_TARGET_RATIO)
  const evict: SessionId[] = []
  const survivors: PruneCandidate[] = []
  let projectedTotal = totalSamples
  let sessionCount = oldestFirst.length

  for (const candidate of oldestFirst) {
    const withinBudget = projectedTotal <= target && sessionCount <= MAX_SESSIONS
    if (withinBudget || isProtected(candidate, protect)) {
      survivors.push(candidate)
      continue
    }
    evict.push(candidate.id)
    projectedTotal -= candidate.sealedSamples
    sessionCount -= 1
  }

  if (projectedTotal <= target) return { evict, truncate: null, projectedTotal }

  const truncate = planTruncation(survivors, projectedTotal - target)
  if (truncate === null) return { evict, truncate: null, projectedTotal }
  return { evict, truncate, projectedTotal: projectedTotal - truncate.freedSamples }
}

function isProtected(candidate: PruneCandidate, protect: PruneProtection): boolean {
  if (candidate.id === protect.viewedSessionId) return true
  if (candidate.state === 'open') return true
  return protect.now - candidate.heartbeatAt < protect.heartbeatStaleMs
}

/**
 * Cuts the head off the session holding the most, which by the time this runs is the one session
 * that alone exceeds the budget. Cutting the oldest survivor instead would free almost nothing
 * while still putting a hole in a session, and the next seal would come straight back.
 */
function planTruncation(
  survivors: readonly PruneCandidate[],
  excess: number,
): PruneTruncation | null {
  const fattest = largestSession(survivors)
  if (fattest === null) return null

  const dropped: ChunkExtent[] = []
  let freedSamples = 0
  for (const chunk of droppableChunks(fattest.chunks)) {
    if (freedSamples >= excess) break
    dropped.push(chunk)
    freedSamples += chunk.length
  }
  if (dropped.length === 0) return null

  return {
    sessionId: fattest.id,
    dropChunks: dropped.map((chunk) => ({ stream: chunk.stream, seq: chunk.seq })),
    freedSamples,
    retainedFrom: earliestBaseAt(fattest.chunks, dropped),
  }
}

function largestSession(candidates: readonly PruneCandidate[]): PruneCandidate | null {
  let fattest: PruneCandidate | null = null
  for (const candidate of candidates) {
    if (fattest === null || candidate.sealedSamples > fattest.sealedSamples) fattest = candidate
  }
  return fattest
}

/**
 * Chunks that may be cut, oldest first. The highest sequence of each stream is the tail — the one
 * chunk still being written and the only copy of the newest rows — and is never offered.
 */
function droppableChunks(chunks: readonly ChunkExtent[]): ChunkExtent[] {
  const tailSeq = new Map<StreamName, number>()
  for (const chunk of chunks) {
    const highest = tailSeq.get(chunk.stream)
    if (highest === undefined || chunk.seq > highest) tailSeq.set(chunk.stream, chunk.seq)
  }
  return chunks
    .filter((chunk) => chunk.seq !== tailSeq.get(chunk.stream))
    .sort((left, right) => left.baseAt - right.baseAt)
}

function earliestBaseAt(
  chunks: readonly ChunkExtent[],
  dropped: readonly ChunkExtent[],
): number {
  const cut = new Set(dropped.map((chunk) => `${chunk.stream}:${chunk.seq}`))
  let earliest = Number.POSITIVE_INFINITY
  for (const chunk of chunks) {
    if (cut.has(`${chunk.stream}:${chunk.seq}`)) continue
    if (chunk.baseAt < earliest) earliest = chunk.baseAt
  }
  return earliest
}
