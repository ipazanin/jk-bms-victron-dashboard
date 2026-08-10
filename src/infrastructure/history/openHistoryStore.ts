/**
 * The honest probe. It never throws and never returns null: a browser that will not keep a log
 * gets a store that says so, and the dashboard goes on working as a live instrument.
 *
 * Private browsing, in-app WebViews and locked-down enterprise profiles each fail differently and
 * none of them is an error the owner did anything to cause, so each failure resolves to a reason
 * the Log can print as a sentence rather than to a rejected promise somebody has to catch.
 *
 * Chrome incognito is the awkward middle case and there is no API for it: IndexedDB works, but it
 * is in memory and dies with the window. `persisted: false` is the closest honest signal there is,
 * and it is reported as-is rather than dressed up as durability.
 *
 * The database is named by the caller, so a build serving its own playback radios can record for
 * real into an archive of its own instead of writing fabricated sessions into the boat's. Nothing
 * below cares which name it is handed, but the channel is opened under the same one: two tabs of one
 * archive have to hear each other, and two archives must never hear each other at all.
 */

import { unavailableHistoryStore } from '../../application/history/port'
import type { HistoryAvailability, HistoryStore, HistoryUnavailableReason } from '../../application/history/port'
import { openArchiveChannel } from './archiveChannel'
import { DATABASE_NAME, DATABASE_VERSION, IdbHistoryStore, applySchema } from './IdbHistoryStore'

/**
 * How long another tab may hold an older version open before this one gives up. Without a bound the
 * first schema bump hangs any owner with two tabs open: the upgrade never runs, and the new tab
 * waits on it forever with nothing on screen to explain why.
 */
const OPEN_BLOCKED_TIMEOUT_MS = 3_000

type OpenAttempt =
  | { readonly kind: 'opened'; readonly database: IDBDatabase }
  | { readonly kind: 'failed'; readonly reason: HistoryUnavailableReason }

export async function openHistoryStore(databaseName: string = DATABASE_NAME): Promise<HistoryStore> {
  const factory = typeof indexedDB === 'undefined' ? null : indexedDB
  if (factory === null) return unavailableHistoryStore('no-indexeddb')

  const attempt = await openDatabase(factory, databaseName)
  if (attempt.kind === 'failed') return unavailableHistoryStore(attempt.reason)

  const availability: HistoryAvailability = {
    usable: true,
    reason: null,
    persisted: await requestPersistence(),
    ...(await measureStorage()),
  }
  const store = new IdbHistoryStore(attempt.database, availability, openArchiveChannel(databaseName))
  // A failed sweep is not a failed archive: reads and writes still work, the tidying simply did not
  // happen on this load and will be attempted again on the next one.
  await store.recover(Date.now()).catch(() => undefined)
  return store
}

function openDatabase(factory: IDBFactory, databaseName: string): Promise<OpenAttempt> {
  return new Promise<OpenAttempt>((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = factory.open(databaseName, DATABASE_VERSION)
    } catch {
      // Safari in private browsing throws from open() rather than rejecting it.
      resolve({ kind: 'failed', reason: 'open-denied' })
      return
    }

    let blockedTimer: ReturnType<typeof setTimeout> | null = null
    let settled = false
    const settle = (attempt: OpenAttempt): void => {
      if (blockedTimer !== null) clearTimeout(blockedTimer)
      blockedTimer = null
      settled = true
      resolve(attempt)
    }

    request.addEventListener('upgradeneeded', (event) => {
      applySchema(request.result, (event as IDBVersionChangeEvent).oldVersion)
    })
    request.addEventListener('blocked', () => {
      blockedTimer = setTimeout(
        () => settle({ kind: 'failed', reason: 'open-blocked' }),
        OPEN_BLOCKED_TIMEOUT_MS,
      )
    })
    request.addEventListener('success', () => {
      if (settled) {
        // An open request cannot be cancelled, so giving up on the blocking tab only stops this
        // page waiting — the upgrade still runs the moment that tab lets go, and hands back a
        // connection nobody asked for any more. It carries no `onversionchange` handler, because
        // the store that installs one is never built once the probe has reported a failure, so
        // left open it is the thing that blocks the next schema upgrade in every other tab.
        request.result.close()
        return
      }
      settle({ kind: 'opened', database: request.result })
    })
    request.addEventListener('error', (event) => {
      event.preventDefault()
      settle({ kind: 'failed', reason: reasonFor(request.error) })
    })
  })
}

/**
 * A stored database at a higher version than this build knows was written by a newer version of
 * this page. It is reported and left completely alone — deleting a newer build's recordings to make
 * an older one work is not a trade this page is entitled to make on the owner's behalf.
 */
function reasonFor(error: DOMException | null): HistoryUnavailableReason {
  return error?.name === 'VersionError' ? 'version-newer' : 'open-denied'
}

async function requestPersistence(): Promise<boolean | null> {
  const storage = storageManager()
  if (typeof storage?.persist !== 'function') return null
  try {
    return await storage.persist()
  } catch {
    return null
  }
}

async function measureStorage(): Promise<Pick<HistoryAvailability, 'estimatedBytes' | 'quotaBytes'>> {
  const storage = storageManager()
  if (typeof storage?.estimate !== 'function') return { estimatedBytes: null, quotaBytes: null }
  try {
    const estimate = await storage.estimate()
    return { estimatedBytes: estimate.usage ?? null, quotaBytes: estimate.quota ?? null }
  } catch {
    return { estimatedBytes: null, quotaBytes: null }
  }
}

/**
 * `navigator.storage` is undefined under jsdom and `navigator` itself is undefined under a plain
 * Node test environment. Both have to be optional here or this module throws while it is being
 * imported, which takes down every spec in the file that imported it.
 */
function storageManager(): StorageManager | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.storage
}
