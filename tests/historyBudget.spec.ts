import { describe, expect, it } from 'vitest'

import {
  MAX_SESSIONS,
  MAX_TOTAL_SAMPLES,
  PRUNE_TARGET_RATIO,
  planPrune,
} from '../src/domain/history/budget'
import type { ChunkExtent, PruneCandidate, PruneProtection } from '../src/domain/history/budget'
import { HEARTBEAT_STALE_MS, PACK_STREAM, SOLAR_STREAM } from '../src/domain/history/types'
import type { StreamName } from '../src/domain/history/types'
import { SAMPLE_EPOCH } from './support/samples'

// Pruning decides; it never acts. So every case here is about the shape of the plan — what is
// given up, in what order, and what is never offered — and none of it needs a database.

const TARGET = Math.floor(MAX_TOTAL_SAMPLES * PRUNE_TARGET_RATIO)
const NOW = SAMPLE_EPOCH + 24 * 60 * 60_000
const HOUR_MS = 3_600_000

function unprotected(overrides: Partial<PruneProtection> = {}): PruneProtection {
  return { now: NOW, heartbeatStaleMs: HEARTBEAT_STALE_MS, viewedSessionId: null, ...overrides }
}

/** A closed session whose writer is long gone, which is the ordinary candidate. */
function candidate(index: number, overrides: Partial<PruneCandidate> = {}): PruneCandidate {
  return {
    id: `session-${index}`,
    startedAt: SAMPLE_EPOCH + index * HOUR_MS,
    sealedSamples: 500_000,
    state: 'closed',
    heartbeatAt: SAMPLE_EPOCH + index * HOUR_MS,
    chunks: [],
    ...overrides,
  }
}

function chunks(count: number, length: number, stream: StreamName = PACK_STREAM): ChunkExtent[] {
  return Array.from({ length: count }, (_unused, seq) => ({
    stream,
    seq,
    length,
    baseAt: SAMPLE_EPOCH + seq * HOUR_MS,
  }))
}

function totalOf(candidates: readonly PruneCandidate[]): number {
  return candidates.reduce((sum, each) => sum + each.sealedSamples, 0)
}

describe('an archive inside its budget', () => {
  it('plans nothing, so the ordinary commit does no extra work at all', () => {
    const candidates = [candidate(0), candidate(1)]

    const plan = planPrune(candidates, MAX_TOTAL_SAMPLES, unprotected())

    expect(plan.evict).toEqual([])
    expect(plan.truncate).toBeNull()
    expect(plan.projectedTotal).toBe(MAX_TOTAL_SAMPLES)
  })

  it('plans nothing one sample under the cap and something one sample over it', () => {
    const candidates = [candidate(0), candidate(1), candidate(2), candidate(3), candidate(4)]

    expect(planPrune(candidates, MAX_TOTAL_SAMPLES, unprotected()).evict).toEqual([])
    expect(planPrune(candidates, MAX_TOTAL_SAMPLES + 1, unprotected()).evict.length).toBeGreaterThan(0)
  })
})

describe('an archive over its budget', () => {
  const candidates = [candidate(0), candidate(1), candidate(2), candidate(3), candidate(4)]

  it('gives up whole sessions, oldest first', () => {
    // Age is the fairest thing to lose, and a session that dies whole leaves no fragment behind
    // claiming to be a watch.
    const plan = planPrune(candidates, totalOf(candidates), unprotected())

    expect(plan.evict).toEqual(['session-0', 'session-1'])
  })

  it('stops as soon as it is inside the target rather than emptying the archive', () => {
    // Down to ninety per cent and not to the cap: stopping at the cap would fire another prune
    // transaction on the very next seal.
    const plan = planPrune(candidates, totalOf(candidates), unprotected())

    expect(plan.projectedTotal).toBeLessThanOrEqual(TARGET)
    expect(plan.projectedTotal + 500_000).toBeGreaterThan(TARGET)
    expect(plan.truncate).toBeNull()
  })

  it('leaves an evicted session out of the projected total exactly once', () => {
    const plan = planPrune(candidates, totalOf(candidates), unprotected())

    expect(plan.projectedTotal).toBe(totalOf(candidates) - plan.evict.length * 500_000)
  })

  it('reads the order from startedAt and not from the order it was handed', () => {
    const shuffled = [candidate(3), candidate(0), candidate(4), candidate(1), candidate(2)]

    expect(planPrune(shuffled, totalOf(shuffled), unprotected()).evict).toEqual([
      'session-0',
      'session-1',
    ])
  })
})

describe('what pruning is never allowed to take', () => {
  it('skips a session another tab still has open', () => {
    const candidates = [
      candidate(0, { state: 'open' }),
      candidate(1),
      candidate(2),
      candidate(3),
      candidate(4),
    ]

    const plan = planPrune(candidates, totalOf(candidates), unprotected())

    expect(plan.evict).not.toContain('session-0')
    expect(plan.evict).toEqual(['session-1', 'session-2'])
  })

  it('skips a session whose heartbeat is still fresh, whatever this tab believes', () => {
    // Protection is derived from the stored row rather than from in-memory state, because the tab
    // that overran the budget is rarely the tab whose session is at risk.
    const candidates = [
      candidate(0, { heartbeatAt: NOW - HEARTBEAT_STALE_MS + 1_000 }),
      candidate(1),
      candidate(2),
      candidate(3),
      candidate(4),
    ]

    const plan = planPrune(candidates, totalOf(candidates), unprotected())

    expect(plan.evict).not.toContain('session-0')
  })

  it('treats a heartbeat exactly at the staleness bound as gone', () => {
    const candidates = [
      candidate(0, { heartbeatAt: NOW - HEARTBEAT_STALE_MS }),
      candidate(1),
      candidate(2),
      candidate(3),
      candidate(4),
    ]

    expect(planPrune(candidates, totalOf(candidates), unprotected()).evict).toContain('session-0')
  })

  it('skips the session on screen', () => {
    const candidates = [candidate(0), candidate(1), candidate(2), candidate(3), candidate(4)]

    const plan = planPrune(
      candidates,
      totalOf(candidates),
      unprotected({ viewedSessionId: 'session-0' }),
    )

    expect(plan.evict).toEqual(['session-1', 'session-2'])
  })
})

describe('too many session rows', () => {
  it('evicts down to the row cap even when the sample budget is nowhere near', () => {
    // Session rows are bounded independently of samples: a browser full of two-minute watches
    // holds no data worth mentioning and a list nobody can read.
    const many = Array.from({ length: MAX_SESSIONS + 3 }, (_unused, index) =>
      candidate(index, { sealedSamples: 20 }),
    )

    const plan = planPrune(many, totalOf(many), unprotected())

    expect(plan.evict).toEqual(['session-0', 'session-1', 'session-2'])
    expect(plan.truncate).toBeNull()
  })
})

describe('one session larger than the whole archive', () => {
  /** Live in this tab, so nothing may be evicted and the only room left is inside it. */
  function fat(overrides: Partial<PruneCandidate> = {}): PruneCandidate {
    return candidate(0, {
      state: 'open',
      heartbeatAt: NOW,
      sealedSamples: 2_500_000,
      chunks: chunks(10, 250_000),
      ...overrides,
    })
  }

  it('cuts its head off rather than giving up and overrunning the budget', () => {
    const plan = planPrune([fat()], 2_500_000, unprotected())

    expect(plan.evict).toEqual([])
    expect(plan.truncate?.sessionId).toBe('session-0')
    expect(plan.projectedTotal).toBeLessThanOrEqual(TARGET)
  })

  it('drops the oldest chunks and frees exactly what it says it freed', () => {
    const plan = planPrune([fat()], 2_500_000, unprotected())
    const truncation = plan.truncate!

    expect(truncation.dropChunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2])
    expect(truncation.freedSamples).toBe(3 * 250_000)
    expect(plan.projectedTotal).toBe(2_500_000 - truncation.freedSamples)
  })

  it('says where the retained data really starts, so no view implies the session began there', () => {
    const plan = planPrune([fat()], 2_500_000, unprotected())

    expect(plan.truncate?.retainedFrom).toBe(SAMPLE_EPOCH + 3 * HOUR_MS)
  })

  it('never offers the tail, which is the only copy of the newest rows', () => {
    const plan = planPrune(
      [fat({ sealedSamples: 4_000_000, chunks: chunks(2, 2_000_000) })],
      4_000_000,
      unprotected(),
    )

    // Two chunks and one of them is the tail, so only the head may go — even though cutting it
    // still leaves the archive over budget. Over budget beats losing the live tail.
    expect(plan.truncate?.dropChunks).toEqual([{ stream: PACK_STREAM, seq: 0 }])
    expect(plan.projectedTotal).toBeGreaterThan(TARGET)
  })

  it('keeps one tail per stream', () => {
    const plan = planPrune(
      [
        fat({
          sealedSamples: 2_500_000,
          chunks: [...chunks(3, 400_000, PACK_STREAM), ...chunks(3, 400_000, SOLAR_STREAM)],
        }),
      ],
      2_500_000,
      unprotected(),
    )

    const dropped = plan.truncate?.dropChunks ?? []
    expect(dropped).not.toContainEqual({ stream: PACK_STREAM, seq: 2 })
    expect(dropped).not.toContainEqual({ stream: SOLAR_STREAM, seq: 2 })
  })

  it('plans no truncation at all when the session is one chunk', () => {
    const plan = planPrune([fat({ chunks: chunks(1, 2_500_000) })], 2_500_000, unprotected())

    expect(plan.truncate).toBeNull()
    expect(plan.projectedTotal).toBe(2_500_000)
  })
})
