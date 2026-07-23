import 'fake-indexeddb/auto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { unavailableHistoryStore } from '../src/application/history/port'
import type { HistoryAvailability } from '../src/application/history/port'
import { PACK_STREAM } from '../src/domain/history/types'
import type { HistoryChunk, SessionRecord } from '../src/domain/history/types'
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
  SAMPLE_EPOCH,
  SESSION_ID,
  deviceRecord,
  packChunk,
  packSamples,
  sessionClosure,
  sessionPatch,
  sessionRecord,
} from './support/samples'
import { describeHistoryStore } from './support/describeHistoryStore'

/**
 * The only file that imports `fake-indexeddb`, and the only place real IndexedDB semantics are
 * exercised — compound keys, index cursors, transaction scope and commit ordering are exactly the
 * things a hand-rolled fake would get wrong in the same direction as the code under test.
 *
 * Two limitations are worth stating rather than working around. `fake-indexeddb` emulates no
 * quota, so a full disk cannot be reproduced here: the adapter's retry decision is extracted as
 * `classifyWriteFailure` and tested as the pure branch it is, and the recorder's behaviour on a
 * refused write is driven through the port instead. And `onblocked` needs an upgrade to block; at
 * DATABASE_VERSION 1 there is no earlier version for another connection to hold open, so the
 * blocked path has no trigger until a second version exists.
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

describe('probing for an archive', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
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
    expect(await store.usage()).toEqual({ totalSamples: 0, sessions: 0 })
    expect(await store.recover(SAMPLE_EPOCH)).toEqual({ closed: 0, orphansRemoved: 0 })

    const visited: HistoryChunk[] = []
    await store.streamChunks(SESSION_ID, PACK_STREAM, { from: 0, to: 1 }, (chunk) => visited.push(chunk))
    expect(visited).toEqual([])

    store.watch(() => undefined)()
    store.close()
  })
})
