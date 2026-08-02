/**
 * What these tests establish.
 *
 * Ring pruning decides and never acts, so every case here is about the shape of a plan. The one
 * property worth more than the arithmetic is the last block: the ring budget and the Log's sample
 * budget count different things and cannot reach each other, which is what stops a long recording
 * from deleting the device history Stats is scoped to — or a ring merge from having anything to say
 * about a session.
 */

import { describe, expect, it } from 'vitest'

import { MAX_TOTAL_SAMPLES, planPrune } from '../src/domain/history/budget'
import type { PruneCandidate } from '../src/domain/history/budget'
import {
  MAX_RING_DEVICES,
  MAX_RING_RECORDS_PER_DEVICE,
  RING_PRUNE_TARGET_RATIO,
  planRingPrune,
} from '../src/domain/history/ringBudget'
import type { RingDeviceExtent } from '../src/domain/history/ringBudget'
import { HEARTBEAT_STALE_MS } from '../src/domain/history/types'
import { SAMPLE_EPOCH } from './support/samples'

const TARGET = Math.floor(MAX_RING_RECORDS_PER_DEVICE * RING_PRUNE_TARGET_RATIO)
const DAY_MS = 86_400_000

function extent(index: number, overrides: Partial<RingDeviceExtent> = {}): RingDeviceExtent {
  return {
    deviceKey: `jk:PACK${index}`,
    records: 4_000,
    oldestSeq: 0,
    lastReadAt: SAMPLE_EPOCH + index * DAY_MS,
    ...overrides,
  }
}

describe('a ledger inside its budget', () => {
  it('plans nothing, so the ordinary merge does no extra work at all', () => {
    const plan = planRingPrune([extent(0), extent(1, { records: MAX_RING_RECORDS_PER_DEVICE })])

    expect(plan).toEqual({ trim: [], dropWhole: [] })
  })
})

describe('a ledger over its budget', () => {
  it('gives up its oldest records, and names the seq the survivor starts at', () => {
    const plan = planRingPrune([extent(0, { records: MAX_RING_RECORDS_PER_DEVICE + 500 })])

    expect(plan.trim).toEqual([
      {
        deviceKey: 'jk:PACK0',
        fromSeq: MAX_RING_RECORDS_PER_DEVICE + 500 - TARGET,
        freedRecords: MAX_RING_RECORDS_PER_DEVICE + 500 - TARGET,
      },
    ])
  })

  it("counts the cut from the ledger's own oldest row, not from zero", () => {
    const plan = planRingPrune([
      extent(0, { records: MAX_RING_RECORDS_PER_DEVICE + 500, oldestSeq: 30_000 }),
    ])

    expect(plan.trim[0].fromSeq).toBe(30_000 + MAX_RING_RECORDS_PER_DEVICE + 500 - TARGET)
  })

  it('prunes to the target rather than to the cap, so the next merge fires nothing', () => {
    const overrun = MAX_RING_RECORDS_PER_DEVICE + 1

    const plan = planRingPrune([extent(0, { records: overrun })])

    expect(overrun - plan.trim[0].freedRecords).toBe(TARGET)
    expect(planRingPrune([extent(0, { records: TARGET })]).trim).toEqual([])
  })

  it('leaves every ledger that is inside the cap alone', () => {
    const plan = planRingPrune([
      extent(0, { records: MAX_RING_RECORDS_PER_DEVICE + 1 }),
      extent(1, { records: 12 }),
    ])

    expect(plan.trim.map((each) => each.deviceKey)).toEqual(['jk:PACK0'])
  })
})

describe('more packs than the archive keeps', () => {
  it('drops the least recently read ledgers whole', () => {
    const extents = Array.from({ length: MAX_RING_DEVICES + 2 }, (_unused, index) =>
      extent(index, { lastReadAt: SAMPLE_EPOCH + (MAX_RING_DEVICES + 2 - index) * DAY_MS }),
    )

    const plan = planRingPrune(extents)

    expect(plan.dropWhole).toEqual([
      `jk:PACK${MAX_RING_DEVICES + 1}`,
      `jk:PACK${MAX_RING_DEVICES}`,
    ])
  })

  it('never trims a ledger it is dropping whole, so the figures cannot double count', () => {
    const extents = Array.from({ length: MAX_RING_DEVICES + 1 }, (_unused, index) =>
      extent(index, {
        records: MAX_RING_RECORDS_PER_DEVICE + 1_000,
        lastReadAt: SAMPLE_EPOCH + index * DAY_MS,
      }),
    )

    const plan = planRingPrune(extents)

    expect(plan.dropWhole).toEqual(['jk:PACK0'])
    expect(plan.trim.map((each) => each.deviceKey)).not.toContain('jk:PACK0')
    expect(plan.trim).toHaveLength(MAX_RING_DEVICES)
  })
})

describe('the two budgets', () => {
  it('never counts a ring record toward the sample budget', () => {
    const ringRecords = MAX_RING_RECORDS_PER_DEVICE + 5_000

    const ring = planRingPrune([extent(0, { records: ringRecords })])
    const sessions = planPrune([], ringRecords, {
      now: SAMPLE_EPOCH,
      heartbeatStaleMs: HEARTBEAT_STALE_MS,
      viewedSessionId: null,
    })

    expect(ring.trim).toHaveLength(1)
    expect(sessions).toEqual({ evict: [], truncate: null, projectedTotal: ringRecords })
  })

  it('leaves the ring alone when the Log is the thing that overran', () => {
    const fat: PruneCandidate = {
      id: 'session-0',
      startedAt: SAMPLE_EPOCH,
      sealedSamples: MAX_TOTAL_SAMPLES * 2,
      state: 'closed',
      heartbeatAt: SAMPLE_EPOCH,
      chunks: [],
    }

    const sessions = planPrune([fat], MAX_TOTAL_SAMPLES * 2, {
      now: SAMPLE_EPOCH + HEARTBEAT_STALE_MS * 2,
      heartbeatStaleMs: HEARTBEAT_STALE_MS,
      viewedSessionId: null,
    })
    const ring = planRingPrune([extent(0, { records: 900 })])

    expect(sessions.evict).toEqual(['session-0'])
    expect(ring).toEqual({ trim: [], dropWhole: [] })
  })
})
