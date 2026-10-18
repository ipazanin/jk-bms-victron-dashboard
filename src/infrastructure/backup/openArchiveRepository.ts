import type { ArchiveRepository } from '../../application/backup/ArchiveRepository'
import { DATABASE_VERSION, applySchema } from '../history/IdbHistoryStore'
import { requestAsPromise, runTransaction } from '../history/idb'
import type { ArchiveSource } from '../../domain/backup/ArchiveSource'
import { IdbArchiveRepository } from './IdbArchiveRepository'
import { openArchiveDatabase } from './openArchiveDatabase'

export async function openArchiveRepository(
  databaseName: string,
  sourceLabel: string,
): Promise<ArchiveRepository> {
  const directory = await openArchiveDatabase(`${databaseName}.archive-directory`, 1, (database) => {
    database.createObjectStore('sources', { keyPath: 'id' })
    database.createObjectStore('local', { keyPath: 'id' })
  })
  let history: IDBDatabase | undefined
  try {
    const source = await runTransaction(directory, ['local'], 'readwrite', async (transaction) => {
      const local = transaction.objectStore('local')
      const stored = await requestAsPromise<{ readonly source: ArchiveSource } | undefined>(local.get('source'))
      if (stored !== undefined) {
        return stored.source
      }
      const created: ArchiveSource = { id: crypto.randomUUID(), label: sourceLabel }
      await requestAsPromise(local.add({ id: 'source', source: created }))
      return created
    })
    history = await openArchiveDatabase(databaseName, DATABASE_VERSION, applySchema)
    return new IdbArchiveRepository(history, directory, source)
  } catch (error) {
    history?.close()
    directory.close()
    throw error
  }
}
