import { describe, expect, it } from 'vitest'
import { planRawPrune } from '../src/domain/history/budget'
import type { RawChunkExtent } from '../src/domain/history/budget'

function chunk(seq: number, stream: 'pack' | 'solar' = 'pack', sealed = true): RawChunkExtent {
  return { sessionId: 'session', stream, seq, length: 10, baseAt: seq * 1_000, sealed }
}

describe('raw recording budget', () => {
  it('keeps all raw samples at the byte allowance', () => {
    expect(planRawPrune([chunk(0)], 280, 280)).toEqual([])
  })

  it('removes oldest sealed chunks across sessions until below the target', () => {
    const older = { ...chunk(0), sessionId: 'older' }
    expect(planRawPrune([chunk(2), older, chunk(1)], 840, 600)).toEqual([older, chunk(1)])
  })

  it('uses the different pack and solar column widths', () => {
    expect(planRawPrune([chunk(0, 'solar'), chunk(1)], 450, 400)).toEqual([chunk(0, 'solar')])
  })

  it('preserves unsealed tails even when they exceed the allowance', () => {
    expect(planRawPrune([chunk(0, 'pack', false), chunk(1)], 560, 100)).toEqual([chunk(1)])
  })
})
