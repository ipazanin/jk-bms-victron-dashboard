/**
 * The Log on disk. The only IndexedDB adapter in the project.
 *
 * It executes plans and never makes them: what to drop is decided by `planPrune`, what a chunk
 * holds is decided by the column layout, and what a session means is decided by the ledger. This
 * file's whole job is that those decisions land atomically. A session write is one transaction
 * scoped to every session store, because IndexedDB serialises overlapping-scope readwrite
 * transactions across connections on the same origin — which makes commit-plus-prune atomic against
 * a second tab for free, where a read-modify-write split across an await would not be.
 *
 * That same serialisation is why a ring merge is scoped to `RING_STORES` and never to
 * `EVERY_STORE`. The two scopes overlap in nothing but the device row, so an 800-row merge can
 * neither queue behind nor abort a live recording's chunk commit — and the ring keeps no counter in
 * the meta row precisely because a counter there would drag `META` into the scope and put the merge
 * back in the recorder's path.
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
import { MAX_RING_READS_PER_DEVICE, planRingPrune } from '../../domain/history/ringBudget'
import type { RingDeviceExtent, RingEviction } from '../../domain/history/ringBudget'
import { ALIGNMENT_TAIL_RECORDS, foldRingSnapshot } from '../../domain/history/ringLedger'
import { foldSolarHistorySnapshot } from '../../domain/history/solarLedger'
import {
  isPackRecordRow,
  isSolarDayRow,
  isSolarReadRow,
  packReadsIn,
  packRecordsIn,
  readClaimsStoredRows,
  solarDaysIn,
  solarReadsIn,
} from '../../domain/history/storedRows'
import { SOLAR_DAY_FORMAT } from '../../domain/history/StoredRowFormat'
import type { RingLedgerTail } from '../../domain/history/RingLedgerTail'
import type { RingMergeOutcome } from '../../domain/history/RingMergeOutcome'
import type { RingReadRow } from '../../domain/history/RingReadRow'
import type { RingRecordRow } from '../../domain/history/RingRecordRow'
import type { RingSnapshot } from '../../domain/history/RingSnapshot'
import type { SolarHistoryReadRow } from '../../domain/history/SolarHistoryReadRow'
import type { SolarHistorySnapshot } from '../../domain/history/SolarHistorySnapshot'
import type { SolarMergeOutcome } from '../../domain/history/SolarMergeOutcome'
import type { StoredRingLedger } from '../../domain/history/StoredRingLedger'
import type { StoredRingRead } from '../../domain/history/StoredRingRead'
import type { StoredRingRecord } from '../../domain/history/StoredRingRecord'
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
  HistoryUnavailableReason,
  RingIngestOutcome,
  RingLedgerSummary,
  SessionClosure,
  SessionListing,
  SessionPatch,
  SolarHistoryIngestOutcome,
  StoredSession,
} from '../../application/history/port'
import type { ArchiveChannel } from './archiveChannel'
import { classifyWriteFailure, cursorEach, requestAsPromise, runTransaction } from './idb'

export const DATABASE_NAME = 'shunt.log'
export const DATABASE_VERSION = 5

const SESSIONS = 'sessions'
const CHUNKS = 'chunks'
const DEVICES = 'devices'
const META = 'meta'
const WARNINGS = 'warnings'
const RING_RECORDS = 'ringRecords'
const RING_READS = 'ringReads'

/** Everything a session write touches. The ring stores are deliberately not among them. */
const EVERY_STORE = [SESSIONS, CHUNKS, DEVICES, META, WARNINGS]
/** Everything a ring write touches, and nothing a recording does but the device row. */
const RING_STORES = [RING_RECORDS, RING_READS, DEVICES]

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
 * `CHUNK_LAYOUT_VERSION` instead: a chunk keeps the layout it was stamped with, and a build that
 * reads a different one lists it untouched rather than migrating it.
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
  if (oldVersion < 3) {
    // Keyed by the order rows were first seen in, so one device's ledger is a contiguous ascending
    // range and a row's key never changes. Indexed by device as well, so a whole-ledger delete
    // cursors the index rather than a constructed compound range — the same reason evictSession does.
    //
    // Both radios file here. What wrote a row is a field on the row rather than a store of its own:
    // a device key belongs to one radio, so the two never meet inside a ledger, and one store keeps
    // them on one budget, one prune plan and one sweep.
    const records = database.createObjectStore(RING_RECORDS, { keyPath: ['deviceKey', 'seq'] })
    records.createIndex(BY_DEVICE, 'deviceKey')

    // Two stores rather than one: the ledger grows without bound and is folded over, while the
    // journal is a bounded audit trail that is never merged and never charted.
    const reads = database.createObjectStore(RING_READS, { keyPath: ['deviceKey', 'observedAt'] })
    reads.createIndex(BY_DEVICE, 'deviceKey')
  }
  // A version number proves an upgrade ran, not that it built what this code now builds — a
  // database can carry a bumped version from code that no longer exists. So every upgrade ends by
  // re-verifying the stores this schema owns and building whichever are missing, whatever the
  // version pair that got it here.
  if (!database.objectStoreNames.contains(RING_RECORDS)) {
    const records = database.createObjectStore(RING_RECORDS, { keyPath: ['deviceKey', 'seq'] })
    records.createIndex(BY_DEVICE, 'deviceKey')
  }
  if (!database.objectStoreNames.contains(RING_READS)) {
    const reads = database.createObjectStore(RING_READS, { keyPath: ['deviceKey', 'observedAt'] })
    reads.createIndex(BY_DEVICE, 'deviceKey')
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
        // A chunk in a layout this build does not read is handed over rather than dropped, and is
        // not windowed either — its offsets are a column like any other, so this build cannot place
        // it in time. The reader counts it and decodes nothing from it, which is what stops a
        // session full of rows from being reported as empty.
        if (isReadableLayout(chunk.layout) && !overlapsWindow(chunk, held.window)) return
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
        // Unlike readSession, an unreadable chunk stops here: this feeds the export, which writes
        // decoded rows and has no row it could write from a layout it cannot decode.
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

  // ── what the devices themselves recorded ───────────────────────────────────

  async appendRingSnapshot(snapshot: RingSnapshot): Promise<RingIngestOutcome> {
    if (!this.connected) return refusedIngest(this.state.reason)
    try {
      const ingested = await this.mergeRing(snapshot)
      this.channel.post('ring-read')
      return ingested
    } catch (error) {
      // No retry, and no room made. A ring write may not evict sessions — the two budgets cannot
      // reach each other, which is the whole reason the ledger is its own store — and its own prune
      // has already run inside the transaction that failed, so a second attempt would free exactly
      // nothing. The read stays on screen, unfiled, carrying the reason.
      return refusedIngest(classifyWriteFailure(error) === 'quota' ? 'quota-exhausted' : null)
    }
  }

  async appendSolarHistory(snapshot: SolarHistorySnapshot): Promise<SolarHistoryIngestOutcome> {
    if (!this.connected) return refusedSolarIngest(this.state.reason)
    try {
      const ingested = await this.mergeSolarHistory(snapshot)
      this.channel.post('ring-read')
      return ingested
    } catch (error) {
      // No retry and no room made, for the reason a refused ring merge gets neither: the two budgets
      // cannot reach each other, and this write's own prune has already run inside the transaction
      // that failed.
      return refusedSolarIngest(classifyWriteFailure(error) === 'quota' ? 'quota-exhausted' : null)
    }
  }

  async readRingLedger(deviceKey: DeviceKey): Promise<StoredRingLedger | null> {
    if (!this.connected) return null
    return runTransaction(this.database, RING_STORES, 'readonly', async (transaction) => {
      const rows = await this.readRingRows(transaction, deviceKey)
      const journal = await this.readRingJournal(transaction, deviceKey)
      // A read that answered nothing still has a journal row, and that row is the only evidence
      // there is about it — so a ledger holding no record is still a ledger.
      if (rows.length === 0 && journal.length === 0) return null

      const device = await requestAsPromise<DeviceRecord | undefined>(
        transaction.objectStore(DEVICES).get(deviceKey),
      )
      // Separated by what each row says it is, never by what the device key looks like: the format
      // is on the row, and a key is a string somebody chose.
      return {
        deviceKey,
        records: packRecordsIn(rows),
        solarDays: solarDaysIn(rows),
        reads: packReadsIn(journal),
        solarReads: solarReadsIn(journal),
        device: device ?? null,
        retainedFromSeq: retainedFromSeqOf(rows),
      }
    })
  }

  async listRingLedgers(): Promise<readonly RingLedgerSummary[]> {
    if (!this.connected) return []
    return runTransaction(this.database, RING_STORES, 'readonly', async (transaction) => {
      const summaries: RingLedgerSummary[] = []
      for (const deviceKey of await this.ringDeviceKeys(transaction)) {
        const device = await requestAsPromise<DeviceRecord | undefined>(
          transaction.objectStore(DEVICES).get(deviceKey),
        )
        const oldest = await this.edgeRingRow(transaction, deviceKey, 'next')
        const newest = await this.edgeRingRow(transaction, deviceKey, 'prev')
        const newestRead = await this.newestRingRead(transaction, deviceKey)
        summaries.push({
          deviceKey,
          kind: ledgerKindOf(newest ?? oldest, newestRead),
          label: deviceLabel(device ?? null),
          records: await this.countRingRecords(transaction, deviceKey),
          lastReadAt: newestRead?.observedAt ?? 0,
          // The pack's own clock face, not wall time, so this row is honest with no correction
          // behind it. A ledger holding no pack record answers zero rather than inventing a face,
          // and a controller's ledger answers zero because it keeps no clock face at all.
          oldestPackClockSeconds: packClockFaceOf(oldest),
          newestPackClockSeconds: packClockFaceOf(newest),
        })
      }
      return summaries.sort((left, right) => right.lastReadAt - left.lastReadAt)
    })
  }

  async setPackClock(
    deviceKey: DeviceKey,
    clock: {
      readonly utcOffsetMinutes: number | null
      readonly aheadSeconds: number | null
    },
  ): Promise<DeviceRecord | null> {
    if (!this.connected) return null
    const answered = await runTransaction(
      this.database,
      [DEVICES],
      'readwrite',
      // Read and write as one transaction, exactly as renameDevice does, so two tabs answering at
      // once cannot interleave into a lost update.
      async (transaction) => {
        const devices = transaction.objectStore(DEVICES)
        const stored = await requestAsPromise<DeviceRecord | undefined>(devices.get(deviceKey))
        if (stored === undefined) return null
        // Written verbatim, null included: the owner may take an answer back, and nothing else may.
        const updated: DeviceRecord = {
          ...stored,
          packUtcOffsetMinutes: clock.utcOffsetMinutes,
          packClockAheadSeconds: clock.aheadSeconds,
        }
        await requestAsPromise(devices.put(updated))
        return updated
      },
    )
    if (answered !== null) this.channel.post('ring-read')
    return answered
  }

  async deleteRingLedger(deviceKey: DeviceKey): Promise<void> {
    if (!this.connected) return
    await runTransaction(this.database, RING_STORES, 'readwrite', async (transaction) => {
      // Rows and journal die together; the device row survives, because it is the label and it
      // carries the owner's answers about this pack's clock.
      await this.dropRingLedger(transaction, deviceKey)
    })
    this.channel.post('ring-read')
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
    // Its own ring-scoped transaction, so the recovery write stays out of the ring stores and the
    // ring sweep stays out of the recorder's way.
    const strandedJournals = await this.sweepRingJournals()
    if (swept.closed > 0) this.channel.post('session-closed')
    return { ...swept, orphansRemoved: swept.orphansRemoved + strandedJournals }
  }

  async usage(): Promise<{
    readonly totalSamples: number
    readonly sessions: number
    readonly ringRecords: number
  }> {
    if (!this.connected) return { totalSamples: this.knownTotal, sessions: 0, ringRecords: 0 }
    return runTransaction(
      this.database,
      [SESSIONS, META, RING_RECORDS],
      'readonly',
      async (transaction) => {
        const meta = await this.readMeta(transaction, 0)
        const sessions = await requestAsPromise<number>(transaction.objectStore(SESSIONS).count())
        // Its own line, because ring rows are on their own budget: `planPrune` never sees one and
        // no ring write ever moved the counter this reads.
        const ringRecords = await requestAsPromise<number>(
          transaction.objectStore(RING_RECORDS).count(),
        )
        this.knownTotal = meta.totalSamples
        return { totalSamples: meta.totalSamples, sessions, ringRecords }
      },
    )
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

  // ── folding a ring read in ─────────────────────────────────────────────────

  /**
   * The whole merge as one write: place the read, append what is new, journal the attempt, and
   * carry out whatever the ring budget decided.
   *
   * Nothing here reads or writes a session store, the meta row or a chunk. That is not an oversight
   * to tidy up later — it is the property that keeps an 800-row merge off the recorder's critical
   * path, and it is why per-device counts come from `count()` over a key range rather than from a
   * counter somebody would have to keep in `meta`.
   */
  private mergeRing(snapshot: RingSnapshot): Promise<RingIngestOutcome> {
    return runTransaction(this.database, RING_STORES, 'readwrite', async (transaction) => {
      const records = transaction.objectStore(RING_RECORDS)
      const tail = await this.readRingTail(transaction, snapshot.deviceKey)
      // The read's own wall clock stamps the rows it creates: `firstReadAt` is provenance, and this
      // store has no clock of its own that would be truer than the one the transfer arrived under.
      const folded = foldRingSnapshot(tail, snapshot, snapshot.observedAt)
      for (const row of folded.rows) await requestAsPromise(records.put(row))

      await this.journalRead(transaction, snapshot, folded.merge, [...tail.rows, ...folded.rows])
      const prunedRecords = await this.pruneRing(transaction)

      return {
        ...folded.merge,
        stored: true,
        totalRecords: await this.countRingRecords(transaction, snapshot.deviceKey),
        prunedRecords,
        failure: null,
      }
    })
  }

  /**
   * The whole sweep as one write, shaped exactly like the ring merge above and sharing its stores,
   * its journal cap and its prune.
   *
   * The fold is handed every day this ledger holds rather than a tail. A controller's ledger grows
   * one row a day, so the whole of it is a few hundred rows where the pack's is twenty thousand —
   * and matching a day by its sequence number needs a neighbourhood in DATE, which a tail cut by row
   * count could only guess at.
   */
  private mergeSolarHistory(snapshot: SolarHistorySnapshot): Promise<SolarHistoryIngestOutcome> {
    return runTransaction(this.database, RING_STORES, 'readwrite', async (transaction) => {
      const records = transaction.objectStore(RING_RECORDS)
      const stored = solarDaysIn(await this.readRingRows(transaction, snapshot.deviceKey))
      // The sweep's own wall clock stamps the rows it creates and revises, for the reason a ring
      // merge uses the read's: this store has no clock truer than the one the sweep arrived under.
      const folded = foldSolarHistorySnapshot(stored, snapshot, snapshot.observedAt)
      for (const row of folded.rows) await requestAsPromise(records.put(row))

      await this.journalSolarSweep(transaction, snapshot, folded.merge)
      const prunedRecords = await this.pruneRing(transaction)

      return {
        ...folded.merge,
        stored: true,
        // Every row under a controller's key is a day row, so the range count is the day count.
        totalDays: await this.countRingRecords(transaction, snapshot.deviceKey),
        prunedRecords,
        failure: null,
      }
    })
  }

  /**
   * As much of the ledger's newest end as the merge needs to place a read against it.
   *
   * Read backwards from the head and turned round, because alignment only ever succeeds near the
   * head: the ring drops from its own tail, so a read can never reach further back than what the
   * pack still holds.
   *
   * `nextSeq` counts from the newest row of ANY format while the tail carries pack records only. A
   * device key belongs to one radio, so the two can only coincide in a corrupt archive — and there
   * the reading that hands out a seq nothing else holds is the one that cannot lose a row.
   */
  private async readRingTail(
    transaction: IDBTransaction,
    deviceKey: DeviceKey,
  ): Promise<RingLedgerTail> {
    const rows: RingRecordRow[] = []
    let highestSeq: number | null = null
    const newestFirst = transaction
      .objectStore(RING_RECORDS)
      .openCursor(ringRangeOf(deviceKey), 'prev')
    await cursorEach(newestFirst, (cursor) => {
      if (rows.length >= ALIGNMENT_TAIL_RECORDS) return false
      const row = cursor.value as StoredRingRecord
      if (highestSeq === null) highestSeq = row.seq
      if (isPackRecordRow(row)) rows.push(row)
    })
    rows.reverse()
    // A ledger whose head was pruned still hands out seq above everything it ever stored; one
    // emptied outright starts again at zero, because nothing is left to count from.
    return { nextSeq: highestSeq === null ? 0 : highestSeq + 1, rows }
  }

  /**
   * One journal row per read, whatever the read established, capped at the newest few.
   *
   * The key is [deviceKey, observedAt], so two reads at the same millisecond collide into one row
   * rather than accumulating — which is the same thing the memory store does, for the same reason.
   */
  private async journalRead(
    transaction: IDBTransaction,
    snapshot: RingSnapshot,
    merge: RingMergeOutcome,
    ledger: readonly RingRecordRow[],
  ): Promise<void> {
    const reads = transaction.objectStore(RING_READS)
    const anchor = newestScheduledRecord(snapshot)
    const row: RingReadRow = {
      deviceKey: snapshot.deviceKey,
      observedAt: snapshot.observedAt,
      outcome: snapshot.outcome,
      notificationBytes: snapshot.transport.notificationBytes,
      notificationCount: snapshot.transport.notificationCount,
      assembledFrameCount: snapshot.transport.assembledFrameCount,
      logFrameCount: snapshot.transport.logFrameCount,
      indexSpan: indexSpanOf(snapshot),
      recordsReceived: recordsReceivedIn(snapshot),
      recordsAppended: merge.appended,
      overlap: merge.overlap,
      ringShift: merge.ringShift,
      gapDeclared: merge.gapDeclared,
      runsDiscarded: merge.runsDiscarded,
      newestSampleCounter: anchor === null ? null : counterIn(anchor),
      newestSampleSeq: anchor === null ? null : seqOfBytes(ledger, anchor),
      elapsedMs: snapshot.transport.elapsedMs,
    }
    await requestAsPromise(reads.put(row))
    await this.capRingJournal(transaction, snapshot.deviceKey)
  }

  /**
   * One journal row per sweep, whatever the sweep established, under the same cap and in the same
   * store as a pack's.
   */
  private async journalSolarSweep(
    transaction: IDBTransaction,
    snapshot: SolarHistorySnapshot,
    merge: SolarMergeOutcome,
  ): Promise<void> {
    const row: SolarHistoryReadRow = {
      deviceKey: snapshot.deviceKey,
      observedAt: snapshot.observedAt,
      format: SOLAR_DAY_FORMAT,
      outcome: snapshot.outcome,
      readOnDate: snapshot.readOnDate,
      totals: snapshot.totals,
      daysReceived: snapshot.days.length,
      daysAppended: merge.appended,
      daysRevised: merge.revised,
      daysUnchanged: merge.unchanged,
      daysUnwritten: merge.unwritten,
      daysRedated: merge.redated,
      refusedRegisters: snapshot.transport.refusedRegisters,
      notificationBytes: snapshot.transport.notificationBytes,
      notificationCount: snapshot.transport.notificationCount,
      controlNotificationCount: snapshot.transport.controlNotificationCount,
      pduCount: snapshot.transport.pduCount,
      unreadableReplyCount: snapshot.transport.unreadableReplyCount,
      elapsedMs: snapshot.transport.elapsedMs,
    }
    await requestAsPromise(transaction.objectStore(RING_READS).put(row))
    await this.capRingJournal(transaction, snapshot.deviceKey)
  }

  /** Keeps one device's journal to its newest few, oldest dropped first. */
  private async capRingJournal(
    transaction: IDBTransaction,
    deviceKey: DeviceKey,
  ): Promise<void> {
    const reads = transaction.objectStore(RING_READS)
    const held = await requestAsPromise<number>(reads.count(ringRangeOf(deviceKey)))
    let over = held - MAX_RING_READS_PER_DEVICE
    if (over <= 0) return
    await cursorEach(reads.openKeyCursor(ringRangeOf(deviceKey)), (cursor) => {
      if (over <= 0) return false
      reads.delete(cursor.primaryKey)
      over -= 1
    })
  }

  /** Carries out what `planRingPrune` decided, and answers with every row it gave up. */
  private async pruneRing(transaction: IDBTransaction): Promise<number> {
    const plan = planRingPrune(await this.ringExtents(transaction))
    let freed = 0

    for (const deviceKey of plan.dropWhole) {
      freed += await this.countRingRecords(transaction, deviceKey)
      await this.dropRingLedger(transaction, deviceKey)
    }
    for (const eviction of plan.trim) freed += await this.trimRingLedger(transaction, eviction)

    return freed
  }

  private async ringExtents(transaction: IDBTransaction): Promise<RingDeviceExtent[]> {
    const extents: RingDeviceExtent[] = []
    for (const deviceKey of await this.ringDeviceKeys(transaction)) {
      extents.push({
        deviceKey,
        records: await this.countRingRecords(transaction, deviceKey),
        oldestSeq: (await this.edgeRingRow(transaction, deviceKey, 'next'))?.seq ?? 0,
        lastReadAt: await this.lastReadAtOf(transaction, deviceKey),
      })
    }
    return extents
  }

  /** Cuts the head off one ledger, which then has to say that its oldest row follows a break. */
  private async trimRingLedger(
    transaction: IDBTransaction,
    eviction: RingEviction,
  ): Promise<number> {
    const records = transaction.objectStore(RING_RECORDS)
    const doomed = IDBKeyRange.bound(
      [eviction.deviceKey],
      [eviction.deviceKey, eviction.fromSeq],
      false,
      true,
    )
    let freed = 0
    await cursorEach(records.openKeyCursor(doomed), (cursor) => {
      records.delete(cursor.primaryKey)
      freed += 1
    })

    // The surviving pack record declares the break, exactly as `retainedFrom` does for a truncated
    // session: what came before it is gone, and nothing may read the ledger as contiguous across it.
    // A day record carries no such field and needs none — a calendar-keyed row states its own
    // position, so a hole in a controller's ledger is visible as a missing date.
    const survivors = records.openCursor(
      IDBKeyRange.bound([eviction.deviceKey, eviction.fromSeq], [eviction.deviceKey, HIGHEST_SEQ]),
    )
    await cursorEach(survivors, (cursor) => {
      const row = cursor.value as StoredRingRecord
      if (isPackRecordRow(row) && !row.followsGap) records.put({ ...row, followsGap: true })
      return false
    })
    return freed
  }

  /**
   * Removes journal rows for a pack whose ledger is gone but whose reads say it held records.
   *
   * A ledger and its journal die inside one transaction, so nothing this adapter does can strand
   * one — but a database left half-written by something else can, and those rows are unreachable
   * budget. A journal whose every read carried nothing is not stranded at all: it is the receipt
   * for a pack that answered nothing, which is exactly the read most worth keeping.
   */
  private sweepRingJournals(): Promise<number> {
    return runTransaction(this.database, RING_STORES, 'readwrite', async (transaction) => {
      const reads = transaction.objectStore(RING_READS)
      let removed = 0
      for (const deviceKey of await this.ringDeviceKeys(transaction)) {
        if ((await this.countRingRecords(transaction, deviceKey)) > 0) continue
        const journal = await this.readRingJournal(transaction, deviceKey)
        if (!journal.some(readClaimsStoredRows)) continue

        await cursorEach(reads.openKeyCursor(ringRangeOf(deviceKey)), (cursor) => {
          reads.delete(cursor.primaryKey)
          removed += 1
        })
      }
      return removed
    })
  }

  // ── reading a ring ledger ──────────────────────────────────────────────────

  private async readRingRows(
    transaction: IDBTransaction,
    deviceKey: DeviceKey,
  ): Promise<StoredRingRecord[]> {
    const rows: StoredRingRecord[] = []
    const ascending = transaction.objectStore(RING_RECORDS).openCursor(ringRangeOf(deviceKey))
    await cursorEach(ascending, (cursor) => {
      rows.push(cursor.value as StoredRingRecord)
    })
    return rows
  }

  /** Newest read first, capped: the journal is an audit trail rather than a series. */
  private async readRingJournal(
    transaction: IDBTransaction,
    deviceKey: DeviceKey,
  ): Promise<StoredRingRead[]> {
    const reads: StoredRingRead[] = []
    const newestFirst = transaction
      .objectStore(RING_READS)
      .openCursor(ringRangeOf(deviceKey), 'prev')
    await cursorEach(newestFirst, (cursor) => {
      if (reads.length >= MAX_RING_READS_PER_DEVICE) return false
      reads.push(cursor.value as StoredRingRead)
    })
    return reads
  }

  /** The newest receipt filed against one device, whichever radio it was against. */
  private async newestRingRead(
    transaction: IDBTransaction,
    deviceKey: DeviceKey,
  ): Promise<StoredRingRead | null> {
    let found: StoredRingRead | null = null
    const newestFirst = transaction
      .objectStore(RING_READS)
      .openCursor(ringRangeOf(deviceKey), 'prev')
    await cursorEach(newestFirst, (cursor) => {
      found = cursor.value as StoredRingRead
      return false
    })
    return found
  }

  /** Every pack with a ledger or a journal, which is every pack a read was ever filed against. */
  private async ringDeviceKeys(transaction: IDBTransaction): Promise<DeviceKey[]> {
    const keys = new Set<DeviceKey>()
    for (const storeName of [RING_RECORDS, RING_READS]) {
      // One entry per distinct index key, so enumerating the packs costs the packs and not the rows.
      const distinct = transaction
        .objectStore(storeName)
        .index(BY_DEVICE)
        .openKeyCursor(null, 'nextunique')
      await cursorEach(distinct, (cursor) => {
        keys.add(cursor.key as DeviceKey)
      })
    }
    return [...keys]
  }

  private countRingRecords(transaction: IDBTransaction, deviceKey: DeviceKey): Promise<number> {
    return requestAsPromise<number>(
      transaction.objectStore(RING_RECORDS).count(ringRangeOf(deviceKey)),
    )
  }

  /** The oldest or newest row of one ledger, without hydrating the rows between them. */
  private async edgeRingRow(
    transaction: IDBTransaction,
    deviceKey: DeviceKey,
    direction: IDBCursorDirection,
  ): Promise<StoredRingRecord | null> {
    let found: StoredRingRecord | null = null
    const cursor = transaction
      .objectStore(RING_RECORDS)
      .openCursor(ringRangeOf(deviceKey), direction)
    await cursorEach(cursor, (each) => {
      found = each.value as StoredRingRecord
      return false
    })
    return found
  }

  private async lastReadAtOf(transaction: IDBTransaction, deviceKey: DeviceKey): Promise<number> {
    let observedAt = 0
    const newestFirst = transaction
      .objectStore(RING_READS)
      .openKeyCursor(ringRangeOf(deviceKey), 'prev')
    await cursorEach(newestFirst, (cursor) => {
      observedAt = (cursor.key as [DeviceKey, number])[1]
      return false
    })
    return observedAt
  }

  private async dropRingLedger(
    transaction: IDBTransaction,
    deviceKey: DeviceKey,
  ): Promise<void> {
    // Cursored through the index, never through a constructed compound key range: a row the range
    // missed would outlive the ledger it belongs to and hold its share of the budget forever.
    for (const storeName of [RING_RECORDS, RING_READS]) {
      const store = transaction.objectStore(storeName)
      await cursorEach(store.index(BY_DEVICE).openKeyCursor(IDBKeyRange.only(deviceKey)), (cursor) => {
        store.delete(cursor.primaryKey)
      })
    }
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
 *
 * The two pack-clock fields are kept under the same rule and for the same reason: they are the
 * owner's own answers, nothing derives them, and only `setPackClock` may change one. A reconnect
 * that quietly cleared them would be silent data loss rather than a visible one.
 */
function mergeDevice(stored: DeviceRecord, incoming: DeviceRecord): DeviceRecord {
  return {
    ...incoming,
    userLabel: stored.userLabel,
    packUtcOffsetMinutes: stored.packUtcOffsetMinutes,
    packClockAheadSeconds: stored.packClockAheadSeconds,
    firstSeenAt: Math.min(stored.firstSeenAt, incoming.firstSeenAt),
    lastSeenAt: Math.max(stored.lastSeenAt, incoming.lastSeenAt),
    sessionCount: Math.max(stored.sessionCount, incoming.sessionCount),
  }
}

/**
 * One pack's rows as a contiguous key range, in either ring store: both are keyed [deviceKey, n] —
 * a seq in the ledger, a wall clock in the journal. `[key]` sorts below every `[key, n]`.
 */
function ringRangeOf(deviceKey: DeviceKey): IDBKeyRange {
  return IDBKeyRange.bound([deviceKey], [deviceKey, Number.MAX_SAFE_INTEGER])
}

/**
 * Where a pruned ledger now begins, derived rather than stored.
 *
 * A ledger nothing has cut is dense from zero, because the fold numbers a pack's first read from
 * there. So an oldest row above zero is exactly what pruning left behind, and there is no separate
 * marker to keep in step with the rows it describes.
 */
function retainedFromSeqOf(records: readonly StoredRingRecord[]): number | null {
  const oldest = records[0]
  return oldest === undefined || oldest.seq === 0 ? null : oldest.seq
}

/** Which radio a ledger belongs to, read off a row it holds rather than off a device row it may
 *  outlive. A ledger with neither a row nor a receipt does not list at all. */
function ledgerKindOf(
  row: StoredRingRecord | null,
  read: StoredRingRead | null,
): DeviceRecord['kind'] {
  if (row !== null) return isSolarDayRow(row) ? 'solar' : 'pack'
  if (read !== null && isSolarReadRow(read)) return 'solar'
  return 'pack'
}

/** The pack clock a row carries, or zero for a row that keeps no clock face. */
function packClockFaceOf(row: StoredRingRecord | null): number {
  return row !== null && isPackRecordRow(row) ? row.packClockSeconds : 0
}

function refusedIngest(failure: HistoryUnavailableReason | null): RingIngestOutcome {
  return {
    stored: false,
    appended: 0,
    overlap: 0,
    ringShift: null,
    gapDeclared: false,
    runsDiscarded: 0,
    totalRecords: 0,
    prunedRecords: 0,
    failure,
  }
}

function refusedSolarIngest(failure: HistoryUnavailableReason | null): SolarHistoryIngestOutcome {
  return {
    stored: false,
    appended: 0,
    revised: 0,
    unchanged: 0,
    unwritten: 0,
    redated: 0,
    totalDays: 0,
    prunedRecords: 0,
    failure,
  }
}

/** Where the event code sits in a record, and the value that means "nothing happened". */
const EVENT_CODE_BYTE = 4
const SCHEDULED_SAMPLE = 0

function recordsReceivedIn(snapshot: RingSnapshot): number {
  return snapshot.runs.reduce((total, run) => total + run.records.length, 0)
}

function indexSpanOf(snapshot: RingSnapshot): { readonly from: number; readonly to: number } | null {
  let from: number | null = null
  let to: number | null = null

  for (const run of snapshot.runs) {
    if (run.records.length === 0) continue
    const last = run.firstIndex + run.records.length - 1
    if (from === null || run.firstIndex < from) from = run.firstIndex
    if (to === null || last > to) to = last
  }

  return from === null || to === null ? null : { from, to }
}

/**
 * The newest scheduled record the read carried — the read's one clock anchor.
 *
 * Newest by ring index rather than by counter: after a backward rewrite the counter runs down, and
 * the whole point of the anchor is to place the read against the face in force at the time.
 */
function newestScheduledRecord(snapshot: RingSnapshot): Uint8Array | null {
  let newestIndex = Number.NEGATIVE_INFINITY
  let newest: Uint8Array | null = null

  for (const run of snapshot.runs) {
    for (let position = 0; position < run.records.length; position += 1) {
      const bytes = run.records[position]
      if (bytes[EVENT_CODE_BYTE] !== SCHEDULED_SAMPLE) continue
      const index = run.firstIndex + position
      if (index <= newestIndex) continue
      newestIndex = index
      newest = bytes
    }
  }

  return newest
}

/**
 * Where the anchor landed in the ledger, found by matching the bytes from the newest end.
 *
 * Adjacent records are byte-identical often enough that this can land on either half of such a
 * pair. Both halves carry the same counter and sit in the same clock segment, so which one is
 * named changes nothing the field is read for; and a run of identical rows is indistinguishable by
 * construction, so there is no better answer to be had.
 */
function seqOfBytes(ledger: readonly RingRecordRow[], bytes: Uint8Array): number | null {
  for (let at = ledger.length - 1; at >= 0; at -= 1) {
    if (sameBytes(ledger[at].bytes, bytes)) return ledger[at].seq
  }
  return null
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let at = 0; at < left.length; at += 1) {
    if (left[at] !== right[at]) return false
  }
  return true
}

function counterIn(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
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
