import 'fake-indexeddb/auto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { unavailableHistoryStore } from '../src/application/history/port'
import type { HistoryAvailability } from '../src/application/history/port'
import { PACK_SAMPLING_PERIOD_SECONDS } from '../src/domain/history/ringClock'
import { MAX_RING_DEVICES } from '../src/domain/history/ringBudget'
import type { RingSnapshot } from '../src/domain/history/RingSnapshot'
import { PACK_STREAM } from '../src/domain/history/types'
import type { DeviceKey, HistoryChunk, SessionRecord } from '../src/domain/history/types'
import type { ArchiveChannel, ArchiveMessage } from '../src/infrastructure/history/archiveChannel'
import {
  DATABASE_NAME,
  DATABASE_VERSION,
  IdbHistoryStore,
  applySchema,
} from '../src/infrastructure/history/IdbHistoryStore'
import { classifyWriteFailure, isQuotaError } from '../src/infrastructure/history/idb'
import { openHistoryStore } from '../src/infrastructure/history/openHistoryStore'
import {
  PACK_DEVICE_KEY,
  RING_EPOCH_COUNTER_SECONDS,
  SAMPLE_EPOCH,
  SESSION_ID,
  deviceRecord,
  packChunk,
  packSamples,
  ringReadRow,
  ringRecords,
  ringSnapshot,
  sessionClosure,
  sessionPatch,
  sessionRecord,
  warningRecord,
} from './support/samples'
import { describeHistoryStore } from './support/describeHistoryStore'

/**
 * The only file that imports `fake-indexeddb`, and the only place real IndexedDB semantics are
 * exercised — compound keys, index cursors, transaction scope and commit ordering are exactly the
 * things a hand-rolled fake would get wrong in the same direction as the code under test.
 *
 * One limitation is worth stating rather than working around: `fake-indexeddb` emulates no quota,
 * so a full disk cannot be reproduced here. The adapter's retry decision is extracted as
 * `classifyWriteFailure` and tested as the pure branch it is, and the recorder's behaviour on a
 * refused write is driven through the port instead.
 */

let databaseCount = 0

interface RecordedChannel extends ArchiveChannel {
  readonly posted: readonly ArchiveMessage[]
  /** Drops what has been heard so far, so a case can assert about one step of a longer setup. */
  forget(): void
}

/**
 * Stands in for BroadcastChannel and, like it, never delivers back to the context that posted.
 * A real one would also keep Node's event loop alive past the run.
 */
function recordingChannel(): RecordedChannel {
  const posted: ArchiveMessage[] = []
  return {
    posted,
    post: (message) => posted.push(message),
    subscribe: () => () => undefined,
    close: () => undefined,
    forget: () => posted.splice(0, posted.length),
  }
}

const USABLE: HistoryAvailability = {
  usable: true,
  reason: null,
  persisted: null,
  estimatedBytes: null,
  quotaBytes: null,
}

function openDatabase(name: string, version = DATABASE_VERSION): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = (event) => {
      applySchema(request.result, (event as IDBVersionChangeEvent).oldVersion)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

interface Adapter {
  readonly store: IdbHistoryStore
  readonly database: IDBDatabase
  readonly channel: RecordedChannel
  readonly name: string
  dispose(): Promise<void>
}

async function openAdapter(): Promise<Adapter> {
  databaseCount += 1
  const name = `shunt.log.spec.${databaseCount}`
  const database = await openDatabase(name)
  const channel = recordingChannel()
  const store = new IdbHistoryStore(database, USABLE, channel)
  return {
    store,
    database,
    channel,
    name,
    dispose: async () => {
      store.close()
      await deleteDatabase(name)
    },
  }
}

/** Reads a whole object store, for the assertions that have to look past the port. */
function readAll<T>(database: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const request = database.transaction([storeName], 'readonly').objectStore(storeName).getAll()
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error)
  })
}

function deleteRow(database: IDBDatabase, storeName: string, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName], 'readwrite')
    transaction.objectStore(storeName).delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
}

/** Writes rows straight into a store, for the states only a budget far past a test's reach reaches. */
function seedRows(database: IDBDatabase, storeName: string, rows: readonly unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName], 'readwrite')
    const store = transaction.objectStore(storeName)
    for (const row of rows) store.put(row)
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
}

/**
 * The scope of every transaction opened while `work` ran.
 *
 * The one thing about a ring merge that matters most is invisible from the port: IndexedDB
 * serialises overlapping-scope readwrite transactions across every connection on the origin, so a
 * merge that reached the chunk store would queue behind — or abort — a live recording's commit, and
 * nothing either store returns would ever show it.
 */
async function scopesOpenedDuring(
  database: IDBDatabase,
  work: () => Promise<unknown>,
): Promise<string[][]> {
  const opened: string[][] = []
  const real = database.transaction.bind(database)
  const watched = (stores: string | string[], mode?: IDBTransactionMode): IDBTransaction => {
    opened.push(typeof stores === 'string' ? [stores] : [...stores])
    return real(stores, mode)
  }
  Object.defineProperty(database, 'transaction', { value: watched, configurable: true })
  try {
    await work()
  } finally {
    Object.defineProperty(database, 'transaction', { value: real, configurable: true })
  }
  return opened
}

describeHistoryStore('IdbHistoryStore', async () => {
  const adapter = await openAdapter()
  return { store: adapter.store, dispose: adapter.dispose }
})

describe('the schema', () => {
  let adapter: Adapter

  afterEach(async () => {
    await adapter.dispose()
  })

  it('builds every store and every index the archive reads through', async () => {
    adapter = await openAdapter()
    const { database } = adapter

    expect([...database.objectStoreNames].sort()).toEqual([
      'chunks',
      'devices',
      'meta',
      'ringReads',
      'ringRecords',
      'sessions',
      'warnings',
    ])

    const transaction = database.transaction([...database.objectStoreNames], 'readonly')
    expect([...transaction.objectStore('sessions').indexNames].sort()).toEqual([
      'byDevice',
      'byStartedAt',
      'byState',
    ])
    expect([...transaction.objectStore('chunks').indexNames]).toEqual(['bySession'])
    expect([...transaction.objectStore('devices').indexNames]).toEqual(['byLastSeen'])
    expect([...transaction.objectStore('meta').indexNames]).toEqual([])
    expect([...transaction.objectStore('warnings').indexNames]).toEqual(['byTime'])
    expect([...transaction.objectStore('ringRecords').indexNames]).toEqual(['byDevice'])
    expect([...transaction.objectStore('ringReads').indexNames]).toEqual(['byDevice'])
  })

  it('keys a chunk on its session, stream and sequence together', async () => {
    adapter = await openAdapter()
    const transaction = adapter.database.transaction(['chunks'], 'readonly')

    expect(transaction.objectStore('chunks').keyPath).toEqual(['sessionId', 'stream', 'seq'])
  })

  it('keys a warning on its session and sequence together', async () => {
    adapter = await openAdapter()
    const transaction = adapter.database.transaction(['warnings'], 'readonly')

    expect(transaction.objectStore('warnings').keyPath).toEqual(['sessionId', 'seq'])
  })

  it('keys a ring row on the pack’s own write order, and a read on when it happened', async () => {
    // Never on the ring index, which moved 42 places in three and a half hours on the real pack,
    // and never on the RTC counter, which repeats and runs backwards across a clock rewrite.
    adapter = await openAdapter()
    const transaction = adapter.database.transaction(['ringRecords', 'ringReads'], 'readonly')

    expect(transaction.objectStore('ringRecords').keyPath).toEqual(['deviceKey', 'seq'])
    expect(transaction.objectStore('ringReads').keyPath).toEqual(['deviceKey', 'observedAt'])
  })

})

describe('upgrading an archive in place', () => {
  it('adds the ring stores to one already holding a session, a chunk and a warning', async () => {
    // An upgrade transaction blocks every tab on the origin and the chunk store is tens of
    // megabytes, so it may only add. What was already recorded has to come through untouched.
    databaseCount += 1
    const name = `shunt.log.spec.${databaseCount}`
    const before = await openThePreviousVersion(name)
    const store = new IdbHistoryStore(before, USABLE, recordingChannel())
    await store.openSession(sessionRecord())
    await store.commitChunk(packChunk(packSamples(5)), sessionPatch({ packSamples: 5, packChunks: 1 }))
    await store.appendWarning(warningRecord({ seq: 0 }))
    store.close()

    const upgraded = await openDatabase(name)

    expect(upgraded.version).toBe(DATABASE_VERSION)
    expect([...upgraded.objectStoreNames]).toContain('ringRecords')
    expect([...upgraded.objectStoreNames]).toContain('ringReads')
    expect(await readAll<SessionRecord>(upgraded, 'sessions')).toHaveLength(1)
    expect((await readAll<HistoryChunk>(upgraded, 'chunks'))[0].length).toBe(5)
    expect(await readAll(upgraded, 'warnings')).toHaveLength(1)
    upgraded.close()
    await deleteDatabase(name)
  })
})

describe('one write, one transaction', () => {
  let adapter: Adapter

  afterEach(async () => {
    await adapter.dispose()
  })

  it('rolls the chunk back when the session row that follows it cannot be written', async () => {
    // The chunk lands first and the row second. If the second fails, the first must not survive:
    // a chunk with a row that never learned about it is budget nobody can reach.
    adapter = await openAdapter()
    await adapter.store.openSession(sessionRecord())

    const unwritable = sessionPatch({ settings: (() => undefined) as never })
    const outcome = await adapter.store.commitChunk(packChunk(packSamples(4)), unwritable)

    expect(outcome.stored).toBe(false)
    expect(await readAll(adapter.database, 'chunks')).toEqual([])
    const [row] = await readAll<SessionRecord>(adapter.database, 'sessions')
    expect(row.packSamples).toBe(0)
    expect((await adapter.store.usage()).totalSamples).toBe(0)
  })

  it('writes nothing at all for a session another tab deleted underneath it', async () => {
    // This is the seam the recorder reads as "my row is gone": refused, with no storage failure to
    // name. It opens a fresh session pointing back at this one rather than resurrecting it.
    adapter = await openAdapter()
    await adapter.store.openSession(sessionRecord())
    await deleteRow(adapter.database, 'sessions', SESSION_ID)

    const outcome = await adapter.store.commitChunk(packChunk(packSamples(4)), sessionPatch())

    expect(outcome.stored).toBe(false)
    expect(outcome.failure).toBeNull()
    expect(await readAll(adapter.database, 'chunks')).toEqual([])
  })

  it('leaves one record behind for a tail rewritten at its own key', async () => {
    adapter = await openAdapter()
    await adapter.store.openSession(sessionRecord())
    for (const rows of [1, 2, 3]) {
      await adapter.store.commitChunk(
        packChunk(packSamples(rows), { sealed: false }),
        sessionPatch({ packSamples: rows }),
      )
    }

    const chunks = await readAll<HistoryChunk>(adapter.database, 'chunks')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].length).toBe(3)
    expect(chunks[0].sealed).toBe(false)
  })

  it('deletes a session and its chunks together, leaving nothing behind', async () => {
    adapter = await openAdapter()
    await adapter.store.openSession(sessionRecord())
    for (const seq of [0, 1, 2]) {
      await adapter.store.commitChunk(
        packChunk(packSamples(3, { at: SAMPLE_EPOCH + seq * 300_000 }), { seq }),
        sessionPatch({ packSamples: 9, packChunks: 3 }),
      )
    }

    await adapter.store.deleteSession(SESSION_ID)

    expect(await readAll(adapter.database, 'chunks')).toEqual([])
    expect(await readAll(adapter.database, 'sessions')).toEqual([])
  })
})

describe('the recovery sweep', () => {
  let adapter: Adapter

  afterEach(async () => {
    await adapter.dispose()
  })

  it('removes chunks whose session row is gone', async () => {
    // Only reachable by looking past the port, because nothing above it can produce an orphan. A
    // crash between the two deletes can, and an unreachable chunk holds budget forever.
    adapter = await openAdapter()
    await adapter.store.openSession(sessionRecord())
    await adapter.store.commitChunk(packChunk(packSamples(5)), sessionPatch({ packSamples: 5 }))
    await deleteRow(adapter.database, 'sessions', SESSION_ID)

    const swept = await adapter.store.recover(SAMPLE_EPOCH + 3_600_000)

    expect(swept.orphansRemoved).toBe(1)
    expect(await readAll(adapter.database, 'chunks')).toEqual([])
  })

  it('re-derives the counter from the rows that survived, so a crash cannot leave it wrong', async () => {
    adapter = await openAdapter()
    await adapter.store.openSession(sessionRecord({ id: 'session-a', heartbeatAt: SAMPLE_EPOCH }))
    await adapter.store.commitChunk(
      packChunk(packSamples(20), { sessionId: 'session-a' }),
      sessionPatch({ packSamples: 20, heartbeatAt: SAMPLE_EPOCH }),
    )
    await adapter.store.closeSession('session-a', sessionClosure({ packSamples: 20 }))
    await deleteRow(adapter.database, 'sessions', 'session-a')

    const swept = await adapter.store.recover(SAMPLE_EPOCH + 3_600_000)

    expect(swept.orphansRemoved).toBe(1)
    expect((await adapter.store.usage()).totalSamples).toBe(0)
  })

  it('announces that it closed something, and stays quiet when it did not', async () => {
    adapter = await openAdapter()
    await adapter.store.openSession(sessionRecord({ heartbeatAt: SAMPLE_EPOCH }))
    await adapter.store.commitChunk(
      packChunk(packSamples(12), { sealed: false }),
      sessionPatch({ packSamples: 12, heartbeatAt: SAMPLE_EPOCH }),
    )
    adapter.channel.forget()

    await adapter.store.recover(SAMPLE_EPOCH + 3_600_000)
    expect(adapter.channel.posted).toEqual(['session-closed'])

    adapter.channel.forget()
    await adapter.store.recover(SAMPLE_EPOCH + 7_200_000)
    expect(adapter.channel.posted).toEqual([])
  })
})

describe('what the other tabs are told', () => {
  let adapter: Adapter

  afterEach(async () => {
    await adapter.dispose()
  })

  it('says what happened, and only once the write actually committed', async () => {
    adapter = await openAdapter()

    await adapter.store.openSession(sessionRecord())
    await adapter.store.commitChunk(packChunk(packSamples(4)), sessionPatch({ packSamples: 4 }))
    await adapter.store.closeSession(SESSION_ID, sessionClosure({ packSamples: 4 }))
    await adapter.store.upsertDevice(deviceRecord())
    await adapter.store.renameDevice(PACK_DEVICE_KEY, 'Starboard bank')
    await adapter.store.deleteSession(SESSION_ID)

    expect(adapter.channel.posted).toEqual([
      'session-opened',
      'session-closed',
      'device-renamed',
      'pruned',
    ])
  })

  it('says nothing about a rename that found no device', async () => {
    adapter = await openAdapter()

    await adapter.store.renameDevice('jk:NOTHING', 'Anything')

    expect(adapter.channel.posted).toEqual([])
  })
})

describe("filing the pack's own ring", () => {
  let adapter: Adapter

  afterEach(async () => {
    await adapter.dispose()
  })

  /** Far enough past everything seeded below that no run of it could align against a stored row. */
  const STRANDED_FROM = RING_EPOCH_COUNTER_SECONDS + 30_000 * PACK_SAMPLING_PERIOD_SECONDS

  /** A read carrying eight records the ledger cannot possibly already hold. */
  function strandedRead(observedAt: number): RingSnapshot {
    return ringSnapshot({
      observedAt,
      runs: [{ firstIndex: 0, records: ringRecords(8, { counterSeconds: STRANDED_FROM }) }],
    })
  }

  it('scopes a merge to the ring stores, so it can never queue behind a recording', async () => {
    adapter = await openAdapter()
    await adapter.store.openSession(sessionRecord())
    await adapter.store.commitChunk(
      packChunk(packSamples(6)),
      sessionPatch({ packSamples: 6, packChunks: 1 }),
    )

    const scopes = await scopesOpenedDuring(adapter.database, () =>
      adapter.store.appendRingSnapshot(ringSnapshot()),
    )

    expect(scopes).toEqual([['ringRecords', 'ringReads', 'devices']])
    expect((await adapter.store.usage()).totalSamples).toBe(6)
  })

  it('tells the other tabs a ring was read, and only once the write committed', async () => {
    adapter = await openAdapter()
    await adapter.store.appendRingSnapshot(ringSnapshot())
    expect(adapter.channel.posted).toEqual(['ring-read'])

    // A journal row the platform cannot store takes the whole merge down with it, rows included:
    // a ledger that grew while its receipt was lost is a ledger nothing can account for.
    adapter.channel.forget()
    const unwritable = strandedRead(SAMPLE_EPOCH + 3_600_000)
    const refused = await adapter.store.appendRingSnapshot({
      ...unwritable,
      transport: { ...unwritable.transport, elapsedMs: (() => undefined) as never },
    })

    expect(refused.stored).toBe(false)
    expect(refused.appended).toBe(0)
    expect(adapter.channel.posted).toEqual([])
    expect(await readAll(adapter.database, 'ringRecords')).toHaveLength(8)
    expect(await readAll(adapter.database, 'ringReads')).toHaveLength(1)
  })

  it('announces a clock correction and a deleted ledger under the same word', async () => {
    // The archive is the shared state and a receiver re-reads it, so nothing finer would be read.
    adapter = await openAdapter()
    await adapter.store.upsertDevice(deviceRecord())
    await adapter.store.appendRingSnapshot(ringSnapshot())
    adapter.channel.forget()

    await adapter.store.setPackClock(PACK_DEVICE_KEY, { utcOffsetMinutes: 60, aheadSeconds: 25_268 })
    await adapter.store.deleteRingLedger(PACK_DEVICE_KEY)

    expect(adapter.channel.posted).toEqual(['ring-read', 'ring-read'])
  })

  it('drops the least recently read ledger whole once one pack too many has one', async () => {
    // The one ring budget a test can actually reach. The per-device cap is twenty thousand rows,
    // and seeding that many through this fake takes minutes — its index maintenance is quadratic
    // in the rows already under one key, which is exactly the shape of a single pack's ledger.
    adapter = await openAdapter()
    const packs = Array.from(
      { length: MAX_RING_DEVICES + 1 },
      (_unused, index): DeviceKey => `jk:DEMO0000000${String(index).padStart(4, '0')}`,
    )

    let last = { prunedRecords: 0 }
    for (const [index, deviceKey] of packs.entries()) {
      last = await adapter.store.appendRingSnapshot(
        ringSnapshot({ deviceKey, observedAt: SAMPLE_EPOCH + index * 3_600_000 }),
      )
    }

    // A ledger nobody has read in months is the fairest thing to lose, and it goes whole: rows,
    // journal and all, counted in the figures the read that evicted it reports.
    expect(last.prunedRecords).toBe(8)
    expect(await adapter.store.readRingLedger(packs[0])).toBeNull()
    expect(await adapter.store.listRingLedgers()).toHaveLength(MAX_RING_DEVICES)
    expect((await adapter.store.usage()).ringRecords).toBe(MAX_RING_DEVICES * 8)
  })

  it('sweeps journal rows whose ledger is gone', async () => {
    // A crash between two deletes cannot produce this — the rows and the journal die in one
    // transaction — but a half-written database can, and those rows are unreachable budget.
    adapter = await openAdapter()
    const orphaned: DeviceKey = 'jk:GONE000000001'
    await seedRows(adapter.database, 'ringReads', [ringReadRow({ deviceKey: orphaned })])

    const swept = await adapter.store.recover(SAMPLE_EPOCH + 3_600_000)

    expect(swept.orphansRemoved).toBe(1)
    expect(await adapter.store.readRingLedger(orphaned)).toBeNull()
  })

  it('leaves the receipt of a pack that answered nothing exactly where it is', async () => {
    // A ledger holding no record is still a ledger: a pack that stopped answering 0xA7 is what a
    // stored history of attempts is for, and the sweep runs on every single page load.
    adapter = await openAdapter()
    await adapter.store.appendRingSnapshot(
      ringSnapshot({ observedAt: SAMPLE_EPOCH, outcome: 'no-answer', runs: [] }),
    )

    const swept = await adapter.store.recover(SAMPLE_EPOCH + 3_600_000)

    expect(swept.orphansRemoved).toBe(0)
    expect((await adapter.store.readRingLedger(PACK_DEVICE_KEY))?.reads).toHaveLength(1)
  })
})

describe('another tab upgrading the schema', () => {
  let adapter: Adapter

  afterEach(async () => {
    await adapter.dispose()
  })

  it('steps aside rather than deadlocking the upgrade, and says why it went quiet', async () => {
    // Holding this connection open means the upgrade never runs and the other tab hangs with
    // nothing on screen to explain it. So this one lets go and reports the reason.
    adapter = await openAdapter()
    await adapter.store.openSession(sessionRecord())

    const upgraded = await openDatabase(adapter.name, DATABASE_VERSION + 1)

    expect(adapter.store.availability.usable).toBe(false)
    expect(adapter.store.availability.reason).toBe('version-newer')
    // Every later call answers honestly instead of throwing InvalidStateError from a dead handle.
    expect(await adapter.store.listSessions()).toEqual([])
    expect((await adapter.store.commitChunk(packChunk(packSamples(3)), sessionPatch())).stored).toBe(false)
    upgraded.close()
  })
})

/** Comfortably past the probe's own blocked wait, which the module keeps to itself. */
const PAST_THE_BLOCKED_WAIT_MS = 10_000

/**
 * Waits for the probe to start counting the blocking tab out.
 *
 * Only `setTimeout` may be faked while a blocked open is in flight: `fake-indexeddb` drives its
 * whole event dispatch through `setImmediate` and polls on it for the blocking connection to
 * close, so faking that strands the request half-open and every later use of the database with it.
 * With the clock only half fake, the countdown has to be waited for rather than assumed — it is
 * armed several dispatches after `open()` returns.
 */
async function waitForBlockedCountdown(): Promise<void> {
  for (let dispatch = 0; dispatch < 100 && vi.getTimerCount() === 0; dispatch += 1) {
    await new Promise((resume) => setImmediate(resume))
  }
}

/**
 * The archive as the build before this one left it.
 *
 * `applySchema` only ever builds every version it knows in one pass, so it cannot play an older
 * build: the stores this build's upgrade adds would already be there, and the upgrade under test
 * would abort on the constraint rather than complete. They are taken back out again here, which is
 * what makes the version this opens at genuinely the previous one.
 */
function openThePreviousVersion(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DATABASE_VERSION - 1)
    request.onupgradeneeded = () => {
      applySchema(request.result, 0)
      request.result.deleteObjectStore('ringRecords')
      request.result.deleteObjectStore('ringReads')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Opens at `version` and says which of the two things happened, so a case can assert that a version
 * bump got through rather than hanging on one that never will.
 */
function attemptUpgrade(name: string, version: number): Promise<'upgraded' | 'blocked'> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onblocked = () => resolve('blocked')
    request.onsuccess = () => {
      request.result.close()
      resolve('upgraded')
    }
    request.onerror = () => reject(request.error)
  })
}

describe('probing for an archive', () => {
  /**
   * The connection standing in for the tab that is holding the upgrade off. It is closed here
   * rather than in the case, because a failed assertion that left it open would leave the open
   * request stuck half-way and hang every case after this one instead of failing one.
   */
  let blockingTab: IDBDatabase | null = null

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    blockingTab?.close()
    blockingTab = null
    await deleteDatabase(DATABASE_NAME)
  })

  it('opens the archive and sweeps it before handing it over', async () => {
    const store = await openHistoryStore()

    expect(store.availability.usable).toBe(true)
    expect(await store.listSessions()).toEqual([])
    store.close()
  })

  it('says so rather than throwing when the browser has no IndexedDB at all', async () => {
    vi.stubGlobal('indexedDB', undefined)

    const store = await openHistoryStore()

    expect(store.availability.usable).toBe(false)
    expect(store.availability.reason).toBe('no-indexeddb')
  })

  it('leaves a newer build’s recordings completely alone', async () => {
    // Deleting a newer version's data to make an older build work is not a trade this page is
    // entitled to make on the owner's behalf.
    const newer = await openDatabase(DATABASE_NAME, DATABASE_VERSION + 1)
    newer.close()

    const store = await openHistoryStore()

    expect(store.availability.usable).toBe(false)
    expect(store.availability.reason).toBe('version-newer')
    const survivor = await openDatabase(DATABASE_NAME, DATABASE_VERSION + 1)
    expect(survivor.version).toBe(DATABASE_VERSION + 1)
    survivor.close()
  })

  it('gives up on a tab that is still holding the older version open', async () => {
    // A tab running the previous build blocks the upgrade for as long as it stays open, and no
    // event ever arrives to say so. Waiting forever leaves the owner with a page that will never
    // record and never explain itself, so the probe bounds the wait and names the cause.
    blockingTab = await openThePreviousVersion(DATABASE_NAME)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const probe = openHistoryStore()
    await waitForBlockedCountdown()
    vi.advanceTimersByTime(PAST_THE_BLOCKED_WAIT_MS)
    const store = await probe

    expect(store.availability.usable).toBe(false)
    expect(store.availability.reason).toBe('open-blocked')
    const outcome = await store.commitChunk(packChunk(packSamples(3)), sessionPatch())
    expect(outcome.stored).toBe(false)
    expect(outcome.failure).toBe('open-blocked')
  })

  it('closes the connection the abandoned open still hands back later', async () => {
    // Giving up on the blocking tab only stops this page waiting: the request cannot be cancelled,
    // so the upgrade runs anyway once that tab goes and produces a connection nobody holds. Nothing
    // gave it an `onversionchange`, so left open it is the permanent block the timeout escaped.
    blockingTab = await openThePreviousVersion(DATABASE_NAME)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const probe = openHistoryStore()
    await waitForBlockedCountdown()
    vi.advanceTimersByTime(PAST_THE_BLOCKED_WAIT_MS)
    const store = await probe
    expect(store.availability.reason).toBe('open-blocked')

    vi.useRealTimers()
    blockingTab.close()
    blockingTab = null

    // The strongest proof available that nothing is still holding the archive: the next schema bump
    // gets through instead of announcing itself as blocked, the way this one did. It queues behind
    // the abandoned upgrade, so it is only judged once that upgrade has run and been let go of.
    expect(await attemptUpgrade(DATABASE_NAME, DATABASE_VERSION + 1)).toBe('upgraded')
  })

  it('answers null for persistence when the browser will not say', async () => {
    // navigator.storage is undefined under this environment, which is exactly the case the probe
    // has to survive: an unguarded call there throws while the module is being imported.
    const store = await openHistoryStore()

    expect(store.availability.persisted).toBeNull()
    expect(store.availability.estimatedBytes).toBeNull()
    store.close()
  })
})

describe('classifying a failed write', () => {
  it('knows a full disk by name and by the legacy code older WebKit still sends', () => {
    // iOS is where the archive is most likely to hit a wall, and it is the platform still sending
    // the numeric code.
    expect(isQuotaError(new DOMException('no room', 'QuotaExceededError'))).toBe(true)
    expect(isQuotaError({ code: 22 })).toBe(true)
    expect(classifyWriteFailure(new DOMException('no room', 'QuotaExceededError'))).toBe('quota')
  })

  it('tells a bare commit-time abort apart from a full disk', () => {
    // Chromium can surface a full disk as an abort with no request error at all, so the two are
    // named separately and only one of them is worth making room for.
    expect(classifyWriteFailure(new DOMException('gone', 'AbortError'))).toBe('aborted')
  })

  it('calls everything else unknown rather than guessing', () => {
    expect(classifyWriteFailure(new Error('something else'))).toBe('unknown')
    expect(classifyWriteFailure(null)).toBe('unknown')
    expect(classifyWriteFailure('a string')).toBe('unknown')
  })
})

describe('a browser that cannot keep an archive', () => {
  it('answers every call honestly and stores nothing', async () => {
    // Honest degradation is a value rather than a branch: nothing above the port has to ask
    // whether it holds a store.
    const store = unavailableHistoryStore('no-indexeddb')

    expect(store.availability.usable).toBe(false)
    expect(store.availability.reason).toBe('no-indexeddb')

    await store.openSession(sessionRecord())
    const outcome = await store.commitChunk(packChunk(packSamples(4)), sessionPatch())

    expect(outcome.stored).toBe(false)
    expect(outcome.failure).toBe('no-indexeddb')
    expect(await store.listSessions()).toEqual([])
    expect(await store.readSession(SESSION_ID)).toBeNull()
    expect(await store.usage()).toEqual({ totalSamples: 0, sessions: 0, ringRecords: 0 })
    expect(await store.recover(SAMPLE_EPOCH)).toEqual({ closed: 0, orphansRemoved: 0 })
    expect(await store.readRingLedger(PACK_DEVICE_KEY)).toBeNull()
    expect((await store.appendRingSnapshot(ringSnapshot())).failure).toBe('no-indexeddb')

    const visited: HistoryChunk[] = []
    await store.streamChunks(SESSION_ID, PACK_STREAM, { from: 0, to: 1 }, (chunk) => visited.push(chunk))
    expect(visited).toEqual([])

    store.watch(() => undefined)()
    store.close()
  })
})
