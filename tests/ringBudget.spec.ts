import { describe, expect, it } from 'vitest'

import { planRawPrune } from '../src/domain/history/budget'
import {
  MAX_RING_DEVICES,
  MAX_RING_RECORDS_PER_DEVICE,
  RING_PRUNE_TARGET_RATIO,
  planRingPrune,
} from '../src/domain/history/ringBudget'
import type { RingDeviceExtent } from '../src/domain/history/ringBudget'
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
  it('keeps device history independent of raw recording capacity', () => {
    const ring = planRingPrune([extent(0, { records: 900 })])
    const chunk = { sessionId: 'session', stream: 'pack' as const, seq: 0, length: 300, baseAt: SAMPLE_EPOCH, sealed: true }
    expect(planRawPrune([chunk], 8_400, 100)).toEqual([chunk])
    expect(ring).toEqual({ trim: [], dropWhole: [] })
  })
})
