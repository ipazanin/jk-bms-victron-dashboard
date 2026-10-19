import { isReadableLayout, sampleBytes } from '../../domain/history/columns'
import { deviceLabel } from '../../domain/history/identity'
import { MAX_SESSIONS, MAX_SESSION_HOURS, COMPACT_RETENTION_MS, planRawPrune, retainedCoverage } from '../../domain/history/budget'
import type { RawChunkExtent } from '../../domain/history/budget'
import type { SessionHour } from '../../domain/history/SessionHour'
import { compactSessionInTransaction } from './compactSession'
import { localRawCapacityBytes } from '../../application/history/localCapacity'
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
export const DATABASE_VERSION = 6

const SESSIONS = 'sessions'
const CHUNKS = 'chunks'
const HOURS = 'sessionHours'
const DEVICES = 'devices'

export const META = 'meta'
const WARNINGS = 'warnings'
const RING_RECORDS = 'ringRecords'
const RING_READS = 'ringReads'

const EVERY_STORE = [SESSIONS, CHUNKS, DEVICES, META, WARNINGS, HOURS]

const RING_STORES = [RING_RECORDS, RING_READS, DEVICES]

const BY_STARTED_AT = 'byStartedAt'
const BY_DEVICE = 'byDevice'
const BY_STATE = 'byState'
const BY_SESSION = 'bySession'
const BY_LAST_SEEN = 'byLastSeen'
const BY_TIME = 'byTime'

export const TOTALS_KEY = 'totals'

const HIGHEST_SEQ = Number.MAX_SAFE_INTEGER

interface PruneExecution {
  readonly evicted: readonly SessionId[]
  readonly freedSamples: number
  readonly freedBytes: number
  readonly truncatedFrom: number | null
}

export function applySchema(database: IDBDatabase, oldVersion: number): void {
  if (!database.objectStoreNames.contains(HOURS)) {
    const hours = database.createObjectStore(HOURS, { keyPath: ['sessionId', 'hourStart'] })
    hours.createIndex(BY_SESSION, 'sessionId')
    hours.createIndex(BY_TIME, 'hourStart')
  }
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
    const warnings = database.createObjectStore(WARNINGS, { keyPath: ['sessionId', 'seq'] })
    warnings.createIndex(BY_TIME, 'at')
  }
  if (oldVersion < 3) {
    const records = database.createObjectStore(RING_RECORDS, { keyPath: ['deviceKey', 'seq'] })
    records.createIndex(BY_DEVICE, 'deviceKey')

    const reads = database.createObjectStore(RING_READS, { keyPath: ['deviceKey', 'observedAt'] })
    reads.createIndex(BY_DEVICE, 'deviceKey')
  }

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

  private readonly watchers = new Set<() => void>()
  private state: HistoryAvailability

  private viewedSessionId: SessionId | null

  private knownTotal: number
  private connected: boolean
  private readonly rawCapacityBytes: () => number

  constructor(database: IDBDatabase, availability: HistoryAvailability, channel: ArchiveChannel, rawCapacityBytes: () => number = localRawCapacityBytes) {
    this.database = database
    this.rawCapacityBytes = rawCapacityBytes
    this.channel = channel
    this.state = availability
    this.viewedSessionId = null
    this.knownTotal = 0
    this.connected = true

    database.onversionchange = () => this.standDown()
  }

  get availability(): HistoryAvailability {
    return this.state
  }

  reportPersistence(persisted: boolean): void {
    if (!this.connected || this.state.persisted === persisted) return
    this.state = { ...this.state, persisted }
    for (const watcher of [...this.watchers]) watcher()
  }

  async openSession(record: SessionRecord): Promise<void> {
    if (!this.connected) return
    await runTransaction(this.database, [SESSIONS], 'readwrite', async (transaction) => {
      await requestAsPromise(transaction.objectStore(SESSIONS).put(record))
    })
    this.channel.post('session-opened')
  }

  async commitChunk(chunk: HistoryChunk, patch: SessionPatch, hours: readonly SessionHour[] = []): Promise<CommitOutcome> {
    try {
      return this.announce(await this.writeChunk(chunk, patch, hours))
    } catch (error) {
      if (classifyWriteFailure(error) !== 'quota') return this.refusedCommit(null)

      await this.pruneToBudget(patch.heartbeatAt).catch(() => undefined)
      try {
        return this.announce(await this.writeChunk(chunk, patch, hours))
      } catch (retried) {
        if (classifyWriteFailure(retried) !== 'quota') return this.refusedCommit(null)
        this.reportUnusable('quota-exhausted')
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
        coverage: retainedCoverage(closure.coverage, stored.retainedFrom),
        state: 'closed',
        sealedSamples: stored.sealedSamples + folded.samples,
      }
      await requestAsPromise(sessions.put(closed))

      const meta = await this.readMeta(transaction, closure.endedAt)
      await this.writeTotal(transaction, meta, meta.totalSamples + folded.samples, null)
    })
    this.channel.post('session-closed')
  }

  async deleteSession(id: SessionId, now: number = Date.now()): Promise<void> {
    if (!this.connected) return
    await runTransaction(this.database, EVERY_STORE, 'readwrite', async (transaction) => {
      const metaBefore = await this.readMeta(transaction, now)
      const bytesBefore = await this.rawBytesIn(transaction, metaBefore)
      let removedBytes = 0
      await cursorEach(transaction.objectStore(CHUNKS).index(BY_SESSION).openCursor(id), (cursor) => {
        const chunk = cursor.value as HistoryChunk
        removedBytes += chunk.length * sampleBytes(chunk.stream)
      })
      const freed = await this.evictSession(transaction, id)
      await this.writeTotal(transaction, { ...metaBefore, rawBytes: bytesBefore - removedBytes }, metaBefore.totalSamples - freed, now)
    })
    this.channel.post('pruned')
  }

  async appendWarning(record: WarningRecord): Promise<void> {
    if (!this.connected) return
    await runTransaction(this.database, [WARNINGS], 'readwrite', async (transaction) => {
      await requestAsPromise(transaction.objectStore(WARNINGS).put(record))
    })
    this.announceWarning()
  }

  private announceWarning(): void {
    this.channel.post('warning-filed')
    for (const watcher of [...this.watchers]) watcher()
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
    return runTransaction(this.database, [SESSIONS, CHUNKS, DEVICES, HOURS], 'readonly', async (tx) => {
      const record = await requestAsPromise<SessionRecord | undefined>(
        tx.objectStore(SESSIONS).get(id),
      )
      if (record === undefined) return null

      const available = {
        from: record.startedAt,
        to: record.endedAt ?? record.heartbeatAt,
      }
      const held = renderWindowFor(available, window)
      const pack: PackChunk[] = []
      const solar: SolarChunk[] = []
      const chunks = tx.objectStore(CHUNKS).index(BY_SESSION).openCursor(IDBKeyRange.only(id))
      await cursorEach(chunks, (cursor) => {
        const chunk = cursor.value as HistoryChunk

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
        hours: await requestAsPromise<SessionHour[]>(tx.objectStore(HOURS).index(BY_SESSION).getAll(id)),
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

      async (transaction) => {
        const devices = transaction.objectStore(DEVICES)
        const stored = await requestAsPromise<DeviceRecord | undefined>(devices.get(key))
        if (stored === undefined) return null
        const chosen = label?.trim() ?? ''

        const updated: DeviceRecord = { ...stored, userLabel: chosen === '' ? null : chosen }
        await requestAsPromise(devices.put(updated))
        return updated
      },
    )
    if (renamed !== null) this.channel.post('device-renamed')
    return renamed
  }

  async appendRingSnapshot(snapshot: RingSnapshot): Promise<RingIngestOutcome> {
    if (!this.connected) return refusedIngest(this.state.reason)
    try {
      const ingested = await this.mergeRing(snapshot)
      this.channel.post('ring-read')
      return ingested
    } catch (error) {
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
      return refusedSolarIngest(classifyWriteFailure(error) === 'quota' ? 'quota-exhausted' : null)
    }
  }

  async readRingLedger(deviceKey: DeviceKey): Promise<StoredRingLedger | null> {
    if (!this.connected) return null
    return runTransaction(this.database, RING_STORES, 'readonly', async (transaction) => {
      const rows = await this.readRingRows(transaction, deviceKey)
      const journal = await this.readRingJournal(transaction, deviceKey)

      if (rows.length === 0 && journal.length === 0) return null

      const device = await requestAsPromise<DeviceRecord | undefined>(
        transaction.objectStore(DEVICES).get(deviceKey),
      )

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

      async (transaction) => {
        const devices = transaction.objectStore(DEVICES)
        const stored = await requestAsPromise<DeviceRecord | undefined>(devices.get(deviceKey))
        if (stored === undefined) return null

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
      await this.dropRingLedger(transaction, deviceKey)
    })
    this.channel.post('ring-read')
  }

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
          const hasHours = await requestAsPromise<number>(transaction.objectStore(HOURS).index(BY_SESSION).count(record.id)) > 0
          if (sealedSamples === 0 && record.packSamples + record.solarSamples === 0 && !hasHours) {
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

        await cursorEach(chunks.index(BY_SESSION).openKeyCursor(), (cursor) => {
          if (surviving.has(cursor.key as SessionId)) return
          chunks.delete(cursor.primaryKey)
          orphansRemoved += 1
        })

        const warnings = transaction.objectStore(WARNINGS)
        await cursorEach(warnings.openKeyCursor(), (cursor) => {
          const [sessionId] = cursor.primaryKey as [SessionId, number]
          if (!surviving.has(sessionId)) warnings.delete(cursor.primaryKey)
        })

        await cursorEach(transaction.objectStore(HOURS).index(BY_SESSION).openKeyCursor(), (cursor) => {
          if (!surviving.has(cursor.key as string)) transaction.objectStore(HOURS).delete(cursor.primaryKey)
        })
        const meta = await this.readMeta(transaction, now)
        const rawBytes = await this.rawBytesIn(transaction, meta, true)
        const pruned = await this.prune(transaction, rawBytes, now)
        await this.writeTotal(transaction, { ...meta, rawBytes: rawBytes - pruned.freedBytes }, totalSamples - pruned.freedSamples, pruned.freedSamples > 0 ? now : null)
        return { closed, orphansRemoved }
      },
    )

    const strandedJournals = await this.sweepRingJournals()
    if (swept.closed > 0) this.channel.post('session-closed')
    return { ...swept, orphansRemoved: swept.orphansRemoved + strandedJournals }
  }

  async usage(): Promise<{
    readonly totalSamples: number
    readonly sessions: number
    readonly ringRecords: number
    readonly rawBytes: number
    readonly rawCapacityBytes: number
  }> {
    if (!this.connected) return { totalSamples: this.knownTotal, sessions: 0, ringRecords: 0, rawBytes: 0, rawCapacityBytes: this.rawCapacityBytes() }
    return runTransaction(
      this.database,
      [SESSIONS, META, RING_RECORDS, CHUNKS],
      'readonly',
      async (transaction) => {
        const meta = await this.readMeta(transaction, 0)
        const sessions = await requestAsPromise<number>(transaction.objectStore(SESSIONS).count())

        const ringRecords = await requestAsPromise<number>(
          transaction.objectStore(RING_RECORDS).count(),
        )
        this.knownTotal = meta.totalSamples
        return { totalSamples: meta.totalSamples, sessions, ringRecords, rawBytes: await this.rawBytesIn(transaction, meta), rawCapacityBytes: this.rawCapacityBytes() }
      },
    )
  }

  watch(onChanged: () => void): () => void {
    const stopHearingOtherTabs = this.channel.subscribe(() => onChanged())
    this.watchers.add(onChanged)
    return () => {
      stopHearingOtherTabs()
      this.watchers.delete(onChanged)
    }
  }

  noteViewing(id: SessionId | null): void {
    this.viewedSessionId = id
  }

  close(): void {
    if (!this.connected) return
    this.connected = false
    this.database.close()
    this.channel.close()
  }

  // Summaries and raw retention share one transaction across writers.
  private async writeChunk(chunk: HistoryChunk, patch: SessionPatch, hours: readonly SessionHour[]): Promise<CommitOutcome> {
    if (!this.connected) return this.refusedCommit(null)
    return runTransaction(this.database, EVERY_STORE, 'readwrite', async (transaction) => {
      const sessions = transaction.objectStore(SESSIONS)
      const chunks = transaction.objectStore(CHUNKS)
      const stored = await requestAsPromise<SessionRecord | undefined>(
        sessions.get(chunk.sessionId),
      )

      if (stored === undefined || stored.state !== 'open') return this.refusedCommit(null)

      const existing = await requestAsPromise<HistoryChunk | undefined>(
        chunks.get([chunk.sessionId, chunk.stream, chunk.seq]),
      )

      const sealedGain = chunk.sealed && existing?.sealed !== true ? chunk.length : 0

      const meta = await this.readMeta(transaction, patch.heartbeatAt)
      const rawBytes = await this.rawBytesIn(transaction, meta)
        + chunk.length * sampleBytes(chunk.stream)
        - (existing?.length ?? 0) * sampleBytes(chunk.stream)
      for (const hour of hours) {
        if (hour.sessionId !== chunk.sessionId) throw new Error('Hourly summary belongs to another session')
        await requestAsPromise(transaction.objectStore(HOURS).put(hour))
      }
      await requestAsPromise(chunks.put(chunk))
      const { hourlyBasis, ...storedFields } = stored
      const merged: SessionRecord = {
        ...storedFields,
        ...patch,
        ...(hours.length > 0 || hourlyBasis === 'recorded' ? { hourlyBasis: 'recorded' as const } : {}),
        sealedSamples: stored.sealedSamples + sealedGain,
        coverage: retainedCoverage(patch.coverage, stored.retainedFrom),
      }
      await requestAsPromise(sessions.put(merged))

      const afterSeal = meta.totalSamples + sealedGain
      const pruned = await this.prune(transaction, rawBytes, patch.heartbeatAt)
      const totalSamples = afterSeal - pruned.freedSamples
      const prunedAt = pruned.freedSamples > 0 ? patch.heartbeatAt : null
      await this.writeTotal(transaction, { ...meta, rawBytes: rawBytes - pruned.freedBytes }, totalSamples, prunedAt)

      return {
        stored: true,
        totalSamples,
        prunedSessionIds: pruned.evicted,
        truncatedFrom: pruned.truncatedFrom,
        failure: null,
      }
    })
  }

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

  private async pruneToBudget(now: number): Promise<void> {
    await runTransaction(this.database, EVERY_STORE, 'readwrite', async (transaction) => {
      const meta = await this.readMeta(transaction, now)
      const rawBytes = await this.rawBytesIn(transaction, meta)
      const pruned = await this.prune(transaction, rawBytes, now)
      await this.writeTotal(transaction, { ...meta, rawBytes: rawBytes - pruned.freedBytes }, meta.totalSamples - pruned.freedSamples, now)
    })
  }

  private async prune(transaction: IDBTransaction, rawBytes: number, now: number): Promise<PruneExecution> {
    const rows = await this.readSessionRows(transaction)
    const capacity = this.rawCapacityBytes()
    let freedSamples = 0
    let freedBytes = 0
    let truncatedFrom: number | null = null
    if (rawBytes > capacity) {
      const chunks = transaction.objectStore(CHUNKS)
      const extents: RawChunkExtent[] = []
      await cursorEach(chunks.openCursor(), (cursor) => {
        const chunk = cursor.value as HistoryChunk
        if (isReadableLayout(chunk.layout)) extents.push(chunk)
      })
      const plan = planRawPrune(extents, rawBytes, capacity)
      const compacted = new Set<string>()
      for (const reference of plan) {
        if (!compacted.has(reference.sessionId)) {
          await compactSessionInTransaction(transaction, reference.sessionId)
          compacted.add(reference.sessionId)
        }
        const key = [reference.sessionId, reference.stream, reference.seq]
        const chunk = await requestAsPromise<HistoryChunk>(chunks.get(key))
        if (!await this.chunkHasSummary(transaction, chunk)) continue
        await requestAsPromise(chunks.delete(key))
        freedSamples += chunk.length
        freedBytes += chunk.length * sampleBytes(chunk.stream)
      }
      for (const sessionId of compacted) {
        const record = await requestAsPromise<SessionRecord>(transaction.objectStore(SESSIONS).get(sessionId))
        let remainingSamples = 0
        let firstAt: number | null = null
        await cursorEach(chunks.index(BY_SESSION).openCursor(sessionId), (cursor) => {
          const chunk = cursor.value as HistoryChunk
          if (chunk.sealed) remainingSamples += chunk.length
          firstAt = firstAt === null ? chunk.baseAt : Math.min(firstAt, chunk.baseAt)
        })
        const retainedFrom = firstAt ?? record.endedAt ?? record.heartbeatAt
        await requestAsPromise(transaction.objectStore(SESSIONS).put({ ...record, sealedSamples: remainingSamples, retainedFrom, coverage: retainedCoverage(record.coverage, retainedFrom) }))
        truncatedFrom = retainedFrom
      }
    }
    const hours = transaction.objectStore(HOURS)
    let hourCount = await requestAsPromise<number>(hours.count())
    const oldHours: { sessionId: string; hourStart: number }[] = []
    await cursorEach(hours.index(BY_TIME).openKeyCursor(), (cursor) => {
      if (hourCount <= MAX_SESSION_HOURS && (cursor.key as number) >= now - COMPACT_RETENTION_MS) return false
      const [sessionId, hourStart] = cursor.primaryKey as [string, number]
      oldHours.push({ sessionId, hourStart })
    })
    const rawSpans = new Map<SessionId, TimeWindow[]>()
    for (const hour of oldHours) {
      if (hourCount <= MAX_SESSION_HOURS && hour.hourStart >= now - COMPACT_RETENTION_MS) break
      let spans = rawSpans.get(hour.sessionId)
      if (spans === undefined) {
        spans = []
        await cursorEach(transaction.objectStore(CHUNKS).index(BY_SESSION).openCursor(hour.sessionId), (cursor) => {
          const chunk = cursor.value as HistoryChunk
          spans!.push(isReadableLayout(chunk.layout)
            ? { from: chunk.baseAt, to: lastSampleTimeOf(chunk) ?? chunk.baseAt }
            : { from: 0, to: Number.MAX_SAFE_INTEGER })
        })
        rawSpans.set(hour.sessionId, spans)
      }
      if (spans.some((span) => span.from < hour.hourStart + 3_600_000 && span.to >= hour.hourStart)) continue
      await requestAsPromise(hours.delete([hour.sessionId, hour.hourStart]))
      hourCount -= 1
    }
    const evicted: SessionId[] = []
    let sessionCount = rows.length
    for (const record of rows) {
      if (sessionCount <= MAX_SESSIONS && hourCount <= MAX_SESSION_HOURS) break
      if (record.state === 'open' || record.id === this.viewedSessionId || now - record.heartbeatAt < HEARTBEAT_STALE_MS) continue
      const sessionHours = await requestAsPromise<number>(hours.index(BY_SESSION).count(record.id))
      if (sessionCount <= MAX_SESSIONS && sessionHours === 0) continue
      await cursorEach(transaction.objectStore(CHUNKS).index(BY_SESSION).openCursor(record.id), (cursor) => {
        const chunk = cursor.value as HistoryChunk
        freedBytes += chunk.length * sampleBytes(chunk.stream)
      })
      freedSamples += await this.evictSession(transaction, record.id)
      evicted.push(record.id)
      sessionCount -= 1
      hourCount -= sessionHours
    }
    return { evicted, freedSamples, freedBytes, truncatedFrom }
  }

  async compactSession(id: SessionId): Promise<void> {
    if (!this.connected) return
    await runTransaction(this.database, EVERY_STORE, 'readwrite', (transaction) => compactSessionInTransaction(transaction, id))
  }

  private async chunkHasSummary(transaction: IDBTransaction, chunk: HistoryChunk): Promise<boolean> {
    const byHour = new Map<number, SessionHour | undefined>()
    for (let index = 0; index < chunk.length; index += 1) {
      const at = chunk.baseAt + chunk.offsetMs[index]!
      const hourStart = Math.floor(at / 3_600_000) * 3_600_000
      if (!byHour.has(hourStart)) byHour.set(hourStart, await requestAsPromise<SessionHour | undefined>(transaction.objectStore(HOURS).get([chunk.sessionId, hourStart])))
      const hour = byHour.get(hourStart)
      if (hour === undefined || hour.from > at || hour.to < at) return false
    }
    return true
  }

  private async rawBytesIn(transaction: IDBTransaction, meta: HistoryMeta, recount = false): Promise<number> {
    if (!recount && meta.rawBytes !== undefined) return meta.rawBytes
    let bytes = 0
    await cursorEach(transaction.objectStore(CHUNKS).openCursor(), (cursor) => {
      const chunk = cursor.value as HistoryChunk
      bytes += chunk.length * sampleBytes(chunk.stream)
    })
    return bytes
  }

  private async evictSession(transaction: IDBTransaction, id: SessionId): Promise<number> {
    const sessions = transaction.objectStore(SESSIONS)
    const chunks = transaction.objectStore(CHUNKS)
    const stored = await requestAsPromise<SessionRecord | undefined>(sessions.get(id))

    await cursorEach(chunks.index(BY_SESSION).openKeyCursor(IDBKeyRange.only(id)), (cursor) => {
      chunks.delete(cursor.primaryKey)
    })
    const warnings = transaction.objectStore(WARNINGS)
    await cursorEach(warnings.openKeyCursor(IDBKeyRange.bound([id], [id, HIGHEST_SEQ])), (cursor) => {
      warnings.delete(cursor.primaryKey)
    })
    await cursorEach(transaction.objectStore(HOURS).index(BY_SESSION).openKeyCursor(id), (cursor) => {
      transaction.objectStore(HOURS).delete(cursor.primaryKey)
    })
    await requestAsPromise(sessions.delete(id))
    return stored?.sealedSamples ?? 0
  }

  private async readSessionRows(transaction: IDBTransaction): Promise<SessionRecord[]> {
    const rows: SessionRecord[] = []
    const oldestFirst = transaction.objectStore(SESSIONS).index(BY_STARTED_AT).openCursor()
    await cursorEach(oldestFirst, (cursor) => {
      rows.push(cursor.value as SessionRecord)
    })
    return rows
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

  private mergeRing(snapshot: RingSnapshot): Promise<RingIngestOutcome> {
    return runTransaction(this.database, RING_STORES, 'readwrite', async (transaction) => {
      const records = transaction.objectStore(RING_RECORDS)
      const tail = await this.readRingTail(transaction, snapshot.deviceKey)

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

  private mergeSolarHistory(snapshot: SolarHistorySnapshot): Promise<SolarHistoryIngestOutcome> {
    return runTransaction(this.database, RING_STORES, 'readwrite', async (transaction) => {
      const records = transaction.objectStore(RING_RECORDS)
      const stored = solarDaysIn(await this.readRingRows(transaction, snapshot.deviceKey))

      const folded = foldSolarHistorySnapshot(stored, snapshot, snapshot.observedAt)
      for (const row of folded.rows) await requestAsPromise(records.put(row))

      await this.journalSolarSweep(transaction, snapshot, folded.merge)
      const prunedRecords = await this.pruneRing(transaction)

      return {
        ...folded.merge,
        stored: true,

        totalDays: await this.countRingRecords(transaction, snapshot.deviceKey),
        prunedRecords,
        failure: null,
      }
    })
  }

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

    return { nextSeq: highestSeq === null ? 0 : highestSeq + 1, rows }
  }

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

  private async ringDeviceKeys(transaction: IDBTransaction): Promise<DeviceKey[]> {
    const keys = new Set<DeviceKey>()
    for (const storeName of [RING_RECORDS, RING_READS]) {
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
    for (const storeName of [RING_RECORDS, RING_READS]) {
      const store = transaction.objectStore(storeName)
      await cursorEach(store.index(BY_DEVICE).openKeyCursor(IDBKeyRange.only(deviceKey)), (cursor) => {
        store.delete(cursor.primaryKey)
      })
    }
  }

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

  private standDown(): void {
    this.close()
    this.reportUnusable('version-newer')
  }

  private reportUnusable(reason: HistoryUnavailableReason): void {
    if (!this.state.usable && this.state.reason === reason) return
    this.state = { ...this.state, usable: false, reason }
    for (const watcher of [...this.watchers]) watcher()
  }
}

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

function ringRangeOf(deviceKey: DeviceKey): IDBKeyRange {
  return IDBKeyRange.bound([deviceKey], [deviceKey, Number.MAX_SAFE_INTEGER])
}

function retainedFromSeqOf(records: readonly StoredRingRecord[]): number | null {
  const oldest = records[0]
  return oldest === undefined || oldest.seq === 0 ? null : oldest.seq
}

function ledgerKindOf(
  row: StoredRingRecord | null,
  read: StoredRingRead | null,
): DeviceRecord['kind'] {
  if (row !== null) return isSolarDayRow(row) ? 'solar' : 'pack'
  if (read !== null && isSolarReadRow(read)) return 'solar'
  return 'pack'
}

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
