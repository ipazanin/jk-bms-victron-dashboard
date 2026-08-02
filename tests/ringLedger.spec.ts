/**
 * What these tests establish.
 *
 * Almost every case here is driven by two whole stored-log reads taken off a real pack three and a
 * half hours apart, committed verbatim in `ringMerge.json`. That pair is the only evidence there is
 * about how the ring behaves under a merge, and it is uncomfortable evidence: the ring dropped 42
 * records while adding 15, so it is not a fixed-length FIFO; ten counters repeat inside one read;
 * nine adjacent pairs are byte-identical. Every one of those facts breaks an identity rule that
 * would otherwise look obvious, which is why the assertions below are derived from the frames
 * rather than transcribed from a table.
 *
 * The synthesised cases cover what one capture cannot contain: a torn reply, two reads a month
 * apart with nothing in common, and a run too short to identify itself.
 */

import { describe, expect, it } from 'vitest'

import { ALIGNMENT_TAIL_RECORDS, alignRun, foldRingSnapshot } from '../src/domain/history/ringLedger'
import type { RingLedgerTail } from '../src/domain/history/RingLedgerTail'
import type { RingRecordRow } from '../src/domain/history/RingRecordRow'
import type { RingSnapshot } from '../src/domain/history/RingSnapshot'
import { capturedSnapshot, recordsOf, ringMerge } from './support/ringFixture'

const READ_AT = Date.UTC(2026, 7, 1, 11, 14, 0)
const RECORD_STRIDE = 24

const EMPTY_TAIL: RingLedgerTail = { nextSeq: 0, rows: [] }

function tailOf(rows: readonly RingRecordRow[]): RingLedgerTail {
  return {
    nextSeq: rows.length === 0 ? 0 : rows[rows.length - 1].seq + 1,
    rows: rows.slice(-ALIGNMENT_TAIL_RECORDS),
  }
}

function ledgerFrom(snapshot: RingSnapshot, now: number = READ_AT): readonly RingRecordRow[] {
  return foldRingSnapshot(EMPTY_TAIL, snapshot, now).rows
}

function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function counterIn(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
}

/** A record whose only meaningful field is its counter, for the cases the capture cannot supply. */
function syntheticRecord(counterSeconds: number): Uint8Array {
  const bytes = new Uint8Array(RECORD_STRIDE)
  new DataView(bytes.buffer).setUint32(0, counterSeconds, true)
  return bytes
}

function syntheticSnapshot(runs: readonly { from: number; count: number }[]): RingSnapshot {
  return {
    deviceKey: 'jk:SYNTHETIC',
    observedAt: READ_AT,
    outcome: 'records-read',
    runs: runs.map((run) => ({
      firstIndex: run.from,
      records: Array.from({ length: run.count }, (_unused, at) =>
        syntheticRecord(100_000 + run.from + at),
      ),
    })),
    transport: {
      notificationBytes: 1,
      notificationCount: 1,
      assembledFrameCount: 1,
      logFrameCount: 1,
      elapsedMs: 1,
    },
  }
}

describe('a ledger opened by its first read', () => {
  it('numbers the whole ring from zero, in the order the pack wrote it', () => {
    const captured = recordsOf('earlier')

    const { rows, merge } = foldRingSnapshot(EMPTY_TAIL, capturedSnapshot('earlier'), READ_AT)

    expect(rows).toHaveLength(ringMerge.expected.earlierRecords)
    expect(rows.map((row) => row.seq)).toEqual(rows.map((_unused, at) => at))
    expect(rows.map((row) => hexOf(row.bytes))).toEqual(
      rows.map((_unused, index) => hexOf(captured.get(index) as Uint8Array)),
    )
    expect(merge).toEqual({
      appended: ringMerge.expected.earlierRecords,
      overlap: 0,
      ringShift: null,
      gapDeclared: false,
      runsDiscarded: 0,
    })
  })

  it("denormalises each row's counter off the bytes it stored, and stores nothing else derived", () => {
    const rows = ledgerFrom(capturedSnapshot('later'))

    for (const row of rows) {
      expect(row.packClockSeconds).toBe(counterIn(row.bytes))
      expect(row.bytes).toHaveLength(RECORD_STRIDE)
      expect(row.firstReadAt).toBe(READ_AT)
    }
    expect(Object.keys(rows[0]).sort()).toEqual([
      'bytes',
      'deviceKey',
      'firstReadAt',
      'followsGap',
      'packClockSeconds',
      'seq',
    ])
  })

  it('declares the break at its oldest row, because the ring had already dropped what came before', () => {
    const rows = ledgerFrom(capturedSnapshot('earlier'))

    expect(rows.filter((row) => row.followsGap).map((row) => row.seq)).toEqual([0])
  })
})

describe('a second read of the same ring', () => {
  it('appends only what is new, and reports the ring having moved 42 records under it', () => {
    const stored = ledgerFrom(capturedSnapshot('earlier'))

    const { rows, merge } = foldRingSnapshot(tailOf(stored), capturedSnapshot('later'), READ_AT)

    expect(merge.overlap).toBe(ringMerge.expected.overlap)
    expect(merge.appended).toBe(ringMerge.expected.appended)
    expect(merge.ringShift).toBe(ringMerge.expected.ringShift)
    expect(merge.gapDeclared).toBe(false)
    expect(rows.map((row) => row.seq)).toEqual(
      Array.from({ length: ringMerge.expected.appended }, (_unused, at) => stored.length + at),
    )
  })

  it('leaves every stored row exactly as it was, seq and bytes alike', () => {
    const stored = ledgerFrom(capturedSnapshot('earlier'))
    const before = stored.map((row) => `${row.seq}:${hexOf(row.bytes)}:${row.followsGap}`)

    foldRingSnapshot(tailOf(stored), capturedSnapshot('later'), READ_AT + 1)

    expect(stored.map((row) => `${row.seq}:${hexOf(row.bytes)}:${row.followsGap}`)).toEqual(before)
  })

  it('carries the newest records across as the pack wrote them', () => {
    const stored = ledgerFrom(capturedSnapshot('earlier'))
    const captured = recordsOf('later')

    const { rows } = foldRingSnapshot(tailOf(stored), capturedSnapshot('later'), READ_AT)

    const appendedFrom = ringMerge.expected.firstAppendedLaterIndex
    expect(rows.map((row) => hexOf(row.bytes))).toEqual(
      rows.map((_unused, at) => hexOf(captured.get(appendedFrom + at) as Uint8Array)),
    )
    expect(rows.every((row) => !row.followsGap)).toBe(true)
  })

  it('appends nothing at all when it is folded a second time', () => {
    const stored = ledgerFrom(capturedSnapshot('later'))

    const { rows, merge } = foldRingSnapshot(tailOf(stored), capturedSnapshot('later'), READ_AT + 1)

    expect(rows).toEqual([])
    expect(merge.appended).toBe(0)
    expect(merge.overlap).toBe(ringMerge.expected.laterRecords)
    expect(merge.gapDeclared).toBe(false)
  })
})

describe('a read the link cut short', () => {
  it('appends nothing when its window lies wholly inside the ledger', () => {
    const stored = ledgerFrom(capturedSnapshot('later'))

    const truncated = capturedSnapshot('later', { to: 299 })
    const { rows, merge } = foldRingSnapshot(tailOf(stored), truncated, READ_AT)

    expect(rows).toEqual([])
    expect(merge.overlap).toBe(300)
    expect(merge.gapDeclared).toBe(false)
  })

  it('reaches the same ledger as the whole read that follows it', () => {
    const cutShort = ledgerFrom(capturedSnapshot('later', { to: 299 }))
    const { rows: completed } = foldRingSnapshot(
      tailOf(cutShort),
      capturedSnapshot('later'),
      READ_AT,
    )
    const inOneRead = ledgerFrom(capturedSnapshot('later'))

    const bothReads = [...cutShort, ...completed]
    expect(bothReads.map((row) => `${row.seq}:${hexOf(row.bytes)}:${row.followsGap}`)).toEqual(
      inOneRead.map((row) => `${row.seq}:${hexOf(row.bytes)}:${row.followsGap}`),
    )
  })

  it('files only the unbroken stretches of a torn reply and counts what it gave up', () => {
    const torn = syntheticSnapshot([
      { from: 0, count: 100 },
      { from: 200, count: 100 },
      { from: 500, count: 2 },
    ])

    const { rows, merge } = foldRingSnapshot(EMPTY_TAIL, torn, READ_AT)

    expect(merge.appended).toBe(200)
    expect(merge.runsDiscarded).toBe(1)
    expect(merge.gapDeclared).toBe(true)
    expect(rows.filter((row) => row.followsGap).map((row) => row.seq)).toEqual([0, 100])
  })
})

describe('two reads with nothing in common', () => {
  it('declares the gap rather than joining them end to end', () => {
    const stored = ledgerFrom(capturedSnapshot('earlier', { to: 99 }))

    const later = capturedSnapshot('later', { from: 709 })
    const { rows, merge } = foldRingSnapshot(tailOf(stored), later, READ_AT)

    expect(merge.gapDeclared).toBe(true)
    expect(merge.overlap).toBe(0)
    expect(merge.ringShift).toBeNull()
    expect(rows[0].followsGap).toBe(true)
    expect([...stored, ...rows].filter((row) => row.followsGap).map((row) => row.seq)).toEqual([
      0,
      stored.length,
    ])
  })
})

describe('alignment', () => {
  it('refuses a run too short to identify itself rather than guessing a shift', () => {
    const stored = ledgerFrom(capturedSnapshot('later'))
    const captured = recordsOf('later')
    const threeRecords: RingSnapshot = {
      ...capturedSnapshot('later'),
      runs: [{ firstIndex: 400, records: [400, 401, 402].map((at) => captured.get(at) as Uint8Array) }],
    }

    expect(alignRun(tailOf(stored), threeRecords.runs[0])).toBeNull()

    const { rows, merge } = foldRingSnapshot(tailOf(stored), threeRecords, READ_AT)
    expect(rows).toEqual([])
    expect(merge.runsDiscarded).toBe(1)
  })

  it('refuses to choose when two shifts both agree', () => {
    const repeated = syntheticRecord(1)
    const rows: RingRecordRow[] = Array.from({ length: 8 }, (_unused, seq) => ({
      deviceKey: 'jk:SYNTHETIC',
      seq,
      packClockSeconds: 1,
      bytes: repeated,
      firstReadAt: READ_AT,
      followsGap: seq === 0,
    }))

    const shift = alignRun({ nextSeq: 8, rows }, { firstIndex: 0, records: [repeated, repeated, repeated, repeated] })

    expect(shift).toBeNull()
  })

  it('finds the one shift the captured pair agrees at', () => {
    const stored = ledgerFrom(capturedSnapshot('earlier'))

    const shift = alignRun(tailOf(stored), capturedSnapshot('later').runs[0])

    expect(shift).toBe(ringMerge.expected.ringShift)
  })
})

describe('records the pack wrote twice over', () => {
  it('keeps two byte-identical adjacent records as two rows', () => {
    const rows = ledgerFrom(capturedSnapshot('later'))

    expect(rows).toHaveLength(ringMerge.expected.laterRecords)
    for (const [before, after] of ringMerge.expected.identicalAdjacentLaterIndexes) {
      expect(hexOf(rows[after].bytes)).toBe(hexOf(rows[before].bytes))
      expect(rows[after].seq).toBe(rows[before].seq + 1)
    }
  })
})

describe('two packs', () => {
  it('files each read under its own device key, and one ledger owes the other nothing', () => {
    const ours = ledgerFrom(capturedSnapshot('later', { deviceKey: 'jk:OURS' }))
    const theirs = ledgerFrom(capturedSnapshot('later', { deviceKey: 'jk:THEIRS' }))

    expect(ours.every((row) => row.deviceKey === 'jk:OURS')).toBe(true)
    expect(theirs.every((row) => row.deviceKey === 'jk:THEIRS')).toBe(true)
    expect(theirs.map((row) => row.seq)).toEqual(ours.map((row) => row.seq))
  })
})
