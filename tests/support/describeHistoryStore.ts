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
import { MAX_RENDER_WINDOW_MS } from '../../src/application/history/port'
import { MAX_SESSIONS } from '../../src/domain/history/budget'
import { HEARTBEAT_STALE_MS, PACK_STREAM, SOLAR_STREAM } from '../../src/domain/history/types'
import type { HistoryChunk, SessionId } from '../../src/domain/history/types'
import {
  PACK_DEVICE_KEY,
  SAMPLE_EPOCH,
  SESSION_ID,
  deviceRecord,
  packChunk,
  packSamples,
  sessionClosure,
  sessionPatch,
  sessionRecord,
  solarChunk,
  solarSamples,
  warningRecord,
} from './samples'

/** What a spec has to hand back so the suite can open a store and let go of it again. */
export interface HistoryStoreHarness {
  readonly store: HistoryStore
  dispose(): Promise<void>
}

const HOUR_MS = 3_600_000

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

        expect(await store.usage()).toEqual({ totalSamples: 7, sessions: 1 })
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
        expect(await store.usage()).toEqual({ totalSamples: 0, sessions: 0 })

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
