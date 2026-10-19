import type { ArchiveRepository } from '../../application/backup/ArchiveRepository'
import type { ImportedArchive } from '../../application/backup/ImportedArchive'
import type { HistoryStore } from '../../application/history/port'
import type { ArchivePreference } from '../../domain/backup/ArchivePreference'
import type { ArchiveSnapshot } from '../../domain/backup/ArchiveSnapshot'
import type { ArchiveSource } from '../../domain/backup/ArchiveSource'
import type { ArchiveStores } from '../../domain/backup/ArchiveStores'
import { validateArchiveSnapshot } from '../../domain/backup/archiveCodec'
import { hourlyArchiveStores } from '../../domain/backup/hourlyArchiveStores'
import type { SessionRecord } from '../../domain/history/types'
import { openArchiveChannel } from '../history/archiveChannel'
import { DATABASE_VERSION, IdbHistoryStore, applySchema } from '../history/IdbHistoryStore'
import { compactSessionInTransaction } from '../history/compactSession'
import { requestAsPromise, runTransaction } from '../history/idb'
import type { ImportedArchiveDescriptor } from './ImportedArchiveDescriptor'
import { openArchiveDatabase } from './openArchiveDatabase'
import { readOnlyHistoryStore } from './readOnlyHistoryStore'

const HISTORY_STORES = ['sessions', 'chunks', 'devices', 'meta', 'warnings', 'ringRecords', 'ringReads', 'sessionHours'] as const
const DESCRIPTOR = 'archiveDescriptor'

export class IdbArchiveRepository implements ArchiveRepository {
  private readonly history: IDBDatabase
  private readonly directory: IDBDatabase
  readonly source: ArchiveSource

  constructor(history: IDBDatabase, directory: IDBDatabase, source: ArchiveSource) {
    this.history = history
    this.directory = directory
    this.source = source
  }

  async capture(preferences: readonly ArchivePreference[], detail: 'complete' | 'hourly' = 'complete'): Promise<ArchiveSnapshot> {
    const exportedAt = Date.now()
    const snapshot: ArchiveSnapshot = {
      format: 'shunt-archive',
      version: 2,
      source: this.source,
      exportedAt,
      stores: await runTransaction(this.history, HISTORY_STORES, 'readwrite', async (transaction) => {
        const sessions = await requestAsPromise<SessionRecord[]>(transaction.objectStore('sessions').getAll())
        for (const session of sessions) await compactSessionInTransaction(transaction, session.id)
        const stores = await readStores(transaction, detail)
        return detail === 'hourly' ? hourlyArchiveStores(stores, exportedAt) : stores
      }),
      preferences: structuredClone(preferences),
    }
    validateArchiveSnapshot(snapshot)
    return snapshot
  }

  async listImported(): Promise<readonly ImportedArchive[]> {
    const sources = await runTransaction(this.directory, ['sources'], 'readonly', (transaction) => {
      return requestAsPromise<{ readonly id: string }[]>(transaction.objectStore('sources').getAll())
    })
    const archives: ImportedArchive[] = []
    for (const source of sources) {
      const database = await this.openSource(source.id)
      try {
        const descriptor = await runTransaction(database, [DESCRIPTOR], 'readonly', readDescriptor)
        if (descriptor !== undefined) {
          archives.push({ source: descriptor.source, exportedAt: descriptor.exportedAt, importedAt: descriptor.importedAt, preferences: descriptor.preferences })
        }
      } finally {
        database.close()
      }
    }
    return archives.sort((left, right) => right.importedAt - left.importedAt)
  }

  async importArchive(snapshot: ArchiveSnapshot): Promise<ImportedArchive> {
    validateArchiveSnapshot(snapshot)
    await runTransaction(this.directory, ['sources'], 'readwrite', async (transaction) => {
      await requestAsPromise(transaction.objectStore('sources').put({ id: snapshot.source.id }))
    })
    const database = await this.openSource(snapshot.source.id)
    const descriptor: ImportedArchiveDescriptor = {
      key: 'snapshot',
      version: snapshot.version,
      source: snapshot.source,
      exportedAt: snapshot.exportedAt,
      importedAt: Date.now(),
      preferences: snapshot.preferences,
    }
    try {
      await runTransaction(database, [...HISTORY_STORES, DESCRIPTOR], 'readwrite', async (transaction) => {
        await replaceStores(transaction, snapshot.stores)
        await requestAsPromise(transaction.objectStore(DESCRIPTOR).put(descriptor))
      })
      const channel = openArchiveChannel(database.name)
      channel.post('pruned')
      channel.close()
      return { source: descriptor.source, exportedAt: descriptor.exportedAt, importedAt: descriptor.importedAt, preferences: descriptor.preferences }
    } finally {
      database.close()
    }
  }

  async readImported(sourceId: string): Promise<ArchiveSnapshot> {
    const database = await this.openSource(sourceId)
    try {
      return await runTransaction(database, [...HISTORY_STORES, DESCRIPTOR], 'readonly', async (transaction) => {
        const [descriptor, stores] = await Promise.all([readDescriptor(transaction), readStores(transaction)])
        if (descriptor === undefined) throw new Error('The imported archive does not exist.')
        return {
          format: 'shunt-archive',
          version: descriptor.version ?? 1,
          source: descriptor.source,
          exportedAt: descriptor.exportedAt,
          preferences: descriptor.preferences,
          stores: (descriptor.version ?? 1) === 1 ? withoutHours(stores) : stores,
        }
      })
    } finally {
      database.close()
    }
  }

  async openImported(sourceId: string): Promise<HistoryStore> {
    const database = await this.openSource(sourceId)
    try {
      const descriptor = await runTransaction(database, [DESCRIPTOR], 'readonly', readDescriptor)
      if (descriptor === undefined) throw new Error('The imported archive does not exist.')
      const store = new IdbHistoryStore(database, {
        usable: true,
        reason: null,
        persisted: null,
        estimatedBytes: null,
        quotaBytes: null,
      }, openArchiveChannel(database.name))
      return readOnlyHistoryStore(store)
    } catch (error) {
      database.close()
      throw error
    }
  }

  async restoreLocal(snapshot: ArchiveSnapshot, confirmation: 'replace'): Promise<void> {
    validateArchiveSnapshot(snapshot)
    if (confirmation !== 'replace') throw new Error('Confirm replacement of this browser archive first.')
    if (snapshot.source.id !== this.source.id) throw new Error('A foreign archive cannot replace this browser archive.')
    if (snapshot.stores.sessions.some((session) => session.state === 'open')) {
      throw new Error('This snapshot contains active recordings. Keep it as a read-only imported archive.')
    }
    await runTransaction(this.history, HISTORY_STORES, 'readwrite', async (transaction) => {
      const sessions = await requestAsPromise<SessionRecord[]>(transaction.objectStore('sessions').getAll())
      if (sessions.some((session) => session.state === 'open')) {
        throw new Error('Stop all active recordings before replacing this browser archive.')
      }
      await replaceStores(transaction, snapshot.stores)
    })
    const channel = openArchiveChannel(this.history.name)
    channel.post('pruned')
    channel.close()
  }

  close(): void {
    this.history.close()
    this.directory.close()
  }

  private openSource(sourceId: string): Promise<IDBDatabase> {
    const name = `${this.history.name}.imported.${encodeURIComponent(sourceId)}`
    return openArchiveDatabase(name, DATABASE_VERSION, (database, oldVersion) => {
      applySchema(database, oldVersion)
      if (!database.objectStoreNames.contains(DESCRIPTOR)) {
        database.createObjectStore(DESCRIPTOR, { keyPath: 'key' })
      }
    })
  }
}

async function readStores(transaction: IDBTransaction, detail: 'complete' | 'hourly' = 'complete'): Promise<ArchiveStores> {
  const [sessions, chunks, devices, meta, warnings, ringRecords, ringReads, hours] = await Promise.all(
    HISTORY_STORES.map((store) => store === 'chunks' && detail === 'hourly' ? Promise.resolve([]) : requestAsPromise(transaction.objectStore(store).getAll())),
  )
  return { sessions, chunks, devices, meta, warnings, ringRecords, ringReads, hours }
}

async function replaceStores(transaction: IDBTransaction, stores: ArchiveStores): Promise<void> {
  for (const name of HISTORY_STORES) {
    const destination = transaction.objectStore(name)
    await requestAsPromise(destination.clear())
    const rows = name === 'sessionHours' ? stores.hours ?? [] : stores[name]
    for (const row of rows) await requestAsPromise(destination.add(row))
  }
}

function readDescriptor(transaction: IDBTransaction): Promise<ImportedArchiveDescriptor | undefined> {
  return requestAsPromise(transaction.objectStore(DESCRIPTOR).get('snapshot'))
}

function withoutHours(stores: ArchiveStores): ArchiveStores {
  const { hours: _hours, ...legacyStores } = stores
  return legacyStores
}
