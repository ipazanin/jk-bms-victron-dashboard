import { MAX_SESSIONS, COMPACT_RETENTION_MS } from '../src/domain/history/budget'
import 'fake-indexeddb/auto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SessionHourAccumulator } from '../src/domain/history/SessionHourAccumulator'
import type { SessionHour } from '../src/domain/history/SessionHour'
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

let databaseCount = 0

interface RecordedChannel extends ArchiveChannel {
  readonly posted: readonly ArchiveMessage[]

  forget(): void
}

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

async function openAdapter(rawCapacityBytes?: () => number): Promise<Adapter> {
  databaseCount += 1
  const name = `shunt.log.spec.${databaseCount}`
  const database = await openDatabase(name)
  const channel = recordingChannel()
  const store = new IdbHistoryStore(database, USABLE, channel, rawCapacityBytes)
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

function seedRows(database: IDBDatabase, storeName: string, rows: readonly unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName], 'readwrite')
    const store = transaction.objectStore(storeName)
    for (const row of rows) store.put(row)
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
}

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
      'sessionHours',
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
    expect([...transaction.objectStore('sessionHours').indexNames]).toEqual(['bySession', 'byTime'])
    expect(transaction.objectStore('sessionHours').keyPath).toEqual(['sessionId', 'hourStart'])
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
    adapter = await openAdapter()
    const transaction = adapter.database.transaction(['ringRecords', 'ringReads'], 'readonly')

    expect(transaction.objectStore('ringRecords').keyPath).toEqual(['deviceKey', 'seq'])
    expect(transaction.objectStore('ringReads').keyPath).toEqual(['deviceKey', 'observedAt'])
  })
})

describe('upgrading an archive in place', () => {
  it('adds the ring stores to one already holding a session, a chunk and a warning', async () => {
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

  const STRANDED_FROM = RING_EPOCH_COUNTER_SECONDS + 30_000 * PACK_SAMPLING_PERIOD_SECONDS

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
    adapter = await openAdapter()
    await adapter.store.upsertDevice(deviceRecord())
    await adapter.store.appendRingSnapshot(ringSnapshot())
    adapter.channel.forget()

    await adapter.store.setPackClock(PACK_DEVICE_KEY, { utcOffsetMinutes: 60, aheadSeconds: 25_268 })
    await adapter.store.deleteRingLedger(PACK_DEVICE_KEY)

    expect(adapter.channel.posted).toEqual(['ring-read', 'ring-read'])
  })

  it('drops the least recently read ledger whole once one pack too many has one', async () => {
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

    expect(last.prunedRecords).toBe(8)
    expect(await adapter.store.readRingLedger(packs[0])).toBeNull()
    expect(await adapter.store.listRingLedgers()).toHaveLength(MAX_RING_DEVICES)
    expect((await adapter.store.usage()).ringRecords).toBe(MAX_RING_DEVICES * 8)
  })

  it('sweeps journal rows whose ledger is gone', async () => {
    adapter = await openAdapter()
    const orphaned: DeviceKey = 'jk:GONE000000001'
    await seedRows(adapter.database, 'ringReads', [ringReadRow({ deviceKey: orphaned })])

    const swept = await adapter.store.recover(SAMPLE_EPOCH + 3_600_000)

    expect(swept.orphansRemoved).toBe(1)
    expect(await adapter.store.readRingLedger(orphaned)).toBeNull()
  })

  it('leaves the receipt of a pack that answered nothing exactly where it is', async () => {
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
    adapter = await openAdapter()
    await adapter.store.openSession(sessionRecord())

    const upgraded = await openDatabase(adapter.name, DATABASE_VERSION + 1)

    expect(adapter.store.availability.usable).toBe(false)
    expect(adapter.store.availability.reason).toBe('version-newer')

    expect(await adapter.store.listSessions()).toEqual([])
    expect((await adapter.store.commitChunk(packChunk(packSamples(3)), sessionPatch())).stored).toBe(false)
    upgraded.close()
  })
})

const PAST_THE_BLOCKED_WAIT_MS = 10_000

async function waitForBlockedCountdown(): Promise<void> {
  for (let dispatch = 0; dispatch < 100 && vi.getTimerCount() === 0; dispatch += 1) {
    await new Promise((resume) => setImmediate(resume))
  }
}

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

    expect(await attemptUpgrade(DATABASE_NAME, DATABASE_VERSION + 1)).toBe('upgraded')
  })

  it('answers null for persistence when the browser will not say', async () => {
    const store = await openHistoryStore()

    expect(store.availability.persisted).toBeNull()
    expect(store.availability.estimatedBytes).toBeNull()
    store.close()
  })

  it('opens and writes the archive while storage protection is waiting for permission', async () => {
    let answerPermission!: (persisted: boolean) => void
    const permission = new Promise<boolean>((resolve) => { answerPermission = resolve })
    const persist = vi.fn(() => permission)
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist } })

    const store = await openHistoryStore()
    const changed = vi.fn()
    const stopWatching = store.watch(changed)
    try {
      expect(persist).toHaveBeenCalledOnce()
      expect(store.availability).toMatchObject({ usable: true, persisted: false })
      await store.openSession(sessionRecord())
      expect((await store.listSessions()).map((session) => session.record.id)).toContain(SESSION_ID)

      answerPermission(true)
      await vi.waitFor(() => expect(store.availability.persisted).toBe(true))
      expect(store.availability.usable).toBe(true)
      expect(changed).toHaveBeenCalledOnce()
    } finally {
      stopWatching()
      store.close()
    }
  })

  it('keeps an already protected archive usable without another permission request', async () => {
    const persist = vi.fn()
    vi.stubGlobal('navigator', { storage: { persisted: async () => true, persist } })
    const store = await openHistoryStore()
    try {
      expect(store.availability).toMatchObject({ usable: true, persisted: true })
      expect(persist).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it.each(['denied', 'rejected'] as const)('keeps the archive usable when protection is %s', async (decision) => {
    const persist = vi.fn(async () => {
      if (decision === 'rejected') throw new DOMException('Unavailable', 'NotAllowedError')
      return false
    })
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist } })
    const store = await openHistoryStore()
    try {
      await vi.waitFor(() => expect(persist.mock.settledResults[0]?.type).toBe(decision === 'denied' ? 'fulfilled' : 'rejected'))
      expect(store.availability).toMatchObject({ usable: true, persisted: false })
      await store.openSession(sessionRecord())
      expect((await store.listSessions()).map((session) => session.record.id)).toContain(SESSION_ID)
    } finally {
      store.close()
    }
  })

  it.each(['closed', 'upgraded'] as const)('ignores a permission answer after the archive was %s', async (closure) => {
    let answerPermission!: (persisted: boolean) => void
    const permission = new Promise<boolean>((resolve) => { answerPermission = resolve })
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist: () => permission } })
    const store = await openHistoryStore()
    const changed = vi.fn()
    const stopWatching = store.watch(changed)
    try {
      if (closure === 'closed') store.close()
      else {
        const upgraded = await openDatabase(DATABASE_NAME, DATABASE_VERSION + 1)
        upgraded.close()
      }
      const availabilityBeforeAnswer = store.availability
      changed.mockClear()
      answerPermission(true)
      await permission
      await Promise.resolve()
      await Promise.resolve()
      expect(store.availability).toEqual(availabilityBeforeAnswer)
      expect(changed).not.toHaveBeenCalled()
      if (closure === 'upgraded') expect(store.availability.reason).toBe('version-newer')
    } finally {
      stopWatching()
      store.close()
    }
  })
})

describe('classifying a failed write', () => {
  it('knows a full disk by name and by the legacy code older WebKit still sends', () => {
    expect(isQuotaError(new DOMException('no room', 'QuotaExceededError'))).toBe(true)
    expect(isQuotaError({ code: 22 })).toBe(true)
    expect(classifyWriteFailure(new DOMException('no room', 'QuotaExceededError'))).toBe('quota')
  })

  it('tells a bare commit-time abort apart from a full disk', () => {
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

describe('compact history and raw retention', () => {
  let adapter: Adapter

  afterEach(async () => {
    vi.restoreAllMocks()
    await adapter.dispose()
  })

  it('backfills before raw eviction while preserving session totals and warnings', async () => {
    adapter = await openAdapter(() => 400)
    await adapter.store.openSession(sessionRecord())
    await adapter.store.appendWarning(warningRecord())
    const ledger = { ...sessionRecord().ledger, packAhWholeSession: 123 }
    await adapter.store.commitChunk(packChunk(packSamples(10)), sessionPatch({ ledger }))
    await adapter.store.commitChunk(packChunk(packSamples(10, { at: SAMPLE_EPOCH + 10_000 }), { seq: 1 }), sessionPatch({ ledger, packSamples: 20, heartbeatAt: SAMPLE_EPOCH + 20_000 }))

    const stored = await adapter.store.readSession(SESSION_ID)
    expect(stored?.record.ledger).toEqual(ledger)
    expect(stored?.pack.map((chunk) => chunk.seq)).toEqual([1])
    expect(stored?.hours?.[0]?.basis).toBe('reconstructed')
    expect(stored?.hours?.[0]?.packSamples).toBe(20)
    expect(await adapter.store.warningsOf(SESSION_ID)).toHaveLength(1)
    expect((await adapter.store.usage()).rawBytes).toBe(280)
  })

  it('does not restore discarded coverage when a later writer patch repeats the full session account', async () => {
    adapter = await openAdapter(() => 400)
    await adapter.store.openSession(sessionRecord())
    const coverage = [{ from: SAMPLE_EPOCH, to: SAMPLE_EPOCH + 19_000, kind: 'pack-only' as const }]
    await adapter.store.commitChunk(packChunk(packSamples(10)), sessionPatch({ coverage }))
    const tail = packChunk(packSamples(10, { at: SAMPLE_EPOCH + 10_000 }), { seq: 1 })
    const patch = sessionPatch({ coverage, packSamples: 20, heartbeatAt: SAMPLE_EPOCH + 20_000 })
    await adapter.store.commitChunk(tail, patch)
    await adapter.store.commitChunk(tail, patch)
    await adapter.store.closeSession(SESSION_ID, sessionClosure({ ...patch, endedAt: SAMPLE_EPOCH + 20_000 }))
    expect((await adapter.store.readSession(SESSION_ID))?.record.coverage).toEqual([
      { from: SAMPLE_EPOCH + 10_000, to: SAMPLE_EPOCH + 19_000, kind: 'pack-only' },
    ])
  })

  it('counts rewritten tails once and stores matching hourly snapshots atomically', async () => {
    adapter = await openAdapter()
    await adapter.store.openSession(sessionRecord())
    const accumulator = new SessionHourAccumulator(SESSION_ID, 'recorded')
    const samples = packSamples(10)
    for (const sample of samples) accumulator.push({ at: sample.at, pack: sample, solar: null })
    const hours = accumulator.updatedHours()
    const tail = packChunk(samples, { sealed: false })
    await adapter.store.commitChunk(tail, sessionPatch(), hours)
    await adapter.store.commitChunk(tail, sessionPatch(), hours)
    expect((await adapter.store.usage()).rawBytes).toBe(280)
    expect((await adapter.store.readSession(SESSION_ID))?.hours?.[0]?.packSamples).toBe(10)
    expect((await adapter.store.readSession(SESSION_ID))?.record.hourlyBasis).toBe('recorded')
  })

  it('aborts both raw and hourly changes when the hourly store refuses a write', async () => {
    adapter = await openAdapter(() => 100)
    await adapter.store.openSession(sessionRecord())
    const accumulator = new SessionHourAccumulator(SESSION_ID, 'recorded')
    for (const sample of packSamples(10)) accumulator.push({ at: sample.at, pack: sample, solar: null })
    const realPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...arguments_: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'sessionHours') throw new DOMException('refused', 'AbortError')
      return realPut.apply(this, arguments_)
    })
    const outcome = await adapter.store.commitChunk(packChunk(packSamples(10)), sessionPatch(), accumulator.updatedHours())
    expect(outcome.stored).toBe(false)
    expect(await readAll(adapter.database, 'chunks')).toEqual([])
    expect(await readAll(adapter.database, 'sessionHours')).toEqual([])
    expect((await adapter.store.usage()).rawBytes).toBe(0)
  })

  it('never replaces recorded hourly accounting during legacy backfill', async () => {
    adapter = await openAdapter()
    await adapter.store.openSession(sessionRecord())
    const accumulator = new SessionHourAccumulator(SESSION_ID, 'recorded')
    for (const sample of packSamples(10)) accumulator.push({ at: sample.at, pack: sample, solar: null })
    const hours = accumulator.updatedHours()
    await adapter.store.commitChunk(packChunk(packSamples(10)), sessionPatch(), hours)
    await adapter.store.compactSession(SESSION_ID)
    expect(await readAll<SessionHour>(adapter.database, 'sessionHours')).toEqual(hours)
  })

  it('reconstructs new raw observations in an open legacy hour without doubling old observations', async () => {
    adapter = await openAdapter()
    await adapter.store.openSession(sessionRecord())
    await adapter.store.commitChunk(packChunk(packSamples(5), { sealed: false }), sessionPatch())
    await adapter.store.compactSession(SESSION_ID)
    await adapter.store.commitChunk(packChunk(packSamples(10), { sealed: false }), sessionPatch())
    await adapter.store.compactSession(SESSION_ID)
    expect((await adapter.store.readSession(SESSION_ID))?.hours?.[0]?.packSamples).toBe(10)
  })

  it('recovers legacy raw byte totals and seals tails without discarding compact history', async () => {
    adapter = await openAdapter()
    await seedRows(adapter.database, 'sessions', [sessionRecord({ heartbeatAt: SAMPLE_EPOCH })])
    await seedRows(adapter.database, 'chunks', [packChunk(packSamples(10), { sealed: false })])
    await adapter.store.compactSession(SESSION_ID)
    await adapter.store.recover(SAMPLE_EPOCH + 3_600_000)
    expect((await adapter.store.usage()).rawBytes).toBe(280)
    expect((await adapter.store.usage()).totalSamples).toBe(10)
    expect((await adapter.store.readSession(SESSION_ID))?.hours).toHaveLength(1)
  })

  it('keeps expired hours while raw depends on them and removes both after raw pruning', async () => {
    let capacity = 1_000
    adapter = await openAdapter(() => capacity)
    await adapter.store.openSession(sessionRecord())
    const accumulator = new SessionHourAccumulator(SESSION_ID, 'recorded')
    for (const sample of packSamples(10)) accumulator.push({ at: sample.at, pack: sample, solar: null })
    await adapter.store.commitChunk(packChunk(packSamples(10)), sessionPatch({ packSamples: 10 }), accumulator.updatedHours())
    const later = SAMPLE_EPOCH + COMPACT_RETENTION_MS + 3_600_000
    await adapter.store.recover(later)
    expect(await readAll(adapter.database, 'sessionHours')).toHaveLength(1)
    expect(await readAll(adapter.database, 'chunks')).toHaveLength(1)

    capacity = 100
    await adapter.store.recover(later + 1)
    expect(await readAll(adapter.database, 'sessionHours')).toHaveLength(0)
    expect(await readAll(adapter.database, 'chunks')).toHaveLength(0)
    expect((await adapter.store.usage()).rawBytes).toBe(0)
    expect(await adapter.store.readSession(SESSION_ID)).not.toBeNull()
  })

  it('bounds metadata even when thousands of tiny closed sessions still retain raw samples', async () => {
    adapter = await openAdapter()
    const sessions = Array.from({ length: MAX_SESSIONS + 1 }, (_, index) => sessionRecord({
      id: `tiny-${index}`, startedAt: SAMPLE_EPOCH + index,
      state: 'closed', endReason: 'user-disconnect', endedAt: SAMPLE_EPOCH + index + 1,
      heartbeatAt: SAMPLE_EPOCH, packSamples: 1, packChunks: 1, sealedSamples: 1,
    }))
    await seedRows(adapter.database, 'sessions', sessions)
    await seedRows(adapter.database, 'chunks', sessions.map((session) => packChunk(packSamples(1), { sessionId: session.id })))
    await adapter.store.recover(SAMPLE_EPOCH + 3_600_000)
    expect(await adapter.store.readSession('tiny-0')).toBeNull()
    expect((await adapter.store.usage()).sessions).toBe(MAX_SESSIONS)
    expect((await adapter.store.usage()).rawBytes).toBe(MAX_SESSIONS * 28)
    expect((await adapter.store.usage()).totalSamples).toBe(MAX_SESSIONS)
  })

  it('serializes byte accounting across two connections', async () => {
    adapter = await openAdapter()
    const secondDatabase = await openDatabase(adapter.name)
    const second = new IdbHistoryStore(secondDatabase, USABLE, recordingChannel())
    try {
      await adapter.store.openSession(sessionRecord())
      await second.openSession(sessionRecord({ id: 'second' }))
      await Promise.all([
        adapter.store.commitChunk(packChunk(packSamples(10)), sessionPatch()),
        second.commitChunk(packChunk(packSamples(10), { sessionId: 'second' }), sessionPatch()),
      ])
      expect((await adapter.store.usage()).rawBytes).toBe(560)
    } finally {
      second.close()
    }
  })
})
