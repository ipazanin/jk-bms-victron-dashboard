import 'fake-indexeddb/auto'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArchiveRepository } from '../src/application/backup/ArchiveRepository'
import type { HistoryStore } from '../src/application/history/port'
import type { ArchiveSnapshot } from '../src/domain/backup/ArchiveSnapshot'
import { openArchiveRepository } from '../src/infrastructure/backup/openArchiveRepository'
import { openArchiveDatabase } from '../src/infrastructure/backup/openArchiveDatabase'
import { DATABASE_VERSION, IdbHistoryStore, applySchema } from '../src/infrastructure/history/IdbHistoryStore'
import { deviceRecord, packChunk, packSamples, ringSnapshot, sessionClosure, sessionPatch, sessionRecord, solarSamples, warningRecord } from './support/samples'
import { groupKeyFor } from '../src/domain/history/identity'
import { decodeCellInfo } from '../src/domain/bms/decode'
import { hexToBytes } from '../src/domain/bytes'
import { recomputeLedger } from '../src/domain/history/ledger'
import { MAX_PAIRING_AGE_MS } from '../src/domain/history/join'
import fixtures from './fixtures.json'

let databaseSequence = 0
const repositories: ArchiveRepository[] = []
const stores: HistoryStore[] = []
const names: string[] = []

async function openRepository(label = 'Boat browser'): Promise<{ repository: ArchiveRepository; store: HistoryStore; name: string }> {
  const name = `archive-repository-spec-${++databaseSequence}`
  names.push(name, `${name}.archive-directory`)
  const repository = await openArchiveRepository(name, label)
  repositories.push(repository)
  const database = await openArchiveDatabase(name, DATABASE_VERSION, applySchema)
  const store = new IdbHistoryStore(database, {
    usable: true, reason: null, persisted: null, estimatedBytes: null, quotaBytes: null,
  }, { post: () => undefined, subscribe: () => () => undefined, close: () => undefined })
  stores.push(store)
  return { repository, store, name }
}

async function populate(store: HistoryStore): Promise<void> {
  await store.upsertDevice(deviceRecord())
  await store.openSession(sessionRecord())
  await store.commitChunk(packChunk(packSamples(3), { sealed: false }), sessionPatch({ packSamples: 3, packChunks: 1 }))
  await store.appendWarning(warningRecord())
  await store.appendRingSnapshot(ringSnapshot())
}

async function importSnapshot(repository: ArchiveRepository, name: string, snapshot: ArchiveSnapshot): Promise<void> {
  names.push(`${name}.imported.${encodeURIComponent(snapshot.source.id)}`)
  await repository.importArchive(snapshot)
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  for (const repository of repositories.splice(0)) repository.close()
  for (const name of new Set(names.splice(0))) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error(`Database still open: ${name}`))
    })
  }
})

describe('archive repository', () => {
  it('keeps source identity across reopen and isolates separate local archives', async () => {
    const first = await openRepository('Boat')
    const second = await openRepository('Demo')
    const reopened = await openArchiveRepository(first.name, 'Different initial label')
    repositories.push(reopened)
    expect(reopened.source).toEqual(first.repository.source)
    expect(second.repository.source.id).not.toBe(first.repository.source.id)
  })

  it('backfills summaries and captures every store in one transaction including unsealed active checkpoints', async () => {
    const { repository, store } = await openRepository()
    await populate(store)
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction')
    const snapshot = await repository.capture([{ key: 'shunt.theme', value: 'dark' }])
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(transaction.mock.calls[0][0]).toEqual(['sessions', 'chunks', 'devices', 'meta', 'warnings', 'ringRecords', 'ringReads', 'sessionHours'])
    expect(transaction.mock.calls[0][1]).toBe('readwrite')
    expect(snapshot.version).toBe(2)
    expect(snapshot.stores.hours).toHaveLength(1)
    expect(snapshot.stores.hours![0]!.basis).toBe('reconstructed')
    expect(snapshot.stores.sessions[0].state).toBe('open')
    expect(snapshot.stores.chunks[0].sealed).toBe(false)
    expect(snapshot.stores.chunks[0].offsetMs).toBeInstanceOf(Uint32Array)
    expect(snapshot.stores.chunks[0].length).toBe(3)
    expect(snapshot.stores.warnings).toHaveLength(1)
    expect(snapshot.stores.ringRecords.length).toBeGreaterThan(0)
    expect(snapshot.stores.ringReads).toHaveLength(1)
  })

  it('captures a recording before the radios provide a device identity', async () => {
    const { repository, store } = await openRepository()
    const session = sessionRecord({ packDeviceKey: null, solarDeviceKey: null, groupKey: groupKeyFor(null, null) })
    await store.openSession(session)
    expect((await repository.capture([])).stores.sessions).toEqual([session])
  })

  it('captures hourly history without reading raw chunks after backfill', async () => {
    const { repository, store } = await openRepository()
    await populate(store)
    await store.closeSession(sessionRecord().id, sessionClosure({ packSamples: 3, packChunks: 1 }))
    const complete = await repository.capture([])
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll')
    const compact = await repository.capture([], 'hourly')
    expect(getAll.mock.contexts.some((context) => context instanceof IDBObjectStore && context.name === 'chunks')).toBe(false)
    expect(compact.stores.chunks).toEqual([])
    expect(compact.stores.hours).toEqual(complete.stores.hours)
    expect(compact.stores.warnings).toEqual(complete.stores.warnings)
    expect(compact.stores.ringRecords).toEqual(complete.stores.ringRecords)
    expect(compact.stores.sessions[0]!.ledger).toEqual(complete.stores.sessions[0]!.ledger)
    expect(compact.stores.meta[0]!.rawBytes).toBe(0)
    expect((await repository.capture([])).stores).toEqual(complete.stores)
  })

  it('captures a session between opening it and writing its device metadata', async () => {
    const { repository, store } = await openRepository()
    const session = sessionRecord()
    await store.openSession(session)
    const beforeDevice = await repository.capture([])
    expect(beforeDevice.stores.sessions).toEqual([session])
    expect(beforeDevice.stores.devices).toEqual([])
    await store.upsertDevice(deviceRecord())
    expect((await repository.capture([])).stores.devices).toEqual([deviceRecord()])
  })

  it('captures a stored ring ledger before device metadata is available', async () => {
    const { repository, store } = await openRepository()
    const ring = ringSnapshot()
    await store.appendRingSnapshot(ring)
    expect((await store.readRingLedger(ring.deviceKey))!.device).toBeNull()
    const snapshot = await repository.capture([])
    expect(snapshot.stores.devices).toEqual([])
    expect(snapshot.stores.ringRecords.length).toBeGreaterThan(0)
    expect(snapshot.stores.ringReads).toHaveLength(1)
  })

  it('captures the supported empty-cell snapshot returned by the BMS decoder', async () => {
    const { repository, store } = await openRepository()
    const frame = hexToBytes(fixtures.bmsCellInfoHex)
    frame.fill(0, 70, 74)
    const finalBattery = decodeCellInfo(frame)
    expect(finalBattery.cellVoltages).toEqual([])
    await store.upsertDevice(deviceRecord())
    await store.openSession(sessionRecord({ finalBattery }))
    expect((await repository.capture([])).stores.sessions[0]!.finalBattery).toEqual(finalBattery)
  })

  it('captures a ledger derived from signed solar battery current', async () => {
    const { repository, store } = await openRepository()
    const ledger = recomputeLedger(packSamples(2, { currentA: -2 }), solarSamples(2, { batteryCurrentA: -1 }), MAX_PAIRING_AGE_MS)
    expect(ledger.solarAh).toBeLessThan(0)
    await store.upsertDevice(deviceRecord())
    await store.openSession(sessionRecord({ ledger }))
    expect((await repository.capture([])).stores.sessions[0]!.ledger).toEqual(ledger)
  })

  it('captures signed energy when current crosses zero while battery voltage changes', async () => {
    const { repository, store } = await openRepository()
    const pack = packSamples(2, { currentA: 0 }).map((sample, index) => ({ ...sample, packVoltageV: index === 0 ? 12 : 14 }))
    const solar = solarSamples(2).map((sample, index) => ({ ...sample, batteryCurrentA: index === 0 ? 1 : -0.9 }))
    const ledger = recomputeLedger(pack, solar, MAX_PAIRING_AGE_MS)
    expect(ledger.houseWh).toBeLessThan(0)
    await store.upsertDevice(deviceRecord())
    await store.openSession(sessionRecord({ ledger }))
    expect((await repository.capture([])).stores.sessions[0]!.ledger).toEqual(ledger)
  })

  it('keeps the source directory readable after an unencodable imported source identity', async () => {
    const { repository } = await openRepository()
    const snapshot = await repository.capture([])
    const malformed = { ...snapshot, source: { id: '\ud800', label: 'Malformed identity' } }
    await expect(repository.importArchive(malformed)).rejects.toThrow()
    expect(await repository.listImported()).toEqual([])
  })

  it('accepts well-formed Unicode source identities while rejecting excessive identity lengths', async () => {
    const { repository, name } = await openRepository()
    const snapshot = await repository.capture([])
    const imported = { ...snapshot, source: { id: 'harbor-⚓-𐍈', label: 'Harbor' } }
    await importSnapshot(repository, name, imported)
    expect((await repository.listImported())[0]!.source).toEqual(imported.source)
    await expect(repository.importArchive({ ...snapshot, source: { id: 'a'.repeat(1025), label: 'Too long' } })).rejects.toThrow(/1024/)
    expect(await repository.listImported()).toHaveLength(1)
  })

  it('imports overlapping hardware and session identities without touching active local recordings', async () => {
    const from = await openRepository('Boat')
    const to = await openRepository('Laptop')
    await populate(from.store)
    await populate(to.store)
    const localBefore = await to.repository.capture([])
    const snapshot = await from.repository.capture([])
    await importSnapshot(to.repository, to.name, snapshot)
    const imported = await to.repository.openImported(snapshot.source.id)
    stores.push(imported)
    expect((await imported.listSessions())[0].record.state).toBe('open')
    expect((await imported.readSession(snapshot.stores.sessions[0].id))?.pack[0].sealed).toBe(false)
    expect(await to.repository.readImported(snapshot.source.id)).toEqual(snapshot)
    expect((await to.repository.capture([])).stores).toEqual(localBefore.stores)
    await expect(imported.deleteSession(snapshot.stores.sessions[0].id)).rejects.toThrow('read-only')
    await expect(imported.recover(Date.now())).rejects.toThrow('read-only')
    expect((await to.repository.readImported(snapshot.source.id)).stores).toEqual(snapshot.stores)
  })

  it('keeps same-source snapshots in a separate read-only archive', async () => {
    const { repository, store, name } = await openRepository()
    await populate(store)
    const snapshot = await repository.capture([])
    await importSnapshot(repository, name, snapshot)
    expect(await repository.readImported(repository.source.id)).toEqual(snapshot)
    expect((await repository.capture([])).stores).toEqual(snapshot.stores)
    expect(await repository.listImported()).toHaveLength(1)
  })

  it('replaces one source idempotently without combining records or changing source sequence numbers', async () => {
    const from = await openRepository()
    const to = await openRepository()
    await populate(from.store)
    const snapshot = await from.repository.capture([])
    await importSnapshot(to.repository, to.name, snapshot)
    await to.repository.importArchive(snapshot)
    expect(await to.repository.listImported()).toHaveLength(1)
    expect(await to.repository.readImported(snapshot.source.id)).toEqual(snapshot)
    const changed = { ...snapshot, source: { ...snapshot.source, label: 'Renamed source' }, stores: { ...snapshot.stores, warnings: [] } }
    await to.repository.importArchive(changed)
    expect(await to.repository.readImported(snapshot.source.id)).toEqual(changed)
    expect((await to.repository.listImported())[0].source.label).toBe('Renamed source')
  })

  it('rolls back all stores and source metadata when a replacement write fails', async () => {
    const from = await openRepository()
    const to = await openRepository()
    await populate(from.store)
    const snapshot = await from.repository.capture([])
    await importSnapshot(to.repository, to.name, snapshot)
    const before = await to.repository.listImported()
    const add = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, row, key) {
      if (this.name === 'ringReads') throw new DOMException('Disk full', 'QuotaExceededError')
      return add.call(this, row, key)
    })
    const changed = { ...snapshot, source: { ...snapshot.source, label: 'Failed replacement' }, stores: { ...snapshot.stores, warnings: [] } }
    await expect(to.repository.importArchive(changed)).rejects.toThrow('Disk full')
    expect(await to.repository.readImported(snapshot.source.id)).toEqual(snapshot)
    expect(await to.repository.listImported()).toEqual(before)
  })

  it('hides a failed first import from the source directory', async () => {
    const from = await openRepository()
    const to = await openRepository()
    await populate(from.store)
    const snapshot = await from.repository.capture([])
    names.push(`${to.name}.imported.${encodeURIComponent(snapshot.source.id)}`)
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => {
      throw new DOMException('Disk full', 'QuotaExceededError')
    })
    await expect(to.repository.importArchive(snapshot)).rejects.toThrow('Disk full')
    expect(await to.repository.listImported()).toEqual([])
  })

  it('refuses malformed imports before changing an existing source', async () => {
    const from = await openRepository()
    const to = await openRepository()
    await populate(from.store)
    const snapshot = await from.repository.capture([])
    await importSnapshot(to.repository, to.name, snapshot)
    await expect(to.repository.importArchive({ ...snapshot, version: 99 } as unknown as ArchiveSnapshot)).rejects.toThrow()
    expect(await to.repository.readImported(snapshot.source.id)).toEqual(snapshot)
  })

  it('rejects local replacement during recording and rejects open sessions in the saved snapshot', async () => {
    const { repository, store } = await openRepository()
    const empty = await repository.capture([])
    await populate(store)
    const active = await repository.capture([])
    await expect(repository.restoreLocal(empty, 'replace')).rejects.toThrow('Stop all active recordings')
    await expect(repository.restoreLocal(active, 'replace')).rejects.toThrow('contains active recordings')
    expect((await repository.capture([])).stores).toEqual(active.stores)
  })

  it('restores closed local snapshots only with explicit confirmation and the same source', async () => {
    const { repository, store } = await openRepository()
    const empty = await repository.capture([])
    await populate(store)
    await store.closeSession(sessionRecord().id, sessionClosure({ packSamples: 3, packChunks: 1 }))
    const closed = await repository.capture([])
    await expect(repository.restoreLocal(empty, undefined as unknown as 'replace')).rejects.toThrow('Confirm replacement')
    await expect(repository.restoreLocal({ ...empty, source: { id: crypto.randomUUID(), label: 'Other' } }, 'replace')).rejects.toThrow('foreign archive')
    await repository.restoreLocal(empty, 'replace')
    expect((await repository.capture([])).stores.sessions).toEqual([])
    await repository.restoreLocal(closed, 'replace')
    expect((await repository.capture([])).stores).toEqual(closed.stores)
  })
})
