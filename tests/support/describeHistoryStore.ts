/**
 * One contract, two implementations.
 *
 * The Map-backed fake and the IndexedDB adapter each reimplement upsert-by-compound-key, the seal
 * accounting, the prune execution and the window filtering. Without a suite binding them, every
 * spec written above the port would be a statement about whichever one it happened to run against,
 * and the two would drift apart in exactly the places that are expensive to notice: a counter that
 * moves twice, a chunk that outlives its session row, a rename a reconnect quietly undoes.
 *
 * So everything asserted here is a rule both must obey. Where they legitimately differ — the fake
 * emulates no quota, the adapter emulates no second tab — the case belongs in one of the two
 * specs and not in this file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HistoryStore } from '../../src/application/history/port'
import { MAX_RENDER_WINDOW_MS, unavailableHistoryStore } from '../../src/application/history/port'
import { MAX_SESSIONS } from '../../src/domain/history/budget'
import { isReadableLayout } from '../../src/domain/history/columns'
import { PACK_SAMPLING_PERIOD_SECONDS } from '../../src/domain/history/ringClock'
import { MIN_ALIGNMENT_OVERLAP } from '../../src/domain/history/ringLedger'
import type { RingRecordRow } from '../../src/domain/history/RingRecordRow'
import type { RingSnapshot } from '../../src/domain/history/RingSnapshot'
import {
  CHUNK_LAYOUT_VERSION,
  HEARTBEAT_STALE_MS,
  PACK_STREAM,
  SOLAR_STREAM,
} from '../../src/domain/history/types'
import type { DeviceKey, HistoryChunk, SessionId } from '../../src/domain/history/types'
import {
  PACK_DEVICE_KEY,
  RING_EPOCH_COUNTER_SECONDS,
  SAMPLE_EPOCH,
  SESSION_ID,
  deviceRecord,
  inForeignLayout,
  packChunk,
  packSamples,
  ringRecordBytes,
  ringRecordCounter,
  ringRecords,
  ringSnapshot,
  sessionClosure,
  sessionPatch,
  sessionRecord,
  solarChunk,
  solarSamples,
  warningRecord,
} from './samples'
import {
  CAPTURED_DAYS,
  CAPTURE_OBSERVED_AT,
  CAPTURE_READ_ON_DATE,
  SOLAR_DEVICE_KEY,
  capturedDayBytes,
  capturedSolarSnapshot,
  dayReading,
  laterSolarSnapshot,
  unwrittenDayBytes,
  withYield,
} from './solarHistoryFixture'

/** What a spec has to hand back so the suite can open a store and let go of it again. */
export interface HistoryStoreHarness {
  readonly store: HistoryStore
  dispose(): Promise<void>
}

const HOUR_MS = 3_600_000

/** A second pack, for the cases about one ledger not reaching into another. */
const OTHER_PACK_KEY: DeviceKey = 'jk:DEMO00000000002'

/**
 * Twenty consecutive hourly records off one pack — enough ring for a second read to find it shifted
 * and still overlap. Built once: nothing below mutates a record, and the fold compares bytes.
 */
const RING = ringRecords(20)

const FIRST_READ_AT = SAMPLE_EPOCH + 20 * HOUR_MS
const SECOND_READ_AT = FIRST_READ_AT + 8 * HOUR_MS

/** One unbroken read, as the transport hands it over: records in ring order from `firstIndex`. */
function ringRead(
  records: readonly Uint8Array[],
  options: {
    readonly firstIndex?: number
    readonly observedAt?: number
    readonly deviceKey?: DeviceKey
  } = {},
): RingSnapshot {
  return ringSnapshot({
    deviceKey: options.deviceKey ?? PACK_DEVICE_KEY,
    observedAt: options.observedAt ?? FIRST_READ_AT,
    runs: [{ firstIndex: options.firstIndex ?? 0, records }],
  })
}

function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Everything a stored row is: where it sits, what it holds, and whether its predecessor is gone. */
function rowSignature(row: RingRecordRow): string {
  return `${row.seq}:${hexOf(row.bytes)}:${row.followsGap}`
}

export function describeHistoryStore(name: string, open: () => Promise<HistoryStoreHarness>): void {
  describe(`${name} — the archive port`, () => {
    let harness: HistoryStoreHarness
    let store: HistoryStore

    beforeEach(async () => {
      harness = await open()
      store = harness.store
    })

    afterEach(async () => {
      await harness.dispose()
    })

    /** A session already carrying `rows` sealed pack rows, which is where most cases start. */
    async function openWithRows(rows: number, id: SessionId = SESSION_ID): Promise<void> {
      await store.openSession(sessionRecord({ id }))
      await store.commitChunk(
        packChunk(packSamples(rows), { sessionId: id }),
        sessionPatch({ packSamples: rows, packChunks: 1 }),
      )
    }

    describe('opening and listing', () => {
      it('lists a session it was told to open', async () => {
        await store.openSession(sessionRecord())

        const listings = await store.listSessions()

        expect(listings).toHaveLength(1)
        expect(listings[0].record.id).toBe(SESSION_ID)
        expect(listings[0].record.state).toBe('open')
      })

      it('lists newest first and honours a limit', async () => {
        for (let index = 0; index < 3; index += 1) {
          await store.openSession(
            sessionRecord({ id: `session-${index}`, startedAt: SAMPLE_EPOCH + index * HOUR_MS }),
          )
        }

        const listings = await store.listSessions()
        expect(listings.map((listing) => listing.record.id)).toEqual([
          'session-2',
          'session-1',
          'session-0',
        ])
        expect(await store.listSessions(2)).toHaveLength(2)
      })

      it('names the session from the device it groups under', async () => {
        await store.upsertDevice(deviceRecord())
        await store.openSession(sessionRecord())

        const [listing] = await store.listSessions()

        expect(listing.device?.key).toBe(PACK_DEVICE_KEY)
        expect(listing.label).toBe('JK_B2A8S20P · …0001')
      })

      it('still lists a session whose device row was never written', async () => {
        await store.openSession(sessionRecord())

        const [listing] = await store.listSessions()

        expect(listing.device).toBeNull()
        expect(listing.label).toBe('Unidentified pack')
      })
    })

    describe('committing a chunk', () => {
      it('refuses a chunk whose session was never opened', async () => {
        // A session row invented here would carry none of the fields only the recorder knows, and
        // would be indistinguishable from a real one afterwards.
        const outcome = await store.commitChunk(packChunk(packSamples(3)), sessionPatch())

        expect(outcome.stored).toBe(false)
        expect(outcome.failure).toBeNull()
        expect(await store.listSessions()).toHaveLength(0)
      })

      it('merges the patch over the stored row without touching what it does not own', async () => {
        await store.openSession(sessionRecord({ writerId: 'writer-0001' }))
        await store.commitChunk(
          packChunk(packSamples(4)),
          sessionPatch({ packSamples: 4, packChunks: 1, heartbeatAt: SAMPLE_EPOCH + 4_000 }),
        )

        const [listing] = await store.listSessions()
        expect(listing.record.packSamples).toBe(4)
        expect(listing.record.heartbeatAt).toBe(SAMPLE_EPOCH + 4_000)
        expect(listing.record.writerId).toBe('writer-0001')
        expect(listing.record.startedAt).toBe(SAMPLE_EPOCH)
        expect(listing.record.state).toBe('open')
      })

      it('moves the archive counter when a chunk seals, and by exactly its rows', async () => {
        await openWithRows(7)

        expect(await store.usage()).toEqual({ totalSamples: 7, sessions: 1, ringRecords: 0 })
      })

      it('leaves the counter alone for a tail, however many times it is rewritten', async () => {
        // The tail is rewritten at its own key every checkpoint. That is what makes a
        // re-checkpointed session free, and a retried commit impossible to double-count.
        await store.openSession(sessionRecord())
        for (const rows of [1, 2, 3]) {
          await store.commitChunk(
            packChunk(packSamples(rows), { sealed: false }),
            sessionPatch({ packSamples: rows, packChunks: 1 }),
          )
        }

        expect((await store.usage()).totalSamples).toBe(0)
        const stored = await store.readSession(SESSION_ID)
        expect(stored?.pack).toHaveLength(1)
        expect(stored?.pack[0].length).toBe(3)
      })

      it('counts a sealed chunk once even if the same seal is committed again', async () => {
        await store.openSession(sessionRecord())
        const chunk = packChunk(packSamples(5))
        await store.commitChunk(chunk, sessionPatch({ packSamples: 5, packChunks: 1 }))
        await store.commitChunk(chunk, sessionPatch({ packSamples: 5, packChunks: 1 }))

        expect((await store.usage()).totalSamples).toBe(5)
      })

      it('keeps the two streams apart under one session', async () => {
        await store.openSession(sessionRecord())
        await store.commitChunk(packChunk(packSamples(4)), sessionPatch({ packSamples: 4 }))
        await store.commitChunk(solarChunk(solarSamples(6)), sessionPatch({ packSamples: 4, solarSamples: 6 }))

        const stored = await store.readSession(SESSION_ID)
        expect(stored?.pack).toHaveLength(1)
        expect(stored?.solar).toHaveLength(1)
        expect((await store.usage()).totalSamples).toBe(10)
      })

      it('stores a copy, so a builder reusing its buffers cannot rewrite history', async () => {
        await store.openSession(sessionRecord())
        const chunk = packChunk(packSamples(3, { currentA: -8.4 }))
        await store.commitChunk(chunk, sessionPatch({ packSamples: 3, packChunks: 1 }))

        chunk.currentMa[0] = 999_000

        const stored = await store.readSession(SESSION_ID)
        expect(stored?.pack[0].currentMa[0]).toBe(-8_400)
      })
    })

    describe('closing a session', () => {
      it('folds the unsealed tail into the counted totals exactly once', async () => {
        await store.openSession(sessionRecord())
        await store.commitChunk(
          packChunk(packSamples(6), { sealed: false }),
          sessionPatch({ packSamples: 6, packChunks: 1 }),
        )
        expect((await store.usage()).totalSamples).toBe(0)

        await store.closeSession(SESSION_ID, sessionClosure({ packSamples: 6, packChunks: 1 }))

        expect((await store.usage()).totalSamples).toBe(6)
        const [listing] = await store.listSessions()
        expect(listing.record.state).toBe('closed')
        expect(listing.record.sealedSamples).toBe(6)
      })

      it('is idempotent all the way down to the counter', async () => {
        // finish() may run twice; a second close finds no open chunk and folds nothing.
        await store.openSession(sessionRecord())
        await store.commitChunk(
          packChunk(packSamples(6), { sealed: false }),
          sessionPatch({ packSamples: 6 }),
        )
        await store.closeSession(SESSION_ID, sessionClosure({ packSamples: 6 }))
        await store.closeSession(SESSION_ID, sessionClosure({ packSamples: 6 }))

        expect((await store.usage()).totalSamples).toBe(6)
      })

      it('records why the watch ended', async () => {
        await openWithRows(4)

        await store.closeSession(
          SESSION_ID,
          sessionClosure({ endReason: 'link-lost', endedAt: SAMPLE_EPOCH + 4_000, packSamples: 4 }),
        )

        const [listing] = await store.listSessions()
        expect(listing.record.endReason).toBe('link-lost')
        expect(listing.record.endedAt).toBe(SAMPLE_EPOCH + 4_000)
      })

      it('does nothing at all for a session that is not there', async () => {
        await store.closeSession('never-opened', sessionClosure())

        expect(await store.listSessions()).toHaveLength(0)
      })
    })

    describe('deleting a session', () => {
      it('takes the row and every chunk together', async () => {
        // An orphan chunk is unreachable and holds its share of the budget forever.
        await openWithRows(9)

        await store.deleteSession(SESSION_ID)

        expect(await store.listSessions()).toHaveLength(0)
        expect(await store.readSession(SESSION_ID)).toBeNull()
        expect(await store.usage()).toEqual({ totalSamples: 0, sessions: 0, ringRecords: 0 })

        const visited: HistoryChunk[] = []
        await store.streamChunks(SESSION_ID, PACK_STREAM, { from: 0, to: Number.MAX_SAFE_INTEGER }, (chunk) => {
          visited.push(chunk)
        })
        expect(visited).toEqual([])
      })

      it('leaves every other session alone', async () => {
        await openWithRows(4, 'session-a')
        await openWithRows(6, 'session-b')

        await store.deleteSession('session-a')

        expect((await store.listSessions()).map((listing) => listing.record.id)).toEqual(['session-b'])
        expect((await store.usage()).totalSamples).toBe(6)
      })

      it('does nothing at all for a session that is not there', async () => {
        await openWithRows(4)

        await store.deleteSession('never-opened')

        expect((await store.usage()).totalSamples).toBe(4)
      })
    })

    describe('reading a session back', () => {
      it('has nothing to return for an id that is gone', async () => {
        // A reader whose session was pruned underneath it lands here, and falls back to the list.
        expect(await store.readSession('never-opened')).toBeNull()
      })

      it('returns the chunks in sequence order whatever order they were written', async () => {
        await store.openSession(sessionRecord())
        for (const seq of [2, 0, 1]) {
          await store.commitChunk(
            packChunk(packSamples(3, { at: SAMPLE_EPOCH + seq * 300_000 }), { seq }),
            sessionPatch({ packSamples: 9, packChunks: 3 }),
          )
        }
        await store.closeSession(
          SESSION_ID,
          sessionClosure({ endedAt: SAMPLE_EPOCH + 900_000, packSamples: 9, packChunks: 3 }),
        )

        const stored = await store.readSession(SESSION_ID)
        expect(stored?.pack.map((chunk) => chunk.seq)).toEqual([0, 1, 2])
      })

      it('returns only the chunks the asked-for window touches', async () => {
        await store.openSession(sessionRecord())
        for (const seq of [0, 1, 2]) {
          await store.commitChunk(
            packChunk(packSamples(3, { at: SAMPLE_EPOCH + seq * 300_000 }), { seq }),
            sessionPatch({ packSamples: 9, packChunks: 3 }),
          )
        }
        await store.closeSession(
          SESSION_ID,
          sessionClosure({ endedAt: SAMPLE_EPOCH + 900_000, packSamples: 9, packChunks: 3 }),
        )

        const stored = await store.readSession(SESSION_ID, {
          from: SAMPLE_EPOCH + 300_000,
          to: SAMPLE_EPOCH + 302_000,
        })
        expect(stored?.pack.map((chunk) => chunk.seq)).toEqual([1])
        expect(stored?.windowClamped).toBe(false)
      })

      it('says when a session is wider than one read may cover', async () => {
        // The session view's clock band is one day, so nothing it draws is wider than this. A
        // longer watch is returned from its late end backwards, and says it is a window.
        await openWithRows(4)
        await store.closeSession(
          SESSION_ID,
          sessionClosure({ endedAt: SAMPLE_EPOCH + MAX_RENDER_WINDOW_MS + HOUR_MS, packSamples: 4 }),
        )

        const stored = await store.readSession(SESSION_ID)
        expect(stored?.windowClamped).toBe(true)
      })

      it('carries the device rows the session names', async () => {
        await store.upsertDevice(deviceRecord({ userLabel: 'Starboard bank' }))
        await store.openSession(sessionRecord())
        await store.commitChunk(packChunk(packSamples(3)), sessionPatch({ packSamples: 3 }))

        const stored = await store.readSession(SESSION_ID)
        expect(stored?.packDevice?.userLabel).toBe('Starboard bank')
        expect(stored?.solarDevice).toBeNull()
      })

      it('streams one stream of one session, in sequence order', async () => {
        await store.openSession(sessionRecord())
        for (const seq of [0, 1]) {
          await store.commitChunk(
            packChunk(packSamples(2, { at: SAMPLE_EPOCH + seq * 300_000 }), { seq }),
            sessionPatch({ packSamples: 4, packChunks: 2 }),
          )
        }
        await store.commitChunk(solarChunk(solarSamples(2)), sessionPatch({ packSamples: 4, solarSamples: 2 }))

        const seen: number[] = []
        await store.streamChunks(
          SESSION_ID,
          PACK_STREAM,
          { from: SAMPLE_EPOCH, to: SAMPLE_EPOCH + 600_000 },
          (chunk) => {
            expect(chunk.stream).toBe(PACK_STREAM)
            seen.push(chunk.seq)
          },
        )

        expect(seen).toEqual([0, 1])
      })

      it('hands over a chunk in a layout it cannot read, rather than dropping it', async () => {
        // Dropping it here is what would report a session holding thousands of rows as one holding
        // none: the row keeps its counts, and the caller above needs the chunk itself to say why
        // nothing could be drawn from it.
        await store.openSession(sessionRecord())
        await store.commitChunk(
          inForeignLayout(packChunk(packSamples(3))),
          sessionPatch({ packSamples: 3, packChunks: 1 }),
        )

        const stored = await store.readSession(SESSION_ID)

        expect(stored?.pack).toHaveLength(1)
        expect(isReadableLayout(stored?.pack[0].layout ?? CHUNK_LAYOUT_VERSION)).toBe(false)
        expect(stored?.record.packSamples).toBe(3)
      })

      it('hands it over whatever window was asked for, having no way to place it in time', async () => {
        // Deciding a chunk falls outside a window means indexing its offsets, which is the same
        // read the gate refuses. A readable chunk from the same session is windowed as ever.
        await store.openSession(sessionRecord())
        await store.commitChunk(
          packChunk(packSamples(3), { seq: 0 }),
          sessionPatch({ packSamples: 3, packChunks: 1 }),
        )
        await store.commitChunk(
          inForeignLayout(packChunk(packSamples(3, { at: SAMPLE_EPOCH + 300_000 }), { seq: 1 })),
          sessionPatch({ packSamples: 6, packChunks: 2 }),
        )

        const stored = await store.readSession(SESSION_ID, {
          from: SAMPLE_EPOCH + HOUR_MS,
          to: SAMPLE_EPOCH + 2 * HOUR_MS,
        })

        expect(stored?.pack.map((chunk) => chunk.seq)).toEqual([1])
      })

      it('leaves it out of the export stream, which has no row it could write from it', async () => {
        await store.openSession(sessionRecord())
        await store.commitChunk(
          inForeignLayout(packChunk(packSamples(3))),
          sessionPatch({ packSamples: 3, packChunks: 1 }),
        )

        const seen: HistoryChunk[] = []
        await store.streamChunks(
          SESSION_ID,
          PACK_STREAM,
          { from: 0, to: Number.MAX_SAFE_INTEGER },
          (chunk) => seen.push(chunk),
        )

        expect(seen).toEqual([])
      })

      it('streams nothing for a window the session does not reach', async () => {
        await openWithRows(4)

        const seen: HistoryChunk[] = []
        await store.streamChunks(
          SESSION_ID,
          SOLAR_STREAM,
          { from: SAMPLE_EPOCH, to: SAMPLE_EPOCH + 4_000 },
          (chunk) => seen.push(chunk),
        )

        expect(seen).toEqual([])
      })
    })

    describe('devices', () => {
      it('keeps the name the owner chose across every later sighting of the device', async () => {
        // userLabel lives on the device row and not on a session row precisely so one rename
        // covers every session, and a reconnect must not undo it.
        await store.upsertDevice(deviceRecord())
        await store.renameDevice(PACK_DEVICE_KEY, 'Starboard bank')

        await store.upsertDevice(deviceRecord({ lastSeenAt: SAMPLE_EPOCH + HOUR_MS, sessionCount: 2 }))

        const [device] = await store.listDevices()
        expect(device.userLabel).toBe('Starboard bank')
        expect(device.lastSeenAt).toBe(SAMPLE_EPOCH + HOUR_MS)
        expect(device.sessionCount).toBe(2)
      })

      it('keeps the first sighting and never counts a device down', async () => {
        await store.upsertDevice(deviceRecord({ firstSeenAt: SAMPLE_EPOCH, sessionCount: 4 }))

        await store.upsertDevice(
          deviceRecord({ firstSeenAt: SAMPLE_EPOCH + HOUR_MS, lastSeenAt: SAMPLE_EPOCH, sessionCount: 1 }),
        )

        const [device] = await store.listDevices()
        expect(device.firstSeenAt).toBe(SAMPLE_EPOCH)
        expect(device.sessionCount).toBe(4)
      })

      it('restores the derived name when the field is cleared, rather than blanking the device', async () => {
        await store.upsertDevice(deviceRecord())
        await store.renameDevice(PACK_DEVICE_KEY, 'Starboard bank')

        const restored = await store.renameDevice(PACK_DEVICE_KEY, '   ')

        expect(restored?.userLabel).toBeNull()
        expect(restored?.defaultLabel).toBe('JK_B2A8S20P · …0001')
      })

      it('has nothing to rename for a device it never saw', async () => {
        expect(await store.renameDevice('jk:NOTHING', 'Anything')).toBeNull()
      })

      it('survives a chunk commit carrying the device again', async () => {
        await store.upsertDevice(deviceRecord())
        await store.renameDevice(PACK_DEVICE_KEY, 'Starboard bank')
        await openWithRows(3)

        const [device] = await store.listDevices()
        expect(device.userLabel).toBe('Starboard bank')
      })
    })

    describe('recovering from a killed tab', () => {
      const LATER = SAMPLE_EPOCH + HEARTBEAT_STALE_MS + 60_000

      it('closes a session whose writer is gone, and never deletes its rows', async () => {
        // A tab that was merely frozen must find its work intact when it thaws.
        await store.openSession(sessionRecord({ heartbeatAt: SAMPLE_EPOCH }))
        await store.commitChunk(
          packChunk(packSamples(30), { sealed: false }),
          sessionPatch({ packSamples: 30, packChunks: 1, heartbeatAt: SAMPLE_EPOCH }),
        )

        const swept = await store.recover(LATER)

        expect(swept.closed).toBe(1)
        const [listing] = await store.listSessions()
        expect(listing.record.state).toBe('closed')
        expect(listing.record.endReason).toBe('abandoned')
        // The end is derived from the last row it actually holds, not from the heartbeat.
        expect(listing.record.endedAt).toBe(SAMPLE_EPOCH + 29_000)
        expect(listing.record.sealedSamples).toBe(30)
        expect((await store.usage()).totalSamples).toBe(30)
      })

      it('leaves a session whose heartbeat is still fresh completely alone', async () => {
        await store.openSession(sessionRecord({ heartbeatAt: LATER - 1_000 }))
        await store.commitChunk(
          packChunk(packSamples(30)),
          sessionPatch({ packSamples: 30, heartbeatAt: LATER - 1_000 }),
        )

        const swept = await store.recover(LATER)

        expect(swept.closed).toBe(0)
        expect((await store.listSessions())[0].record.state).toBe('open')
      })

      it('deletes a stale row that recorded nothing, because it is not history', async () => {
        await store.openSession(sessionRecord({ heartbeatAt: SAMPLE_EPOCH }))

        await store.recover(LATER)

        expect(await store.listSessions()).toHaveLength(0)
      })

      it('runs twice without folding the same tail twice', async () => {
        await store.openSession(sessionRecord({ heartbeatAt: SAMPLE_EPOCH }))
        await store.commitChunk(
          packChunk(packSamples(12), { sealed: false }),
          sessionPatch({ packSamples: 12, heartbeatAt: SAMPLE_EPOCH }),
        )

        await store.recover(LATER)
        await store.recover(LATER + 1_000)

        expect((await store.usage()).totalSamples).toBe(12)
      })
    })

    describe('too many sessions', () => {
      it('evicts the oldest rows and their chunks in the commit that overran the cap', async () => {
        // The only budget reachable in a test: the sample cap is two million rows. Both stores run
        // the same pure plan, so this is the execution rather than the policy.
        const overflow = MAX_SESSIONS + 2
        for (let index = 0; index < overflow; index += 1) {
          const id = `session-${String(index).padStart(4, '0')}`
          await store.openSession(sessionRecord({ id, startedAt: SAMPLE_EPOCH + index * 1_000 }))
          await store.closeSession(
            id,
            sessionClosure({ heartbeatAt: SAMPLE_EPOCH, endedAt: SAMPLE_EPOCH + index * 1_000 }),
          )
        }
        const live = 'session-live'
        await store.openSession(sessionRecord({ id: live, startedAt: SAMPLE_EPOCH + HOUR_MS }))

        const outcome = await store.commitChunk(
          packChunk(packSamples(3), { sessionId: live }),
          sessionPatch({ packSamples: 3, heartbeatAt: SAMPLE_EPOCH + 2 * HOUR_MS }),
        )

        expect(outcome.stored).toBe(true)
        expect(outcome.prunedSessionIds).toEqual(['session-0000', 'session-0001', 'session-0002'])
        expect((await store.usage()).sessions).toBe(MAX_SESSIONS)
        expect(await store.readSession('session-0000')).toBeNull()
      })
    })

    describe('warnings', () => {
      it("reads back a session's warnings in the order they fired", async () => {
        await store.openSession(sessionRecord())
        await store.appendWarning(warningRecord({ seq: 0, title: 'Cells warm' }))
        await store.appendWarning(warningRecord({ seq: 1, title: 'MOSFET hot' }))

        const warnings = await store.warningsOf(SESSION_ID)
        expect(warnings.map((warning) => warning.title)).toEqual(['Cells warm', 'MOSFET hot'])
        expect(warnings[0].snapshot.packCurrentA).toBe(-8.4)
      })

      it('lists warnings across sessions, most recent first, honouring a limit', async () => {
        await store.openSession(sessionRecord({ id: 'session-a' }))
        await store.openSession(sessionRecord({ id: 'session-b' }))
        await store.appendWarning(warningRecord({ sessionId: 'session-a', seq: 0, at: SAMPLE_EPOCH }))
        await store.appendWarning(warningRecord({ sessionId: 'session-b', seq: 0, at: SAMPLE_EPOCH + 5_000 }))
        await store.appendWarning(warningRecord({ sessionId: 'session-a', seq: 1, at: SAMPLE_EPOCH + 10_000 }))

        const all = await store.listWarnings()
        expect(all.map((warning) => warning.at)).toEqual([
          SAMPLE_EPOCH + 10_000,
          SAMPLE_EPOCH + 5_000,
          SAMPLE_EPOCH,
        ])
        expect(await store.listWarnings(2)).toHaveLength(2)
      })

      it('reads only the warnings inside a window, ascending, uncapped by the log limit', async () => {
        // The Stats range tally reads this rather than the capped list, so a wide range counts the
        // whole window. Both bounds are inclusive; anything outside is left out.
        await store.openSession(sessionRecord({ id: 'session-a' }))
        for (const [seq, offset] of [0, 5_000, 10_000, 20_000].entries()) {
          await store.appendWarning(
            warningRecord({ sessionId: 'session-a', seq, at: SAMPLE_EPOCH + offset }),
          )
        }

        const inside = await store.warningsInWindow({
          from: SAMPLE_EPOCH + 5_000,
          to: SAMPLE_EPOCH + 10_000,
        })

        expect(inside.map((warning) => warning.at)).toEqual([
          SAMPLE_EPOCH + 5_000,
          SAMPLE_EPOCH + 10_000,
        ])
      })

      it('takes a session’s warnings with it when the session is deleted', async () => {
        await openWithRows(4)
        await store.appendWarning(warningRecord({ seq: 0 }))
        await store.appendWarning(warningRecord({ seq: 1 }))

        await store.deleteSession(SESSION_ID)

        expect(await store.warningsOf(SESSION_ID)).toEqual([])
        expect(await store.listWarnings()).toEqual([])
      })

      it('leaves another session’s warnings alone when one is deleted', async () => {
        await openWithRows(4, 'session-a')
        await openWithRows(4, 'session-b')
        await store.appendWarning(warningRecord({ sessionId: 'session-a', seq: 0 }))
        await store.appendWarning(warningRecord({ sessionId: 'session-b', seq: 0 }))

        await store.deleteSession('session-a')

        expect(await store.warningsOf('session-a')).toEqual([])
        expect((await store.warningsOf('session-b')).map((warning) => warning.sessionId)).toEqual([
          'session-b',
        ])
      })
    })

    describe("the pack's own ring", () => {
      /** The rows one pack's ledger holds, in the order the store hands them over. */
      async function rowsOf(deviceKey: DeviceKey = PACK_DEVICE_KEY): Promise<readonly RingRecordRow[]> {
        return (await store.readRingLedger(deviceKey))?.records ?? []
      }

      it('never changes a stored row’s seq, and never rewrites its bytes', async () => {
        // The ring shifts under a reader — 42 places in three and a half hours on the real pack —
        // so a merge that renumbered or rewrote would silently rewrite history every read.
        await store.appendRingSnapshot(ringRead(RING.slice(0, 12)))
        const opened = (await rowsOf()).map(rowSignature)

        await store.appendRingSnapshot(ringRead(RING.slice(4), { observedAt: SECOND_READ_AT }))

        const merged = await rowsOf()
        expect(merged.slice(0, 12).map(rowSignature)).toEqual(opened)
        expect(merged.map((row) => hexOf(row.bytes))).toEqual(RING.map(hexOf))
      })

      it('hands out a dense, monotone seq per device', async () => {
        await store.appendRingSnapshot(ringRead(RING.slice(0, 12)))
        await store.appendRingSnapshot(ringRead(RING.slice(4), { observedAt: SECOND_READ_AT }))

        const seqs = (await rowsOf()).map((row) => row.seq)
        expect(seqs).toEqual(Array.from({ length: RING.length }, (_unused, at) => at))
      })

      it('appends nothing when the same read is filed twice', async () => {
        // The read button is a button, and a tab that files its transfer twice must not double the
        // ledger. Recognition is the fold's own, so idempotence costs the store nothing.
        await store.appendRingSnapshot(ringRead(RING))

        const again = await store.appendRingSnapshot(ringRead(RING, { observedAt: SECOND_READ_AT }))

        expect(again.appended).toBe(0)
        expect(again.overlap).toBe(RING.length)
        expect(again.totalRecords).toBe(RING.length)
      })

      it('reaches the same ledger from a cut-short read plus a whole one as from the whole one', async () => {
        await store.appendRingSnapshot(ringRead(RING.slice(0, 8)))
        await store.appendRingSnapshot(ringRead(RING, { observedAt: SECOND_READ_AT }))

        await store.appendRingSnapshot(ringRead(RING, { deviceKey: OTHER_PACK_KEY }))

        expect((await rowsOf()).map(rowSignature)).toEqual(
          (await rowsOf(OTHER_PACK_KEY)).map(rowSignature),
        )
      })

      it('appends nothing and declares no gap for a read lying wholly inside the ledger', async () => {
        // The case a suffix-of-ledger against prefix-of-read match gets wrong: it would report no
        // overlap and append several hundred rows the ledger already holds.
        await store.appendRingSnapshot(ringRead(RING))

        const inside = await store.appendRingSnapshot(
          ringRead(RING.slice(4, 12), { firstIndex: 4, observedAt: SECOND_READ_AT }),
        )

        expect(inside.appended).toBe(0)
        expect(inside.gapDeclared).toBe(false)
        expect(inside.overlap).toBe(8)
        expect((await rowsOf()).length).toBe(RING.length)
      })

      it('keeps two byte-identical adjacent records as two rows', async () => {
        // Nine such pairs sit in one real read and both halves are records the pack wrote. A
        // content digest as the merge key would collapse them and make the ledger disagree with
        // the pack about how many hours it holds.
        const stalled = { counterSeconds: RING_EPOCH_COUNTER_SECONDS + 3 * PACK_SAMPLING_PERIOD_SECONDS }
        const twins = [...RING.slice(0, 3), ringRecordBytes(stalled), ringRecordBytes(stalled)]

        await store.appendRingSnapshot(ringRead(twins))

        const rows = await rowsOf()
        expect(rows).toHaveLength(5)
        expect(hexOf(rows[3].bytes)).toBe(hexOf(rows[4].bytes))
        expect([rows[3].seq, rows[4].seq]).toEqual([3, 4])
      })

      it('carries the pack’s clock counter denormalised off the bytes it stored', async () => {
        await store.appendRingSnapshot(ringRead(RING))

        for (const row of await rowsOf()) {
          expect(row.packClockSeconds).toBe(ringRecordCounter(row.bytes))
        }
      })

      it('orders rows by the pack’s write order even where the counter runs backwards', async () => {
        // The pack's clock was set forward seven hours on this boat, and the next correction will be
        // backward. Ordering by counter would interleave post-correction rows among rows written
        // hours earlier and make every consecutive-row fold wrong.
        const face = RING_EPOCH_COUNTER_SECONDS + 4 * PACK_SAMPLING_PERIOD_SECONDS
        const rewound = face - 25_268
        const rewrite = [
          ...RING.slice(0, 4),
          ringRecordBytes({ counterSeconds: face, eventCode: 0x3b }),
          ringRecordBytes({ counterSeconds: rewound, eventCode: 0x3b }),
          ringRecordBytes({ counterSeconds: rewound + PACK_SAMPLING_PERIOD_SECONDS }),
        ]

        await store.appendRingSnapshot(ringRead(rewrite))

        const rows = await rowsOf()
        expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
        expect(rows.map((row) => row.packClockSeconds)).toEqual(rewrite.map(ringRecordCounter))
        expect(rows[5].packClockSeconds).toBeLessThan(rows[4].packClockSeconds)
      })

      it('files a read under its own pack and reaches no other', async () => {
        await store.upsertDevice(deviceRecord({ key: OTHER_PACK_KEY, userLabel: 'Port bank' }))
        await store.appendRingSnapshot(ringRead(RING, { deviceKey: OTHER_PACK_KEY }))
        const untouched = await store.readRingLedger(OTHER_PACK_KEY)

        await store.appendRingSnapshot(ringRead(RING.slice(0, 6), { observedAt: SECOND_READ_AT }))

        expect(await store.readRingLedger(OTHER_PACK_KEY)).toEqual(untouched)
        expect((await rowsOf()).map((row) => row.deviceKey)).toEqual(Array(6).fill(PACK_DEVICE_KEY))
      })

      it('discards a run too short to identify itself, and says how many it gave up', async () => {
        // Never guessed at: a run under the alignment floor could sit at several shifts, and a
        // wrong one puts a row's neighbour an unknown distance away.
        const torn = ringSnapshot({
          observedAt: FIRST_READ_AT,
          runs: [
            { firstIndex: 0, records: RING.slice(0, 8) },
            { firstIndex: 50, records: RING.slice(12, 12 + MIN_ALIGNMENT_OVERLAP - 1) },
          ],
        })

        const outcome = await store.appendRingSnapshot(torn)

        expect(outcome.appended).toBe(8)
        expect(outcome.runsDiscarded).toBe(1)
        expect(outcome.totalRecords).toBe(8)
      })

      it('stamps exactly one row per contiguity break', async () => {
        // A month away from the boat leaves two reads with nothing in common. The break is declared
        // rather than bridged, and the ledger's own oldest row declares one too: the ring had
        // already dropped whatever came before it. The other row this field is set on is the oldest
        // survivor of a prune, which the budget cap puts out of a contract case's reach.
        await store.appendRingSnapshot(ringRead(RING.slice(0, 8)))
        const stranded = ringRecords(8, {
          counterSeconds: RING_EPOCH_COUNTER_SECONDS + 900 * PACK_SAMPLING_PERIOD_SECONDS,
        })

        const outcome = await store.appendRingSnapshot(
          ringRead(stranded, { observedAt: SECOND_READ_AT }),
        )

        expect(outcome.gapDeclared).toBe(true)
        const broken = (await rowsOf()).filter((row) => row.followsGap)
        expect(broken.map((row) => row.seq)).toEqual([0, 8])
      })

      it('journals exactly one row per read, whatever the read established', async () => {
        // A pack that stops answering 0xA7 after a firmware change is exactly what a stored history
        // of attempts reveals, so a read that carried nothing is the one most worth keeping.
        await store.appendRingSnapshot(
          ringSnapshot({ observedAt: FIRST_READ_AT, outcome: 'no-answer', runs: [] }),
        )
        await store.appendRingSnapshot(ringRead(RING, { observedAt: FIRST_READ_AT + HOUR_MS }))
        await store.appendRingSnapshot(
          ringSnapshot({ observedAt: SECOND_READ_AT, outcome: 'other-frames', runs: [] }),
        )

        const ledger = await store.readRingLedger(PACK_DEVICE_KEY)
        expect(ledger?.reads.map((read) => read.outcome)).toEqual([
          'other-frames',
          'records-read',
          'no-answer',
        ])
        const silent = ledger?.reads[2]
        expect(silent?.indexSpan).toBeNull()
        expect(silent?.recordsReceived).toBe(0)
        expect(silent?.recordsAppended).toBe(0)
      })

      it('keeps a ledger for a pack that answered nothing at all', async () => {
        await store.appendRingSnapshot(
          ringSnapshot({ observedAt: FIRST_READ_AT, outcome: 'no-answer', runs: [] }),
        )

        const ledger = await store.readRingLedger(PACK_DEVICE_KEY)
        expect(ledger?.records).toEqual([])
        expect(ledger?.reads).toHaveLength(1)
      })

      it('files no session reference on a ring row, and no session write disturbs the ledger', async () => {
        await store.appendRingSnapshot(ringRead(RING))
        const filed = (await rowsOf()).map(rowSignature)
        for (const row of await rowsOf()) expect('sessionId' in row).toBe(false)

        await openWithRows(5)
        await store.appendWarning(warningRecord({ seq: 0 }))
        await store.closeSession(SESSION_ID, sessionClosure({ packSamples: 5 }))
        await store.deleteSession(SESSION_ID)

        expect((await rowsOf()).map(rowSignature)).toEqual(filed)
      })

      it('never moves the sample budget, in either direction', async () => {
        // The two budgets cannot evict each other. Folding ring rows into the sample counter would
        // let session pruning delete device history to make room for a recording.
        await openWithRows(7)

        await store.appendRingSnapshot(ringRead(RING))

        expect(await store.usage()).toEqual({
          totalSamples: 7,
          sessions: 1,
          ringRecords: RING.length,
        })
        expect((await store.listSessions())[0].record.sealedSamples).toBe(7)
      })

      it('keeps the owner’s answers about the pack’s clock across a reconnect', async () => {
        // The same rule userLabel lives under: a reconnect's upsert carries derived fields only, and
        // forgetting that here is a silent data-loss bug rather than a visible one.
        await store.upsertDevice(deviceRecord())
        await store.setPackClock(PACK_DEVICE_KEY, { utcOffsetMinutes: 60, aheadSeconds: 25_268 })

        await store.upsertDevice(deviceRecord({ lastSeenAt: SAMPLE_EPOCH + HOUR_MS, sessionCount: 2 }))

        const [device] = await store.listDevices()
        expect(device.packUtcOffsetMinutes).toBe(60)
        expect(device.packClockAheadSeconds).toBe(25_268)
        expect(device.lastSeenAt).toBe(SAMPLE_EPOCH + HOUR_MS)
      })

      it('stores nothing on an archive that cannot hold one, and says why', async () => {
        // The unusable store is the same object whichever adapter this suite is running, and the
        // rule is the port's rather than either implementation's: no call site gains a null check.
        const refusing = unavailableHistoryStore('quota-exhausted')

        const outcome = await refusing.appendRingSnapshot(ringRead(RING))

        expect(outcome.stored).toBe(false)
        expect(outcome.failure).toBe('quota-exhausted')
        expect(outcome.appended).toBe(0)
        expect(outcome.totalRecords).toBe(0)
        expect(await refusing.readRingLedger(PACK_DEVICE_KEY)).toBeNull()
        expect(await refusing.listRingLedgers()).toEqual([])
        expect((await refusing.usage()).ringRecords).toBe(0)
      })
    })

    describe('reaching one pack’s ledger', () => {
      it('has nothing to return for a pack it never read', async () => {
        expect(await store.readRingLedger('jk:NOTHING')).toBeNull()
        expect(await store.listRingLedgers()).toEqual([])
      })

      it('reports what a read did, and how far the ring had moved under it', async () => {
        await store.appendRingSnapshot(ringRead(RING.slice(0, 12)))

        const second = await store.appendRingSnapshot(
          ringRead(RING.slice(4), { observedAt: SECOND_READ_AT }),
        )

        expect(second.appended).toBe(8)
        expect(second.overlap).toBe(8)
        expect(second.ringShift).toBe(4)
        expect(second.gapDeclared).toBe(false)
        expect(second.prunedRecords).toBe(0)
        expect(second.totalRecords).toBe(RING.length)
      })

      it('anchors a read to the newest scheduled record it carried', async () => {
        // The one measurement of how far the pack's clock runs ahead. An event record would not do:
        // it is written when the event fires, not on the sampling period the bound rests on.
        await store.appendRingSnapshot(ringRead(RING))

        const [read] = (await store.readRingLedger(PACK_DEVICE_KEY))?.reads ?? []
        expect(read.newestSampleCounter).toBe(ringRecordCounter(RING[RING.length - 1]))
        expect(read.newestSampleSeq).toBe(RING.length - 1)
        expect(read.indexSpan).toEqual({ from: 0, to: RING.length - 1 })
      })

      it('stamps a row with the wall clock of the read that first stored it', async () => {
        await store.appendRingSnapshot(ringRead(RING.slice(0, 12)))
        await store.appendRingSnapshot(ringRead(RING.slice(4), { observedAt: SECOND_READ_AT }))

        const rows = (await store.readRingLedger(PACK_DEVICE_KEY))?.records ?? []
        expect(rows[0].firstReadAt).toBe(FIRST_READ_AT)
        expect(rows[rows.length - 1].firstReadAt).toBe(SECOND_READ_AT)
      })

      it('lists every pack it has read, most recently read first', async () => {
        await store.upsertDevice(deviceRecord({ key: OTHER_PACK_KEY, userLabel: 'Port bank' }))
        await store.appendRingSnapshot(ringRead(RING, { observedAt: FIRST_READ_AT }))
        await store.appendRingSnapshot(
          ringRead(RING.slice(0, 6), { deviceKey: OTHER_PACK_KEY, observedAt: SECOND_READ_AT }),
        )

        const summaries = await store.listRingLedgers()
        expect(summaries.map((summary) => summary.deviceKey)).toEqual([
          OTHER_PACK_KEY,
          PACK_DEVICE_KEY,
        ])
        expect(summaries[0].label).toBe('Port bank')
        expect(summaries[1].records).toBe(RING.length)
        expect(summaries[1].oldestPackClockSeconds).toBe(ringRecordCounter(RING[0]))
        expect(summaries[1].newestPackClockSeconds).toBe(ringRecordCounter(RING[RING.length - 1]))
      })

      it('takes the owner’s answer about the clock and hands the row back', async () => {
        await store.upsertDevice(deviceRecord())

        const pinned = await store.setPackClock(PACK_DEVICE_KEY, {
          utcOffsetMinutes: 60,
          aheadSeconds: 25_268,
        })

        expect(pinned?.packUtcOffsetMinutes).toBe(60)
        expect(pinned?.packClockAheadSeconds).toBe(25_268)

        // Null clears it, exactly as an empty label restores the derived name: the owner may take
        // an answer back, and nothing else may.
        const cleared = await store.setPackClock(PACK_DEVICE_KEY, {
          utcOffsetMinutes: 60,
          aheadSeconds: null,
        })
        expect(cleared?.packClockAheadSeconds).toBeNull()
      })

      it('has no row to hang the owner’s answer on until the pack is seen', async () => {
        await store.appendRingSnapshot(ringRead(RING))

        expect(await store.setPackClock(PACK_DEVICE_KEY, { utcOffsetMinutes: 60, aheadSeconds: 0 })).toBeNull()
      })

      it('carries the device row alongside the ledger once there is one', async () => {
        await store.upsertDevice(deviceRecord({ userLabel: 'Starboard bank' }))
        await store.appendRingSnapshot(ringRead(RING))

        const ledger = await store.readRingLedger(PACK_DEVICE_KEY)
        expect(ledger?.device?.userLabel).toBe('Starboard bank')
        expect(ledger?.retainedFromSeq).toBeNull()
      })

      it('takes the rows and the journal together, and leaves the device row standing', async () => {
        await store.upsertDevice(deviceRecord())
        await store.setPackClock(PACK_DEVICE_KEY, { utcOffsetMinutes: 60, aheadSeconds: 25_268 })
        await store.appendRingSnapshot(ringRead(RING))
        await store.appendRingSnapshot(
          ringRead(RING.slice(0, 6), { deviceKey: OTHER_PACK_KEY, observedAt: SECOND_READ_AT }),
        )

        await store.deleteRingLedger(PACK_DEVICE_KEY)

        expect(await store.readRingLedger(PACK_DEVICE_KEY)).toBeNull()
        expect((await store.readRingLedger(OTHER_PACK_KEY))?.records).toHaveLength(6)
        expect((await store.usage()).ringRecords).toBe(6)
        const [device] = (await store.listDevices()).filter((row) => row.key === PACK_DEVICE_KEY)
        expect(device.packUtcOffsetMinutes).toBe(60)
      })
    })

    describe("the controller's own day records", () => {
      async function daysOf(deviceKey: DeviceKey = SOLAR_DEVICE_KEY) {
        return (await store.readRingLedger(deviceKey))?.solarDays ?? []
      }

      it('files a sweep under the controller’s own key, dated back from the day it ran', async () => {
        const outcome = await store.appendSolarHistory(capturedSolarSnapshot())

        expect(outcome.stored).toBe(true)
        expect(outcome.appended).toBe(CAPTURED_DAYS)
        expect(outcome.totalDays).toBe(CAPTURED_DAYS)
        const days = await daysOf()
        expect(days.map((day) => day.seq)).toEqual(days.map((_day, position) => position))
        expect(days[days.length - 1].date).toBe(CAPTURE_READ_ON_DATE)
        expect(days[0].day.recorded).toBe(true)
      })

      it('recognises a sweep it already holds and writes nothing', async () => {
        await store.appendSolarHistory(capturedSolarSnapshot())
        const filed = await daysOf()

        const again = await store.appendSolarHistory(
          capturedSolarSnapshot({ observedAt: CAPTURE_OBSERVED_AT + HOUR_MS }),
        )

        expect(again.appended).toBe(0)
        expect(again.unchanged).toBe(CAPTURED_DAYS)
        expect(await daysOf()).toEqual(filed)
      })

      it('replaces today in place and keeps its seq, as the day goes on', async () => {
        await store.appendSolarHistory(capturedSolarSnapshot())
        const wasToday = (await daysOf())[CAPTURED_DAYS - 1]
        const laterInTheDay = CAPTURE_OBSERVED_AT + 4 * HOUR_MS

        const outcome = await store.appendSolarHistory(
          capturedSolarSnapshot({
            observedAt: laterInTheDay,
            days: [dayReading(0, withYield(capturedDayBytes(0), 990))],
          }),
        )

        expect(outcome.revised).toBe(1)
        expect(outcome.totalDays).toBe(CAPTURED_DAYS)
        const revised = (await daysOf())[CAPTURED_DAYS - 1]
        expect(revised.seq).toBe(wasToday.seq)
        expect(revised.date).toBe(wasToday.date)
        expect(revised.firstReadAt).toBe(wasToday.firstReadAt)
        expect(revised.revisedAt).toBe(laterInTheDay)
        expect(revised.day.recorded && revised.day.yieldKwh).toBe(9.9)
      })

      it('appends only the day the calendar has turned over onto', async () => {
        await store.appendSolarHistory(capturedSolarSnapshot())

        const outcome = await store.appendSolarHistory(laterSolarSnapshot(1))

        expect(outcome.appended).toBe(1)
        expect(outcome.unchanged).toBe(CAPTURED_DAYS - 1)
        expect(outcome.totalDays).toBe(CAPTURED_DAYS + 1)
      })

      it('stores nothing for a register the controller has not written yet', async () => {
        const outcome = await store.appendSolarHistory(
          capturedSolarSnapshot({ days: [dayReading(0, unwrittenDayBytes(0)), dayReading(1)] }),
        )

        expect(outcome.unwritten).toBe(1)
        expect(await daysOf()).toHaveLength(1)
      })

      it('journals exactly one receipt per sweep, whatever the sweep established', async () => {
        // A controller that stops serving history after a firmware update is exactly what a stored
        // history of attempts reveals, so a sweep that carried nothing is the one worth keeping.
        await store.appendSolarHistory(
          capturedSolarSnapshot({
            outcome: 'refused',
            totals: null,
            days: [],
            transport: { refusedRegisters: [0x104f] },
          }),
        )
        await store.appendSolarHistory(
          capturedSolarSnapshot({ observedAt: CAPTURE_OBSERVED_AT + HOUR_MS }),
        )

        const ledger = await store.readRingLedger(SOLAR_DEVICE_KEY)
        expect(ledger?.solarReads.map((read) => read.outcome)).toEqual(['days-read', 'refused'])
        const refused = ledger?.solarReads[1]
        expect(refused?.daysReceived).toBe(0)
        expect(refused?.totals).toBeNull()
        expect(refused?.refusedRegisters).toEqual([0x104f])
        expect(ledger?.solarReads[0].totals?.daysAvailable).toBeGreaterThan(0)
        expect(ledger?.solarReads[0].readOnDate).toBe(CAPTURE_READ_ON_DATE)
        // The pack's own journal is a different list and stays empty.
        expect(ledger?.reads).toEqual([])
      })

      it('keeps a pack’s ledger and a controller’s apart inside one archive', async () => {
        await store.appendRingSnapshot(ringRead(RING))
        await store.appendSolarHistory(capturedSolarSnapshot())

        const pack = await store.readRingLedger(PACK_DEVICE_KEY)
        const controller = await store.readRingLedger(SOLAR_DEVICE_KEY)
        expect(pack?.records).toHaveLength(RING.length)
        expect(pack?.solarDays).toEqual([])
        expect(controller?.solarDays).toHaveLength(CAPTURED_DAYS)
        expect(controller?.records).toEqual([])
        expect((await store.usage()).ringRecords).toBe(RING.length + CAPTURED_DAYS)
      })

      it('reads a row carrying no format at all as a pack record', async () => {
        // Every pack row already on disk was written before the discriminator existed, and an
        // upgrade may only add — so absence is what says "pack record", now and permanently.
        await store.appendRingSnapshot(ringRead(RING))

        const rows = (await store.readRingLedger(PACK_DEVICE_KEY))?.records ?? []
        expect(rows).toHaveLength(RING.length)
        for (const row of rows) expect('format' in row).toBe(false)
      })

      it('says which radio each ledger belongs to, off the rows themselves', async () => {
        await store.appendRingSnapshot(ringRead(RING, { observedAt: FIRST_READ_AT }))
        await store.appendSolarHistory(
          capturedSolarSnapshot({ observedAt: FIRST_READ_AT + HOUR_MS }),
        )

        const summaries = await store.listRingLedgers()
        const controller = summaries.find((row) => row.deviceKey === SOLAR_DEVICE_KEY)
        const pack = summaries.find((row) => row.deviceKey === PACK_DEVICE_KEY)
        expect(controller?.kind).toBe('solar')
        expect(controller?.records).toBe(CAPTURED_DAYS)
        // A controller keeps no clock face, so it reports none rather than inventing one.
        expect(controller?.oldestPackClockSeconds).toBe(0)
        expect(controller?.newestPackClockSeconds).toBe(0)
        expect(pack?.kind).toBe('pack')
        expect(pack?.newestPackClockSeconds).toBe(ringRecordCounter(RING[RING.length - 1]))
      })

      it('never moves the sample budget, in either direction', async () => {
        await openWithRows(7)

        await store.appendSolarHistory(capturedSolarSnapshot())

        expect(await store.usage()).toEqual({
          totalSamples: 7,
          sessions: 1,
          ringRecords: CAPTURED_DAYS,
        })
      })

      it('takes the days and the journal together, and leaves the device row standing', async () => {
        await store.upsertDevice(
          deviceRecord({ key: SOLAR_DEVICE_KEY, kind: 'solar', userLabel: 'Coachroof panel' }),
        )
        await store.appendSolarHistory(capturedSolarSnapshot())

        await store.deleteRingLedger(SOLAR_DEVICE_KEY)

        expect(await store.readRingLedger(SOLAR_DEVICE_KEY)).toBeNull()
        expect((await store.usage()).ringRecords).toBe(0)
        const [device] = (await store.listDevices()).filter((row) => row.key === SOLAR_DEVICE_KEY)
        expect(device.userLabel).toBe('Coachroof panel')
      })

      it('stores nothing on an archive that cannot hold one, and says why', async () => {
        const refusing = unavailableHistoryStore('quota-exhausted')

        const outcome = await refusing.appendSolarHistory(capturedSolarSnapshot())

        expect(outcome.stored).toBe(false)
        expect(outcome.failure).toBe('quota-exhausted')
        expect(outcome.appended).toBe(0)
        expect(outcome.totalDays).toBe(0)
        expect(await refusing.readRingLedger(SOLAR_DEVICE_KEY)).toBeNull()
      })
    })

    describe('watching for another tab', () => {
      it('does not notify its own writer', async () => {
        // A view refreshing itself off its own writes would reload the list under the owner on
        // every checkpoint.
        let notified = 0
        const unsubscribe = store.watch(() => {
          notified += 1
        })

        await openWithRows(4)
        await store.closeSession(SESSION_ID, sessionClosure({ packSamples: 4 }))

        expect(notified).toBe(0)
        unsubscribe()
      })
    })
  })
}
