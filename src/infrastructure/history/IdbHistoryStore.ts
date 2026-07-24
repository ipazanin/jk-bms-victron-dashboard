/**
 * The Log on disk. The only IndexedDB adapter in the project.
 *
 * It executes plans and never makes them: what to drop is decided by `planPrune`, what a chunk
 * holds is decided by the column layout, and what a session means is decided by the ledger. This
 * file's whole job is that those decisions land atomically. Every write is one transaction scoped
 * to all four stores, because IndexedDB serialises overlapping-scope readwrite transactions across
 * connections on the same origin — which makes commit-plus-prune atomic against a second tab for
 * free, where a read-modify-write split across an await would not be.
 *
 * Two counters carry the archive's integrity and both move under one rule: `sealedSamples` on a
 * session and `totalSamples` in the meta row change only when a chunk seals, and only on the
 * transition. A tail rewritten every ten seconds is therefore free, and a commit retried after an
 * ambiguous failure cannot count its rows twice.
 */

import { isReadableLayout } from '../../domain/history/columns'
import { deviceLabel } from '../../domain/history/identity'
import {
  MAX_SESSIONS,
  MAX_TOTAL_SAMPLES,
  PRUNE_TARGET_RATIO,
  planPrune,
} from '../../domain/history/budget'
import type {
  ChunkExtent,
  PruneCandidate,
  PruneProtection,
  PruneTruncation,
} from '../../domain/history/budget'
import { HEARTBEAT_STALE_MS, PACK_STREAM } from '../../domain/history/types'
import type {
  DeviceKey,
  DeviceRecord,
  HistoryChunk,
  HistoryMeta,
  PackChunk,
  SessionId,
  SessionRecord,
  SolarChunk,
  StreamName,
  TimeWindow,
  WarningRecord,
} from '../../domain/history/types'
import { SNAPSHOT_SCHEMA_VERSION } from '../../domain/schemaVersion'
import { renderWindowFor } from '../../application/history/port'
import type {
  CommitOutcome,
  HistoryAvailability,
  HistoryStore,
  SessionClosure,
  SessionListing,
  SessionPatch,
  StoredSession,
} from '../../application/history/port'
import type { ArchiveChannel } from './archiveChannel'
import { classifyWriteFailure, cursorEach, requestAsPromise, runTransaction } from './idb'

export const DATABASE_NAME = 'shunt.log'
export const DATABASE_VERSION = 2

const SESSIONS = 'sessions'
const CHUNKS = 'chunks'
const DEVICES = 'devices'
const META = 'meta'
const WARNINGS = 'warnings'
const EVERY_STORE = [SESSIONS, CHUNKS, DEVICES, META, WARNINGS]

const BY_STARTED_AT = 'byStartedAt'
const BY_DEVICE = 'byDevice'
const BY_STATE = 'byState'
const BY_SESSION = 'bySession'
const BY_LAST_SEEN = 'byLastSeen'
const BY_TIME = 'byTime'

const TOTALS_KEY = 'totals'

/**
 * The domain's own target, read here for one purpose only: deciding whether a second and much more
 * expensive planning pass is worth its I/O. What gets dropped is still decided in `planPrune`.
 */
const PRUNE_TARGET = Math.floor(MAX_TOTAL_SAMPLES * PRUNE_TARGET_RATIO)

/** Higher than any sequence a session can reach, as the open end of a one-session key range. */
const HIGHEST_SEQ = Number.MAX_SAFE_INTEGER

const NO_CHUNKS: readonly ChunkExtent[] = []

interface PruneExecution {
  readonly evicted: readonly SessionId[]
  readonly freedSamples: number
  readonly truncatedFrom: number | null
}

const NOTHING_PRUNED: PruneExecution = { evicted: [], freedSamples: 0, truncatedFrom: null }

/**
 * Builds the stores and indexes for a database at `oldVersion`.
 *
 * An upgrade transaction blocks every tab on the origin, and the chunk store is tens of megabytes,
 * so an upgrade may only add — never rewrite a chunk. A change to what a chunk holds rides on
 * `CHUNK_LAYOUT_VERSION` instead, where decoding dispatches on it and chunks already written stay
 * readable.
 */
export function applySchema(database: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    const sessions = database.createObjectStore(SESSIONS, { keyPath: 'id' })
    sessions.createIndex(BY_STARTED_AT, 'startedAt')
    sessions.createIndex(BY_DEVICE, ['groupKey', 'startedAt'])
    sessions.createIndex(BY_STATE, 'state')

    const chunks = database.createObjectStore(CHUNKS, { keyPath: ['sessionId', 'stream', 'seq'] })
    chunks.createIndex(BY_SESSION, 'sessionId')

    const devices = database.createObjectStore(DEVICES, { keyPath: 'key' })
    devices.createIndex(BY_LAST_SEEN, 'lastSeenAt')

    database.createObjectStore(META, { keyPath: 'key' })
  }
  if (oldVersion < 2) {
    // Keyed [sessionId, seq] so one session's warnings are a contiguous range that dies with it;
    // indexed by time for the standalone log, which reads them most-recent-first across sessions.
    const warnings = database.createObjectStore(WARNINGS, { keyPath: ['sessionId', 'seq'] })
    warnings.createIndex(BY_TIME, 'at')
  }
}

export class IdbHistoryStore implements HistoryStore {
  private readonly database: IDBDatabase
  private readonly channel: ArchiveChannel
  private state: HistoryAvailability
  /** The session on screen in this tab, if the view said so. Pruning never evicts it. */
  private viewedSessionId: SessionId | null
  /** The last counter this connection saw, so a refused write can still report an honest total. */
  private knownTotal: number
  private connected: boolean

  constructor(database: IDBDatabase, availability: HistoryAvailability, channel: ArchiveChannel) {
    this.database = database
    this.channel = channel
    this.state = availability
    this.viewedSessionId = null
    this.knownTotal = 0
    this.connected = true
    // Another tab is upgrading the schema. Holding this connection open deadlocks it — the upgrade
    // never runs and the new tab hangs with no error — so this one steps aside.
    database.onversionchange = () => this.standDown()
  }

  get availability(): HistoryAvailability {
    return this.state
  }

  async openSession(record: SessionRecord): Promise<void> {
    if (!this.connected) return
    await runTransaction(this.database, [SESSIONS], 'readwrite', async (transaction) => {
      await requestAsPromise(transaction.objectStore(SESSIONS).put(record))
    })
    this.channel.post('session-opened')
  }

  async commitChunk(chunk: HistoryChunk, patch: SessionPatch): Promise<CommitOutcome> {
    try {
      return this.announce(await this.writeChunk(chunk, patch))
    } catch (error) {
      if (classifyWriteFailure(error) !== 'quota') return this.refusedCommit(null)
      // The disk refused this, not the budget. Pruning to the sample budget is the only eviction
      // policy there is, so when the archive is already inside it nothing is freed and the retry
      // fails the same way — which is the honest answer. The owner deletes a session.
      await this.pruneToBudget(patch.heartbeatAt).catch(() => undefined)
      try {
        return this.announce(await this.writeChunk(chunk, patch))
      } catch (retried) {
        if (classifyWriteFailure(retried) !== 'quota') return this.refusedCommit(null)
        this.state = { ...this.state, usable: false, reason: 'quota-exhausted' }
        return this.refusedCommit('quota-exhausted')
      }
    }
  }

  async closeSession(id: SessionId, closure: SessionClosure): Promise<void> {
    if (!this.connected) return
    await runTransaction(this.database, EVERY_STORE, 'readwrite', async (transaction) => {
      const sessions = transaction.objectStore(SESSIONS)
      const stored = await requestAsPromise<SessionRecord | undefined>(sessions.get(id))
      if (stored === undefined) return

      const folded = await this.sealOpenChunks(transaction, id)
      const closed: SessionRecord = {
        ...stored,
        ...closure,
        state: 'closed',
        sealedSamples: stored.sealedSamples + folded.samples,
      }
      await requestAsPromise(sessions.put(closed))
      // A second close finds no open chunk and folds nothing, which is what makes finish()
      // idempotent all the way down to the counter.
      const meta = await this.readMeta(transaction, closure.endedAt)
      await this.writeTotal(transaction, meta, meta.totalSamples + folded.samples, null)
    })
    this.channel.post('session-closed')
  }

  async deleteSession(id: SessionId, now: number = Date.now()): Promise<void> {
    if (!this.connected) return
    await runTransaction(this.database, EVERY_STORE, 'readwrite', async (transaction) => {
      const freed = await this.evictSession(transaction, id)
      if (freed === 0) return
      const meta = await this.readMeta(transaction, now)
      await this.writeTotal(transaction, meta, meta.totalSamples - freed, now)
    })
    this.channel.post('pruned')
  }

  async appendWarning(record: WarningRecord): Promise<void> {
    if (!this.connected) return
    await runTransaction(this.database, [WARNINGS], 'readwrite', async (transaction) => {
      await requestAsPromise(transaction.objectStore(WARNINGS).put(record))
    })
  }

  async warningsOf(id: SessionId): Promise<readonly WarningRecord[]> {
    if (!this.connected) return []
    return runTransaction(this.database, [WARNINGS], 'readonly', async (transaction) => {
      const records: WarningRecord[] = []
      const range = IDBKeyRange.bound([id], [id, HIGHEST_SEQ])
      await cursorEach(transaction.objectStore(WARNINGS).openCursor(range), (cursor) => {
        records.push(cursor.value as WarningRecord)
      })
      return records
    })
  }

  async listWarnings(limit?: number): Promise<readonly WarningRecord[]> {
    if (!this.connected) return []
    return runTransaction(this.database, [WARNINGS], 'readonly', async (transaction) => {
      const records: WarningRecord[] = []
      const newestFirst = transaction.objectStore(WARNINGS).index(BY_TIME).openCursor(null, 'prev')
      await cursorEach(newestFirst, (cursor) => {
        if (limit !== undefined && records.length >= limit) return false
        records.push(cursor.value as WarningRecord)
      })
      return records
    })
  }

  async warningsInWindow(window: TimeWindow): Promise<readonly WarningRecord[]> {
    if (!this.connected) return []
    return runTransaction(this.database, [WARNINGS], 'readonly', async (transaction) => {
      const records: WarningRecord[] = []
      // Bounded to [from, to] on the time index, so the read costs the window rather than the whole
      // log and is never capped: a month's tally counts every warning it holds. Ascending.
      const range = IDBKeyRange.bound(window.from, window.to)
      await cursorEach(transaction.objectStore(WARNINGS).index(BY_TIME).openCursor(range), (cursor) => {
        records.push(cursor.value as WarningRecord)
      })
      return records
    })
  }

  async listSessions(limit: number = MAX_SESSIONS): Promise<readonly SessionListing[]> {
    if (!this.connected) return []
    return runTransaction(this.database, [SESSIONS, DEVICES], 'readonly', async (transaction) => {
      const records: SessionRecord[] = []
      const newestFirst = transaction
        .objectStore(SESSIONS)
        .index(BY_STARTED_AT)
        .openCursor(null, 'prev')
      await cursorEach(newestFirst, (cursor) => {
        if (records.length >= limit) return false
        records.push(cursor.value as SessionRecord)
      })

      const devices = await this.readDevices(
        transaction,
        records.map((record) => record.groupKey),
      )
      return records.map((record) => {
        const device = devices.get(record.groupKey) ?? null
        return { record, device, label: deviceLabel(device) }
      })
    })
  }

  async listDevices(): Promise<readonly DeviceRecord[]> {
    if (!this.connected) return []
    return runTransaction(this.database, [DEVICES], 'readonly', async (transaction) => {
      const records: DeviceRecord[] = []
      const cursor = transaction.objectStore(DEVICES).index(BY_LAST_SEEN).openCursor(null, 'prev')
      await cursorEach(cursor, (each) => {
        records.push(each.value as DeviceRecord)
      })
      return records
    })
  }

  async readSession(id: SessionId, window?: TimeWindow): Promise<StoredSession | null> {
    if (!this.connected) return null
    return runTransaction(this.database, [SESSIONS, CHUNKS, DEVICES], 'readonly', async (tx) => {
      const record = await requestAsPromise<SessionRecord | undefined>(
        tx.objectStore(SESSIONS).get(id),
      )
      if (record === undefined) return null

      // What the session actually holds starts where its retained data starts, which after a
      // truncation is not where the session began.
      const available = {
        from: record.retainedFrom ?? record.startedAt,
        to: record.endedAt ?? record.heartbeatAt,
      }
      const held = renderWindowFor(available, window)
      const pack: PackChunk[] = []
      const solar: SolarChunk[] = []
      const chunks = tx.objectStore(CHUNKS).index(BY_SESSION).openCursor(IDBKeyRange.only(id))
      await cursorEach(chunks, (cursor) => {
        const chunk = cursor.value as HistoryChunk
        if (!isReadableLayout(chunk.layout)) return
        if (!overlapsWindow(chunk, held.window)) return
        if (chunk.stream === PACK_STREAM) pack.push(chunk)
        else solar.push(chunk)
      })

      const devices = await this.readDevices(tx, [record.packDeviceKey, record.solarDeviceKey])
      return {
        record,
        packDevice: (record.packDeviceKey && devices.get(record.packDeviceKey)) || null,
        solarDevice: (record.solarDeviceKey && devices.get(record.solarDeviceKey)) || null,
        pack: pack.sort(bySeq),
        solar: solar.sort(bySeq),
        windowClamped: held.clamped,
      }
    })
  }

  async streamChunks(
    id: SessionId,
    stream: StreamName,
    window: TimeWindow,
    visit: (chunk: HistoryChunk) => void,
  ): Promise<void> {
    if (!this.connected) return
    await runTransaction(this.database, [CHUNKS], 'readonly', async (transaction) => {
      // The primary key is [sessionId, stream, seq], so this range is one stream of one session in
      // sequence order, and the cursor holds one chunk at a time rather than a session's worth.
      const range = IDBKeyRange.bound([id, stream], [id, stream, HIGHEST_SEQ])
      await cursorEach(transaction.objectStore(CHUNKS).openCursor(range), (cursor) => {
        const chunk = cursor.value as HistoryChunk
        if (!isReadableLayout(chunk.layout)) return
        if (!overlapsWindow(chunk, window)) return
        visit(chunk)
      })
    })
  }

  async upsertDevice(record: DeviceRecord): Promise<DeviceRecord> {
    if (!this.connected) return record
    return runTransaction(this.database, [DEVICES], 'readwrite', async (transaction) => {
      const devices = transaction.objectStore(DEVICES)
      const stored = await requestAsPromise<DeviceRecord | undefined>(devices.get(record.key))
      const merged = stored === undefined ? record : mergeDevice(stored, record)
      await requestAsPromise(devices.put(merged))
      return merged
    })
  }

  async renameDevice(key: DeviceKey, label: string | null): Promise<DeviceRecord | null> {
    if (!this.connected) return null
    const renamed = await runTransaction(
      this.database,
      [DEVICES],
      'readwrite',
      // The read and the write are one transaction, so two tabs renaming at once cannot interleave
      // into a lost update.
      async (transaction) => {
        const devices = transaction.objectStore(DEVICES)
        const stored = await requestAsPromise<DeviceRecord | undefined>(devices.get(key))
        if (stored === undefined) return null
        const chosen = label?.trim() ?? ''
        // An empty field restores the derived name rather than blanking the device.
        const updated: DeviceRecord = { ...stored, userLabel: chosen === '' ? null : chosen }
        await requestAsPromise(devices.put(updated))
        return updated
      },
    )
    if (renamed !== null) this.channel.post('device-renamed')
    return renamed
  }

  /**
   * The sweep that runs once, on open, before anything else touches the archive.
   *
   * It is never destructive to data: a session left open by a killed tab is closed, not deleted,
   * and its unsealed tail is folded into the counters at that moment so the ledger stays exact. A
   * tab that was merely frozen and thaws later finds its own row closed and opens a new session
   * continuing it rather than resurrecting this one.
   *
   * The counter is re-derived from the surviving session rows in the same pass. It is the one place
   * that can happen cheaply, and a crash mid-write is exactly what would otherwise leave the budget
   * permanently wrong.
   */
  async recover(now: number): Promise<{ readonly closed: number; readonly orphansRemoved: number }> {
    if (!this.connected) return { closed: 0, orphansRemoved: 0 }
    const swept = await runTransaction(
      this.database,
      EVERY_STORE,
      'readwrite',
      async (transaction) => {
        const sessions = transaction.objectStore(SESSIONS)
        const surviving = new Set<SessionId>()
        const abandoned: SessionRecord[] = []
        let totalSamples = 0

        await cursorEach(sessions.openCursor(), (cursor) => {
          const record = cursor.value as SessionRecord
          surviving.add(record.id)
          if (record.state === 'open' && now - record.heartbeatAt >= HEARTBEAT_STALE_MS) {
            abandoned.push(record)
            return
          }
          totalSamples += record.sealedSamples
        })

        let closed = 0
        for (const record of abandoned) {
          const folded = await this.sealOpenChunks(transaction, record.id)
          const sealedSamples = record.sealedSamples + folded.samples
          closed += 1
          if (sealedSamples === 0) {
            // A row that recorded nothing is noise, not history. It still counts as closed out.
            await this.evictSession(transaction, record.id)
            surviving.delete(record.id)
            continue
          }
          const settled: SessionRecord = {
            ...record,
            state: 'closed',
            endReason: 'abandoned',
            endedAt: folded.lastSampleAt ?? record.heartbeatAt,
            sealedSamples,
          }
          await requestAsPromise(sessions.put(settled))
          totalSamples += sealedSamples
        }

        let orphansRemoved = 0
        const chunks = transaction.objectStore(CHUNKS)
        // A key cursor, so the sweep costs one pass over the chunk keys and never deserializes a
        // column. An orphan is unreachable and would hold its share of the budget forever.
        await cursorEach(chunks.index(BY_SESSION).openKeyCursor(), (cursor) => {
          if (surviving.has(cursor.key as SessionId)) return
          chunks.delete(cursor.primaryKey)
          orphansRemoved += 1
        })

        // Warnings whose session row is gone — a crash between two writes of a delete — go too.
        const warnings = transaction.objectStore(WARNINGS)
        await cursorEach(warnings.openKeyCursor(), (cursor) => {
          const [sessionId] = cursor.primaryKey as [SessionId, number]
          if (!surviving.has(sessionId)) warnings.delete(cursor.primaryKey)
        })

        const meta = await this.readMeta(transaction, now)
        await this.writeTotal(transaction, meta, totalSamples, null)
        return { closed, orphansRemoved }
      },
    )
    if (swept.closed > 0) this.channel.post('session-closed')
    return swept
  }

  async usage(): Promise<{ readonly totalSamples: number; readonly sessions: number }> {
    if (!this.connected) return { totalSamples: this.knownTotal, sessions: 0 }
    return runTransaction(this.database, [SESSIONS, META], 'readonly', async (transaction) => {
      const meta = await this.readMeta(transaction, 0)
      const sessions = await requestAsPromise<number>(transaction.objectStore(SESSIONS).count())
      this.knownTotal = meta.totalSamples
      return { totalSamples: meta.totalSamples, sessions }
    })
  }

  watch(onChanged: () => void): () => void {
    return this.channel.subscribe(() => onChanged())
  }

  /**
   * Protection for the session on screen, which only this tab knows about.
   *
   * A second tab's pruning cannot see it and derives its protection from stored heartbeats alone,
   * so a reader still has to survive `readSession → null`. This narrows the window; it does not
   * close it.
   */
  noteViewing(id: SessionId | null): void {
    this.viewedSessionId = id
  }

  close(): void {
    if (!this.connected) return
    this.connected = false
    this.database.close()
    this.channel.close()
  }

  // ── writing a chunk ────────────────────────────────────────────────────────

  private async writeChunk(chunk: HistoryChunk, patch: SessionPatch): Promise<CommitOutcome> {
    if (!this.connected) return this.refusedCommit(null)
    return runTransaction(this.database, EVERY_STORE, 'readwrite', async (transaction) => {
      const sessions = transaction.objectStore(SESSIONS)
      const chunks = transaction.objectStore(CHUNKS)
      const stored = await requestAsPromise<SessionRecord | undefined>(
        sessions.get(chunk.sessionId),
      )
      // No row means the session was never opened, or another tab deleted it underneath. Writing
      // the chunk anyway would leave an orphan holding budget with nothing to reach it by.
      if (stored === undefined) return this.refusedCommit(null)

      const existing = await requestAsPromise<HistoryChunk | undefined>(
        chunks.get([chunk.sessionId, chunk.stream, chunk.seq]),
      )
      // The counter moves on the seal transition, never on the write. A tail rewritten every
      // checkpoint costs nothing, and a commit retried after an ambiguous failure — one that in
      // fact landed — cannot count its rows a second time.
      const sealedGain = chunk.sealed && existing?.sealed !== true ? chunk.length : 0

      await requestAsPromise(chunks.put(chunk))
      const merged: SessionRecord = {
        ...stored,
        ...patch,
        sealedSamples: stored.sealedSamples + sealedGain,
      }
      await requestAsPromise(sessions.put(merged))

      const meta = await this.readMeta(transaction, patch.heartbeatAt)
      const afterSeal = meta.totalSamples + sealedGain
      const pruned = await this.prune(transaction, afterSeal, patch.heartbeatAt)
      const totalSamples = afterSeal - pruned.freedSamples
      const prunedAt = pruned.freedSamples > 0 ? patch.heartbeatAt : null
      await this.writeTotal(transaction, meta, totalSamples, prunedAt)

      return {
        stored: true,
        totalSamples,
        prunedSessionIds: pruned.evicted,
        truncatedFrom: pruned.truncatedFrom,
        failure: null,
      }
    })
  }

  /** Announced only once the transaction has committed, so no tab is told about a rolled-back cut. */
  private announce(outcome: CommitOutcome): CommitOutcome {
    const cut = outcome.prunedSessionIds.length > 0 || outcome.truncatedFrom !== null
    if (cut) this.channel.post('pruned')
    return outcome
  }

  private refusedCommit(failure: CommitOutcome['failure']): CommitOutcome {
    return {
      stored: false,
      totalSamples: this.knownTotal,
      prunedSessionIds: [],
      truncatedFrom: null,
      failure,
    }
  }

  // ── pruning ────────────────────────────────────────────────────────────────

  private async pruneToBudget(now: number): Promise<void> {
    const freed = await runTransaction(
      this.database,
      EVERY_STORE,
      'readwrite',
      async (transaction) => {
        const meta = await this.readMeta(transaction, now)
        const pruned = await this.prune(transaction, meta.totalSamples, now)
        if (pruned.freedSamples === 0) return 0
        await this.writeTotal(transaction, meta, meta.totalSamples - pruned.freedSamples, now)
        return pruned.freedSamples
      },
    )
    if (freed > 0) this.channel.post('pruned')
  }

  private async prune(
    transaction: IDBTransaction,
    totalSamples: number,
    now: number,
  ): Promise<PruneExecution> {
    const sessions = transaction.objectStore(SESSIONS)
    const sessionCount = await requestAsPromise<number>(sessions.count())
    if (totalSamples <= MAX_TOTAL_SAMPLES && sessionCount <= MAX_SESSIONS) return NOTHING_PRUNED

    const rows = await this.readSessionRows(transaction)
    const protection: PruneProtection = {
      now,
      heartbeatStaleMs: HEARTBEAT_STALE_MS,
      viewedSessionId: this.viewedSessionId,
    }

    // Eviction needs nothing from the chunks, and discovering that by reading every chunk header
    // would cost a pass over the entire archive on a commit that happens every few minutes. So the
    // plan is made twice: once over the session rows alone, and again — only when the first could
    // not free enough — over the handful of sessions that survived it, which by then are exactly
    // the protected ones. Both passes see the same rows, so both reach the same eviction list.
    const plan = planPrune(
      rows.map((row) => candidateOf(row, NO_CHUNKS)),
      totalSamples,
      protection,
    )
    let freedSamples = 0
    for (const id of plan.evict) freedSamples += await this.evictSession(transaction, id)
    if (plan.projectedTotal <= PRUNE_TARGET) {
      return { evicted: plan.evict, freedSamples, truncatedFrom: null }
    }

    const evicted = new Set<SessionId>(plan.evict)
    const survivors: PruneCandidate[] = []
    for (const row of rows) {
      if (evicted.has(row.id)) continue
      survivors.push(candidateOf(row, await this.chunkExtentsOf(transaction, row.id)))
    }
    const refined = planPrune(survivors, plan.projectedTotal, protection)
    if (refined.truncate === null) return { evicted: plan.evict, freedSamples, truncatedFrom: null }

    freedSamples += await this.truncateSession(transaction, refined.truncate)
    return { evicted: plan.evict, freedSamples, truncatedFrom: refined.truncate.retainedFrom }
  }

  /** Drops a session whole: its row, every chunk, and every warning, or none. Returns what it freed. */
  private async evictSession(transaction: IDBTransaction, id: SessionId): Promise<number> {
    const sessions = transaction.objectStore(SESSIONS)
    const chunks = transaction.objectStore(CHUNKS)
    const stored = await requestAsPromise<SessionRecord | undefined>(sessions.get(id))
    // Cursored through the index, never through a constructed compound key range: a chunk the range
    // missed would outlive its session row, and an unreachable chunk holds budget forever.
    await cursorEach(chunks.index(BY_SESSION).openKeyCursor(IDBKeyRange.only(id)), (cursor) => {
      chunks.delete(cursor.primaryKey)
    })
    const warnings = transaction.objectStore(WARNINGS)
    await cursorEach(warnings.openKeyCursor(IDBKeyRange.bound([id], [id, HIGHEST_SEQ])), (cursor) => {
      warnings.delete(cursor.primaryKey)
    })
    await requestAsPromise(sessions.delete(id))
    return stored?.sealedSamples ?? 0
  }

  /** Cuts the head off one session, which keeps its row and has to say where its data now starts. */
  private async truncateSession(
    transaction: IDBTransaction,
    truncation: PruneTruncation,
  ): Promise<number> {
    const sessions = transaction.objectStore(SESSIONS)
    const chunks = transaction.objectStore(CHUNKS)
    let droppedPack = 0
    let droppedSolar = 0
    for (const reference of truncation.dropChunks) {
      await requestAsPromise(
        chunks.delete([truncation.sessionId, reference.stream, reference.seq]),
      )
      if (reference.stream === PACK_STREAM) droppedPack += 1
      else droppedSolar += 1
    }

    const stored = await requestAsPromise<SessionRecord | undefined>(
      sessions.get(truncation.sessionId),
    )
    if (stored === undefined) return truncation.freedSamples

    const trimmed: SessionRecord = {
      ...stored,
      sealedSamples: Math.max(0, stored.sealedSamples - truncation.freedSamples),
      packChunks: Math.max(0, stored.packChunks - droppedPack),
      solarChunks: Math.max(0, stored.solarChunks - droppedSolar),
      retainedFrom: truncation.retainedFrom,
    }
    await requestAsPromise(sessions.put(trimmed))
    return truncation.freedSamples
  }

  // ── reading rows ───────────────────────────────────────────────────────────

  private async readSessionRows(transaction: IDBTransaction): Promise<SessionRecord[]> {
    const rows: SessionRecord[] = []
    const oldestFirst = transaction.objectStore(SESSIONS).index(BY_STARTED_AT).openCursor()
    await cursorEach(oldestFirst, (cursor) => {
      rows.push(cursor.value as SessionRecord)
    })
    return rows
  }

  private async chunkExtentsOf(
    transaction: IDBTransaction,
    id: SessionId,
  ): Promise<readonly ChunkExtent[]> {
    const extents: ChunkExtent[] = []
    const chunks = transaction.objectStore(CHUNKS).index(BY_SESSION)
    await cursorEach(chunks.openCursor(IDBKeyRange.only(id)), (cursor) => {
      const chunk = cursor.value as HistoryChunk
      extents.push({
        stream: chunk.stream,
        seq: chunk.seq,
        length: chunk.length,
        baseAt: chunk.baseAt,
      })
    })
    return extents
  }

  private async readDevices(
    transaction: IDBTransaction,
    keys: readonly (DeviceKey | null)[],
  ): Promise<Map<DeviceKey, DeviceRecord>> {
    const devices = transaction.objectStore(DEVICES)
    const found = new Map<DeviceKey, DeviceRecord>()
    for (const key of new Set(keys)) {
      if (key === null || found.has(key)) continue
      const record = await requestAsPromise<DeviceRecord | undefined>(devices.get(key))
      if (record !== undefined) found.set(key, record)
    }
    return found
  }

  // ── the counter and the open tail ──────────────────────────────────────────

  /**
   * Marks every unsealed chunk of a session sealed, and reports what that added.
   *
   * A tail is a valid prefix of what the radios said, so closing folds it in rather than discarding
   * it. Running twice folds nothing the second time: there is no unsealed chunk left to find.
   */
  private async sealOpenChunks(
    transaction: IDBTransaction,
    id: SessionId,
  ): Promise<{ samples: number; lastSampleAt: number | null }> {
    const chunks = transaction.objectStore(CHUNKS)
    let samples = 0
    let lastSampleAt: number | null = null
    await cursorEach(chunks.index(BY_SESSION).openCursor(IDBKeyRange.only(id)), (cursor) => {
      const chunk = cursor.value as HistoryChunk
      const endsAt = lastSampleTimeOf(chunk)
      if (endsAt !== null && (lastSampleAt === null || endsAt > lastSampleAt)) lastSampleAt = endsAt
      if (chunk.sealed) return
      samples += chunk.length
      chunks.put({ ...chunk, sealed: true })
    })
    return { samples, lastSampleAt }
  }

  private async readMeta(transaction: IDBTransaction, createdAt: number): Promise<HistoryMeta> {
    const stored = await requestAsPromise<HistoryMeta | undefined>(
      transaction.objectStore(META).get(TOTALS_KEY),
    )
    if (stored !== undefined) return stored
    return {
      key: TOTALS_KEY,
      totalSamples: 0,
      schema: SNAPSHOT_SCHEMA_VERSION,
      createdAt,
      lastPrunedAt: null,
    }
  }

  /** `prunedAt` is the stamp when this write followed an eviction, and null when it did not. */
  private async writeTotal(
    transaction: IDBTransaction,
    meta: HistoryMeta,
    totalSamples: number,
    prunedAt: number | null,
  ): Promise<void> {
    const settled = Math.max(0, totalSamples)
    await requestAsPromise(
      transaction.objectStore(META).put({
        ...meta,
        totalSamples: settled,
        lastPrunedAt: prunedAt ?? meta.lastPrunedAt,
      }),
    )
    this.knownTotal = settled
  }

  /**
   * Lets go of the connection so another tab's upgrade can proceed, and says why the archive went
   * quiet rather than throwing an InvalidStateError out of the next write.
   */
  private standDown(): void {
    this.state = { ...this.state, usable: false, reason: 'version-newer' }
    this.close()
  }
}

function candidateOf(record: SessionRecord, chunks: readonly ChunkExtent[]): PruneCandidate {
  return {
    id: record.id,
    startedAt: record.startedAt,
    sealedSamples: record.sealedSamples,
    state: record.state,
    heartbeatAt: record.heartbeatAt,
    chunks,
  }
}

/**
 * Keeps a rename, and the first sighting, across every later identification of the same device.
 * `userLabel` lives here and not on a session row precisely so one rename covers every session.
 */
function mergeDevice(stored: DeviceRecord, incoming: DeviceRecord): DeviceRecord {
  return {
    ...incoming,
    userLabel: stored.userLabel,
    firstSeenAt: Math.min(stored.firstSeenAt, incoming.firstSeenAt),
    lastSeenAt: Math.max(stored.lastSeenAt, incoming.lastSeenAt),
    sessionCount: Math.max(stored.sessionCount, incoming.sessionCount),
  }
}

function lastSampleTimeOf(chunk: HistoryChunk): number | null {
  if (chunk.length === 0) return null
  return chunk.baseAt + chunk.offsetMs[chunk.length - 1]
}

function overlapsWindow(chunk: HistoryChunk, window: TimeWindow): boolean {
  const endsAt = lastSampleTimeOf(chunk) ?? chunk.baseAt
  return chunk.baseAt <= window.to && endsAt >= window.from
}

function bySeq(left: HistoryChunk, right: HistoryChunk): number {
  return left.seq - right.seq
}
