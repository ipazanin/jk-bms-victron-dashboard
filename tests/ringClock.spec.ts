/**
 * What these tests establish.
 *
 * The captured pair of reads is the only place in this project where the clock model can be checked
 * against a known answer, and it is checked here. The vendor app set this pack forward by
 * 7 h 01 m 08 s between the two reads and wrote the pair of records that says so, and the 09:49 read
 * bounds the face before that write while the 13:14 read bounds the face after it. Fold both onto
 * one face and the current error lands inside 35 minutes; propagate it back across the recorded step
 * and the pre-rewrite face lands on about zero, which is exactly right and is the acceptance test
 * this whole module exists to pass.
 *
 * The synthesised cases cover the rewrites the capture does not contain — a backward one above all,
 * which is what forces segments to be intervals of write order rather than of counter — and the
 * ledger nothing has ever anchored, which must refuse to date a record rather than guess a day.
 *
 * Nothing here reads the host clock or the host zone.
 */

import { describe, expect, it } from 'vitest'

import {
  PACK_SAMPLING_PERIOD_SECONDS,
  calibrationsIn,
  clockErrorOf,
  packFaceInstant,
  resolveRingInstant,
  ringClockContextOf,
  ringClockSegments,
  segmentAt,
} from '../src/domain/history/ringClock'
import { ALIGNMENT_TAIL_RECORDS, foldRingSnapshot } from '../src/domain/history/ringLedger'
import type { PackClockCalibration } from '../src/domain/history/PackClockCalibration'
import type { RingReadRow } from '../src/domain/history/RingReadRow'
import type { RingRecordRow } from '../src/domain/history/RingRecordRow'
import type { StoredRingLedger } from '../src/domain/history/StoredRingLedger'
import type { DeviceRecord } from '../src/domain/history/types'
import { capturedSnapshot, ringMerge } from './support/ringFixture'

const PACK_ZONE_OFFSET_MINUTES = ringMerge.packUtcOffsetMinutes
const BROWSER_OFFSET_MINUTES = 120
const CLOCK_REWRITE_EVENT_CODE = 0x3b
const RECORD_STRIDE = 24
const SECOND = 1_000

/** The whole rewrite the vendor app made between the two captured reads. */
const CAPTURED_STEP_SECONDS = ringMerge.expected.calibration.stepSeconds

function ringRecord(
  seq: number,
  counterSeconds: number,
  eventCode: number = 0,
): RingRecordRow {
  const bytes = new Uint8Array(RECORD_STRIDE)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, counterSeconds, true)
  view.setUint8(4, eventCode)
  return {
    deviceKey: 'jk:SYNTHETIC',
    seq,
    packClockSeconds: counterSeconds,
    bytes,
    firstReadAt: 0,
    followsGap: seq === 0,
  }
}

function readRow(overrides: Partial<RingReadRow> = {}): RingReadRow {
  return {
    deviceKey: 'jk:SYNTHETIC',
    observedAt: 0,
    outcome: 'records-read',
    notificationBytes: 1,
    notificationCount: 1,
    assembledFrameCount: 1,
    logFrameCount: 1,
    indexSpan: null,
    recordsReceived: 0,
    recordsAppended: 0,
    overlap: 0,
    ringShift: null,
    gapDeclared: false,
    runsDiscarded: 0,
    newestSampleCounter: null,
    newestSampleSeq: null,
    elapsedMs: 1,
    ...overrides,
  }
}

function deviceRow(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    key: 'jk:SYNTHETIC',
    kind: 'pack',
    defaultLabel: 'JK_B2A8S20P',
    userLabel: null,
    model: null,
    serialNumber: null,
    hardwareVersion: null,
    softwareVersion: null,
    firstSeenAt: 0,
    lastSeenAt: 0,
    sessionCount: 0,
    packUtcOffsetMinutes: PACK_ZONE_OFFSET_MINUTES,
    packClockAheadSeconds: null,
    ...overrides,
  }
}

function ledgerOf(
  records: readonly RingRecordRow[],
  reads: readonly RingReadRow[],
  device: DeviceRecord | null = deviceRow(),
): StoredRingLedger {
  return { deviceKey: 'jk:SYNTHETIC', records, reads, device, retainedFromSeq: null }
}

/** The two captured reads merged into one ledger, exactly as the fold would leave it. */
function capturedLedger(reads: readonly RingReadRow[]): StoredRingLedger {
  const first = foldRingSnapshot({ nextSeq: 0, rows: [] }, capturedSnapshot('earlier'), 0).rows
  const second = foldRingSnapshot(
    { nextSeq: first.length, rows: first.slice(-ALIGNMENT_TAIL_RECORDS) },
    capturedSnapshot('later'),
    0,
  ).rows
  return {
    deviceKey: ringMerge.deviceKey,
    records: [...first, ...second],
    reads,
    device: deviceRow({ key: ringMerge.deviceKey }),
    retainedFromSeq: null,
  }
}

const EARLIER_NEWEST_SEQ = ringMerge.expected.earlierNewestScheduled.index
const LATER_NEWEST_SEQ =
  ringMerge.expected.earlierRecords +
  (ringMerge.expected.newestScheduled.index - ringMerge.expected.firstAppendedLaterIndex)

const EARLIER_READ = readRow({
  deviceKey: ringMerge.deviceKey,
  observedAt: ringMerge.earlier.observedAt,
  newestSampleCounter: ringMerge.expected.earlierNewestScheduled.counterSeconds,
  newestSampleSeq: EARLIER_NEWEST_SEQ,
})
const LATER_READ = readRow({
  deviceKey: ringMerge.deviceKey,
  observedAt: ringMerge.later.observedAt,
  newestSampleCounter: ringMerge.expected.newestScheduled.counterSeconds,
  newestSampleSeq: LATER_NEWEST_SEQ,
})

/**
 * The one rewrite in the captured ledger that moved the clock rather than nudging it. Nineteen
 * pairs are on record and most step by seconds — the vendor app syncing against a phone — so the
 * write worth naming is the largest, not the first that is non-zero.
 */
function widestRewriteIn(calibrations: readonly PackClockCalibration[]): PackClockCalibration {
  return calibrations.reduce((widest, each) =>
    Math.abs(each.stepSeconds) > Math.abs(widest.stepSeconds) ? each : widest,
  )
}

function calibration(atSeq: number, stepSeconds: number): PackClockCalibration {
  return {
    atSeq,
    beforeCounterSeconds: 1_000,
    afterCounterSeconds: 1_000 + stepSeconds,
    stepSeconds,
  }
}

describe('reading the rewrites out of the ring', () => {
  it('pairs a run from its start, where pairing from its middle would invent a step', () => {
    const { paired } = calibrationsIn(capturedLedger([]).records)

    expect(widestRewriteIn(paired).stepSeconds).toBe(CAPTURED_STEP_SECONDS)
    expect(paired.map((each) => each.stepSeconds)).not.toContain(
      ringMerge.expected.calibration.misPairedStepSeconds,
    )
  })

  it('reads the captured rewrite as exactly seven hours, one minute and eight seconds', () => {
    const { paired } = calibrationsIn(capturedLedger([]).records)

    const rewrite = widestRewriteIn(paired)
    expect(rewrite.stepSeconds).toBe(7 * 3600 + 60 + 8)
    expect(rewrite.afterCounterSeconds - rewrite.beforeCounterSeconds).toBe(CAPTURED_STEP_SECONDS)
  })

  it('reports a sync that changed nothing as a zero step', () => {
    const { paired } = calibrationsIn(capturedLedger([]).records)

    const afterTheRewrite = paired.filter(
      (each) => each.atSeq > widestRewriteIn(paired).atSeq,
    )
    expect(afterTheRewrite).not.toEqual([])
    expect(afterTheRewrite.every((each) => each.stepSeconds === 0)).toBe(true)
    expect(afterTheRewrite.every((each) => each.afterCounterSeconds === each.beforeCounterSeconds)).toBe(
      true,
    )
  })

  it('reports an odd run as its whole pairs plus one unpaired rewrite', () => {
    const records = [
      ringRecord(0, 1_000),
      ringRecord(1, 4_601, CLOCK_REWRITE_EVENT_CODE),
      ringRecord(2, 8_000, CLOCK_REWRITE_EVENT_CODE),
      ringRecord(3, 8_010, CLOCK_REWRITE_EVENT_CODE),
      ringRecord(4, 11_611),
    ]

    const { paired, unpaired } = calibrationsIn(records)

    expect(paired).toEqual([
      { atSeq: 2, beforeCounterSeconds: 4_601, afterCounterSeconds: 8_000, stepSeconds: 3_399 },
    ])
    expect(unpaired).toBe(1)
  })

  it('finds no rewrite at all in a ledger that holds none', () => {
    const records = [ringRecord(0, 1_000), ringRecord(1, 4_601)]

    expect(calibrationsIn(records)).toEqual({ paired: [], unpaired: 0 })
  })
})

describe('segments', () => {
  it('opens a segment on the record carrying the new face', () => {
    const segments = ringClockSegments([calibration(10, 60), calibration(20, -30)])

    expect(segments.map((each) => [each.fromSeq, each.toSeq])).toEqual([
      [0, 10],
      [10, 20],
      [20, Number.MAX_SAFE_INTEGER],
    ])
  })

  it('sums the steps after a segment, so any counter in it reads on the current face', () => {
    const segments = ringClockSegments([calibration(10, 60), calibration(20, -30)])

    expect(segments.map((each) => each.toCurrentFaceSeconds)).toEqual([30, -30, 0])
  })

  it('leaves one segment covering the whole ledger when the clock was never set', () => {
    expect(ringClockSegments([])).toEqual([
      { fromSeq: 0, toSeq: Number.MAX_SAFE_INTEGER, toCurrentFaceSeconds: 0 },
    ])
  })

  it('cuts the captured ledger at the rewrite the vendor app made', () => {
    const context = ringClockContextOf(capturedLedger([]), BROWSER_OFFSET_MINUTES)

    const rewrite = widestRewriteIn(context.calibrations)
    const before = segmentAt(context.segments, rewrite.atSeq - 1)
    const after = segmentAt(context.segments, rewrite.atSeq)

    expect(before.toCurrentFaceSeconds - after.toCurrentFaceSeconds).toBe(CAPTURED_STEP_SECONDS)
    expect(context.unpairedCalibrations).toBe(0)
  })
})

describe('a backward rewrite', () => {
  const records = [
    ringRecord(0, 800),
    ringRecord(1, 4_400),
    ringRecord(2, 8_000, CLOCK_REWRITE_EVENT_CODE),
    ringRecord(3, 4_400, CLOCK_REWRITE_EVENT_CODE),
    ringRecord(4, 8_001),
  ]
  const anchored = ledgerOf(
    records,
    [readRow({ observedAt: 0, newestSampleCounter: 8_001, newestSampleSeq: 4 })],
  )

  it('places two records that share a counter without calling either one ambiguous', () => {
    const context = ringClockContextOf(anchored, BROWSER_OFFSET_MINUTES)

    const older = resolveRingInstant(records[1], context)
    const newer = resolveRingInstant(records[3], context)

    expect(records[1].packClockSeconds).toBe(records[3].packClockSeconds)
    expect(older.basis).not.toBe('unresolved')
    expect(newer.basis).not.toBe('unresolved')
    expect(newer.at - older.at).toBe(3_600 * SECOND)
  })

  it('keeps the ledger in write order once every record is resolved', () => {
    const context = ringClockContextOf(anchored, BROWSER_OFFSET_MINUTES)

    const instants = records.map((record) => resolveRingInstant(record, context).at)

    expect([...instants].sort((left, right) => left - right)).toEqual(instants)
  })

  it('keeps the captured ledger in write order too, across every rewrite it holds', () => {
    const ledger = capturedLedger([EARLIER_READ, LATER_READ])
    const context = ringClockContextOf(ledger, BROWSER_OFFSET_MINUTES)

    const instants = ledger.records.map((record) => resolveRingInstant(record, context).at)

    expect(instants.every((at, index) => index === 0 || at >= instants[index - 1])).toBe(true)
  })
})

describe('the measured clock error', () => {
  it('bounds it to one sampling period from a single read', () => {
    const ledger = capturedLedger([LATER_READ])
    const context = ringClockContextOf(ledger, BROWSER_OFFSET_MINUTES)

    const error = clockErrorOf(context, context.segments[context.segments.length - 1])

    expect(error?.observations).toBe(1)
    expect((error?.highMs ?? 0) - (error?.lowMs ?? 0)).toBe(PACK_SAMPLING_PERIOD_SECONDS * SECOND)
    expect(error?.lowMs).toBeLessThanOrEqual(CAPTURED_STEP_SECONDS * SECOND)
    expect(error?.highMs).toBeGreaterThan(CAPTURED_STEP_SECONDS * SECOND)
  })

  it('narrows the bound when a second read lands at another phase of the cycle', () => {
    const context = ringClockContextOf(capturedLedger([EARLIER_READ, LATER_READ]), BROWSER_OFFSET_MINUTES)
    const current = context.segments[context.segments.length - 1]

    const error = clockErrorOf(context, current)

    expect(error?.observations).toBe(2)
    expect((error?.highMs ?? 0) - (error?.lowMs ?? 0)).toBeLessThan(
      PACK_SAMPLING_PERIOD_SECONDS * SECOND,
    )
    expect(error?.lowMs).toBeLessThanOrEqual(CAPTURED_STEP_SECONDS * SECOND)
    expect(error?.highMs).toBeGreaterThan(CAPTURED_STEP_SECONDS * SECOND)
  })

  it('propagates back through the step and lands on about zero before the rewrite', () => {
    const context = ringClockContextOf(capturedLedger([EARLIER_READ, LATER_READ]), BROWSER_OFFSET_MINUTES)
    const beforeRewrite = segmentAt(context.segments, widestRewriteIn(context.calibrations).atSeq - 1)

    const error = clockErrorOf(context, beforeRewrite)
    const midpointSeconds = ((error?.lowMs ?? 0) + (error?.highMs ?? 0)) / 2 / SECOND

    expect(Math.abs(midpointSeconds)).toBeLessThan(20 * 60)
    expect(error?.lowMs).toBeLessThanOrEqual(0)
    expect(error?.highMs).toBeGreaterThan(0)
  })

  it('leaves the ledger unresolved when no read ever anchored it', () => {
    const context = ringClockContextOf(capturedLedger([readRow()]), BROWSER_OFFSET_MINUTES)

    expect(clockErrorOf(context, context.segments[0])).toBeNull()
    expect(resolveRingInstant(capturedLedger([]).records[0], context)).toEqual({
      at: packFaceInstant(capturedLedger([]).records[0].packClockSeconds, PACK_ZONE_OFFSET_MINUTES),
      uncertaintyMs: Number.POSITIVE_INFINITY,
      basis: 'unresolved',
    })
  })

  it("takes the owner's pin as exact and stops measuring against it", () => {
    const ledger = capturedLedger([EARLIER_READ, LATER_READ])
    const pinned: StoredRingLedger = {
      ...ledger,
      device: deviceRow({ key: ringMerge.deviceKey, packClockAheadSeconds: CAPTURED_STEP_SECONDS }),
    }
    const context = ringClockContextOf(pinned, BROWSER_OFFSET_MINUTES)

    const error = clockErrorOf(context, context.segments[context.segments.length - 1])

    expect(error).toEqual({
      lowMs: CAPTURED_STEP_SECONDS * SECOND,
      highMs: CAPTURED_STEP_SECONDS * SECOND,
      observations: 0,
    })
  })
})

describe('resolving a record', () => {
  it('never hands back a wall time without the uncertainty that produced it', () => {
    const measured = ringClockContextOf(capturedLedger([LATER_READ]), BROWSER_OFFSET_MINUTES)
    const pinned = ringClockContextOf(
      {
        ...capturedLedger([LATER_READ]),
        device: deviceRow({ key: ringMerge.deviceKey, packClockAheadSeconds: 0 }),
      },
      BROWSER_OFFSET_MINUTES,
    )
    const newest = capturedLedger([]).records.slice(-1)[0]
    const oldest = capturedLedger([]).records[0]

    expect(resolveRingInstant(newest, measured).uncertaintyMs).toBe(
      (PACK_SAMPLING_PERIOD_SECONDS * SECOND) / 2,
    )
    expect(resolveRingInstant(newest, measured).basis).toBe('measured')
    expect(resolveRingInstant(oldest, measured).basis).toBe('propagated')
    expect(resolveRingInstant(newest, pinned)).toEqual({
      at: packFaceInstant(newest.packClockSeconds, PACK_ZONE_OFFSET_MINUTES),
      uncertaintyMs: 0,
      basis: 'owner-pinned',
    })
  })

  it('brings a pre-rewrite record onto the current face, so the pair lands on one instant', () => {
    const ledger = capturedLedger([EARLIER_READ, LATER_READ])
    const context = ringClockContextOf(ledger, BROWSER_OFFSET_MINUTES)
    const rewrite = widestRewriteIn(context.calibrations)
    const before = ledger.records[rewrite.atSeq - 1]
    const after = ledger.records[rewrite.atSeq]

    expect(after.packClockSeconds - before.packClockSeconds).toBe(CAPTURED_STEP_SECONDS)
    expect(resolveRingInstant(after, context).at).toBe(resolveRingInstant(before, context).at)
  })

  it('leaves the stored counter and bytes untouched whatever the correction says', () => {
    const ledger = capturedLedger([EARLIER_READ, LATER_READ])
    const context = ringClockContextOf(ledger, BROWSER_OFFSET_MINUTES)
    const record = ledger.records[400]
    const before = { counter: record.packClockSeconds, bytes: [...record.bytes] }

    resolveRingInstant(record, context)

    expect(record.packClockSeconds).toBe(before.counter)
    expect([...record.bytes]).toEqual(before.bytes)
  })

  it("prefers the owner's zone over the browser's, and says which one it used", () => {
    const guessed = ringClockContextOf(
      ledgerOf([], [], deviceRow({ packUtcOffsetMinutes: null })),
      BROWSER_OFFSET_MINUTES,
    )
    const confirmed = ringClockContextOf(ledgerOf([], []), BROWSER_OFFSET_MINUTES)

    expect(guessed.packUtcOffsetMinutes).toBe(BROWSER_OFFSET_MINUTES)
    expect(guessed.offsetIsGuessed).toBe(true)
    expect(confirmed.packUtcOffsetMinutes).toBe(PACK_ZONE_OFFSET_MINUTES)
    expect(confirmed.offsetIsGuessed).toBe(false)
  })
})
