/**
 * IndexedDB as promises, with both failure paths wired up.
 *
 * Two of them matter and each is easy to miss on its own. A failing request fires an error event
 * that bubbles to the connection, aborting its transaction on the way, and arrives at the page as
 * an uncaught error; and a browser out of disk can skip the request error entirely and abort at
 * commit time, when the request that caused it is long gone. A helper that watches only one of the
 * two turns a full disk into silent data loss, so everything here settles on whichever arrives
 * first and nothing is left to bubble.
 *
 * Nothing in this file knows what the Log stores. It is the platform, wrapped.
 */

/** How a write failed. Only one of the three is worth retrying, and only after making room. */
export type WriteFailure = 'quota' | 'aborted' | 'unknown'

/**
 * One request, settled once.
 *
 * A rejected request takes its transaction down with it. That rollback is wanted — a chunk, a
 * session row and the sample counter are one write or none — but it is asked for here, explicitly,
 * with the real failure already in hand, rather than left to the default path that also reports the
 * error as unhandled.
 */
export function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener(
      'error',
      (event) => {
        event.preventDefault()
        const failure = request.error ?? abortFailure()
        abortQuietly(request.transaction)
        reject(failure)
      },
      { once: true },
    )
  })
}

/**
 * Walks a cursor to exhaustion, or until `visit` returns false.
 *
 * The early stop is what lets a bounded list read the newest rows instead of every session in the
 * archive; a cursor has no other way to say "enough".
 */
export function cursorEach<C extends IDBCursor>(
  request: IDBRequest<C | null>,
  visit: (cursor: C) => void | false,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    request.addEventListener('success', () => {
      const cursor = request.result
      if (cursor === null) {
        resolve()
        return
      }
      let wants: void | false
      try {
        wants = visit(cursor)
      } catch (error) {
        abortQuietly(request.transaction)
        reject(error)
        return
      }
      if (wants === false) {
        resolve()
        return
      }
      cursor.continue()
    })
    request.addEventListener(
      'error',
      (event) => {
        event.preventDefault()
        const failure = request.error ?? abortFailure()
        abortQuietly(request.transaction)
        reject(failure)
      },
      { once: true },
    )
  })
}

/** Resolves when the transaction has actually committed, so a caller can trust what it wrote. */
export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener('abort', () => reject(transaction.error ?? abortFailure()), {
      once: true,
    })
  })
}

/**
 * Runs a body of requests inside one transaction and resolves only once that transaction commits.
 *
 * Two promises are in flight — the body's and the transaction's — and either can settle first: a
 * request error rejects the body, a commit-time abort rejects the transaction with the body still
 * waiting. Both are always consumed, because an abort arriving after the body has already thrown is
 * the same failure told twice, and a rejection nobody awaited is an unhandled rejection that fails
 * a whole spec file.
 *
 * The body must await nothing but the requests of this transaction. IndexedDB commits as soon as it
 * runs out of pending requests and control returns to the event loop, so awaiting a timer, a fetch,
 * or any other macrotask mid-transaction commits it early and leaves the rest of the write behind.
 */
export async function runTransaction<T>(
  database: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  body: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const transaction = database.transaction([...stores], mode)
  const committed = transactionDone(transaction)
  try {
    const result = await body(transaction)
    await committed
    return result
  } catch (error) {
    abortQuietly(transaction)
    await committed.catch(() => undefined)
    throw error
  }
}

/**
 * Whether the browser refused a write for want of room.
 *
 * The name is what every current engine reports. The legacy numeric code is still what older WebKit
 * sends, and iOS is exactly where the archive is most likely to hit a wall.
 */
export function isQuotaError(error: unknown): boolean {
  if (errorName(error) === 'QuotaExceededError') return true
  return readsAs(error, 'code') === 22
}

/**
 * The one branch the adapter's retry turns on, kept pure so it can be tested without a full disk —
 * which no IndexedDB fake emulates.
 */
export function classifyWriteFailure(error: unknown): WriteFailure {
  if (isQuotaError(error)) return 'quota'
  if (errorName(error) === 'AbortError') return 'aborted'
  return 'unknown'
}

function abortQuietly(transaction: IDBTransaction | null): void {
  if (transaction === null) return
  try {
    transaction.abort()
  } catch {
    // Already finished. The rollback this was asking for has happened either way.
  }
}

/** The stand-in for the case the platform aborts and names no cause. */
function abortFailure(): DOMException {
  return new DOMException('The transaction was aborted.', 'AbortError')
}

function errorName(error: unknown): string {
  const name = readsAs(error, 'name')
  return typeof name === 'string' ? name : ''
}

function readsAs(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[field]
}
