/**
 * The two captured stored-log reads, as the fold takes them.
 *
 * `ringMerge.json` holds whole 0x06 frames exactly as the pack sent them, so everything a spec
 * asserts is derived here rather than transcribed: the frames are split into records by the same
 * paging fields the decoder reads, and into runs by contiguity of ring index.
 */

import type { RingRun } from '../../src/domain/history/RingRun'
import type { RingSnapshot } from '../../src/domain/history/RingSnapshot'
import fixture from '../fixtures/ringMerge.json'

const FIRST_RECORD_INDEX = 6
const RECORD_COUNT = 8
const RECORD_BASE = 9
const RECORD_STRIDE = 24

export const ringMerge = fixture

export type CapturedRead = 'earlier' | 'later'

export function bytesOf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let at = 0; at < bytes.length; at += 1) {
    bytes[at] = Number.parseInt(hex.slice(at * 2, at * 2 + 2), 16)
  }
  return bytes
}

/** Every record one read carried, keyed by the ring index the frame gave it. */
export function recordsOf(read: CapturedRead): Map<number, Uint8Array> {
  const records = new Map<number, Uint8Array>()
  for (const hex of ringMerge[read].frames) {
    const frame = bytesOf(hex)
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const firstIndex = view.getUint16(FIRST_RECORD_INDEX, true)
    const declared = view.getUint8(RECORD_COUNT)
    for (let position = 0; position < declared; position += 1) {
      const base = RECORD_BASE + position * RECORD_STRIDE
      if (base + RECORD_STRIDE > frame.length - 1) break
      records.set(firstIndex + position, frame.subarray(base, base + RECORD_STRIDE))
    }
  }
  return records
}

/** Maximal contiguous stretches of ring index, ascending. */
export function runsIn(records: ReadonlyMap<number, Uint8Array>): readonly RingRun[] {
  const indexes = [...records.keys()].sort((left, right) => left - right)
  const runs: RingRun[] = []
  let firstIndex = -1
  let carried: Uint8Array[] = []

  for (const index of indexes) {
    if (carried.length > 0 && index === firstIndex + carried.length) {
      carried.push(records.get(index) as Uint8Array)
      continue
    }
    if (carried.length > 0) runs.push({ firstIndex, records: carried })
    firstIndex = index
    carried = [records.get(index) as Uint8Array]
  }
  if (carried.length > 0) runs.push({ firstIndex, records: carried })

  return runs
}

/** One captured read, optionally cut down to a window of ring indexes. */
export function capturedSnapshot(
  read: CapturedRead,
  overrides: {
    readonly deviceKey?: string
    readonly observedAt?: number
    readonly from?: number
    readonly to?: number
  } = {},
): RingSnapshot {
  const all = recordsOf(read)
  const from = overrides.from ?? Number.NEGATIVE_INFINITY
  const to = overrides.to ?? Number.POSITIVE_INFINITY
  const windowed = new Map(
    [...all.entries()].filter(([index]) => index >= from && index <= to),
  )

  return {
    deviceKey: overrides.deviceKey ?? ringMerge.deviceKey,
    observedAt: overrides.observedAt ?? ringMerge[read].observedAt,
    outcome: 'records-read',
    runs: runsIn(windowed),
    transport: {
      notificationBytes: 0,
      notificationCount: 0,
      assembledFrameCount: ringMerge[read].frames.length,
      logFrameCount: ringMerge[read].frames.length,
      elapsedMs: 0,
    },
  }
}
