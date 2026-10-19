import type {
  CommitOutcome,
  HistoryAvailability,
  HistoryStore,
  RingIngestOutcome,
  RingLedgerSummary,
  SessionClosure,
  SessionListing,
  SessionPatch,
  SolarHistoryIngestOutcome,
  StoredRingLedger,
  StoredSession,
} from '../../src/application/history/port'
import { renderWindowFor } from '../../src/application/history/port'
import { planRawPrune, MAX_SESSIONS, MAX_SESSION_HOURS, COMPACT_RETENTION_MS, retainedCoverage } from '../../src/domain/history/budget'
import type { SessionHour } from '../../src/domain/history/SessionHour'
import { summarizeSessionHours } from '../../src/domain/history/summarizeSessionHours'
import { localRawCapacityBytes } from '../../src/application/history/localCapacity'
import { isReadableLayout, sampleBytes, decodePackChunk, decodeSolarChunk } from '../../src/domain/history/columns'
import { deviceLabel } from '../../src/domain/history/identity'
import { MAX_RING_READS_PER_DEVICE, planRingPrune } from '../../src/domain/history/ringBudget'
import type { RingDeviceExtent } from '../../src/domain/history/ringBudget'
import { ALIGNMENT_TAIL_RECORDS, foldRingSnapshot } from '../../src/domain/history/ringLedger'
import { foldSolarHistorySnapshot } from '../../src/domain/history/solarLedger'
import {
  isPackRecordRow,
  isSolarDayRow,
  isSolarReadRow,
  packReadsIn,
  packRecordsIn,
  solarDaysIn,
  solarReadsIn,
} from '../../src/domain/history/storedRows'
import { SOLAR_DAY_FORMAT } from '../../src/domain/history/StoredRowFormat'
import type { RingLedgerTail } from '../../src/domain/history/RingLedgerTail'
import type { RingMergeOutcome } from '../../src/domain/history/RingMergeOutcome'
import type { RingReadRow } from '../../src/domain/history/RingReadRow'
import type { RingRecordRow } from '../../src/domain/history/RingRecordRow'
import type { RingSnapshot } from '../../src/domain/history/RingSnapshot'
import type { SolarHistorySnapshot } from '../../src/domain/history/SolarHistorySnapshot'
import type { SolarMergeOutcome } from '../../src/domain/history/SolarMergeOutcome'
import type { StoredRingRead } from '../../src/domain/history/StoredRingRead'
import type { StoredRingRecord } from '../../src/domain/history/StoredRingRecord'
import { HEARTBEAT_STALE_MS, PACK_STREAM, SOLAR_STREAM } from '../../src/domain/history/types'
import type {
  ChunkKey,
  DeviceKey,
  DeviceRecord,
  HistoryChunk,
  PackChunk,
  SessionId,
  SessionRecord,
  SolarChunk,
  StreamName,
  TimeWindow,
  WarningRecord,
} from '../../src/domain/history/types'

export interface MemoryHistoryStoreOptions {
  readonly rawCapacityBytes?: () => number

  readonly now?: () => number

  readonly availability?: Partial<HistoryAvailability>
}

const USABLE: HistoryAvailability = {
  usable: true,
  reason: null,
  persisted: null,
  estimatedBytes: null,
  quotaBytes: null,
}

// Clone both sides of the port so tests cannot mutate stored records through shared references.
export class MemoryHistoryStore implements HistoryStore {
  readonly availability: HistoryAvailability

  private readonly hours = new Map<string, SessionHour>()
  private readonly rawCapacityBytes: () => number
  private readonly now: (() => number) | undefined
  private readonly sessions = new Map<SessionId, SessionRecord>()
  private readonly chunks = new Map<string, HistoryChunk>()
  private readonly devices = new Map<DeviceKey, DeviceRecord>()
  private readonly warnings = new Map<string, WarningRecord>()

  private readonly ringRows = new Map<DeviceKey, StoredRingRecord[]>()

  private readonly ringReads = new Map<DeviceKey, StoredRingRead[]>()
  private readonly ringRetainedFrom = new Map<DeviceKey, number>()
  private readonly watchers = new Set<() => void>()

  private totalSamples = 0
  private viewedSessionId: SessionId | null = null
  private queuedCommitFailure: Error | null = null
  private queuedOpenDelayMs = 0

  constructor(options: MemoryHistoryStoreOptions = {}) {
    this.availability = { ...USABLE, ...options.availability }
    this.rawCapacityBytes = options.rawCapacityBytes ?? localRawCapacityBytes
    this.now = options.now
  }

  failNextCommitWith(error: Error): void {
    this.queuedCommitFailure = error
  }

  delayNextOpenBy(milliseconds: number): void {
    this.queuedOpenDelayMs = milliseconds
  }

  announce(): void {
    for (const watcher of [...this.watchers]) watcher()
  }

  async openSession(record: SessionRecord): Promise<void> {
    const delayMs = this.queuedOpenDelayMs
    this.queuedOpenDelayMs = 0
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs))

    const stored = this.sessions.get(record.id)
    this.put(stored === undefined ? record : { ...record, sealedSamples: stored.sealedSamples })
  }

  async commitChunk(chunk: HistoryChunk, patch: SessionPatch, hours: readonly SessionHour[] = []): Promise<CommitOutcome> {
    const failure = this.queuedCommitFailure
    if (failure !== null) {
      this.queuedCommitFailure = null
      if (!isCaughtWriteFailure(failure)) throw failure
      return this.refusal('quota-exhausted')
    }

    const stored = this.sessions.get(chunk.sessionId)
    if (stored === undefined || stored.state !== 'open') return this.refusal(null)

    if (hours.some((hour) => hour.sessionId !== chunk.sessionId)) return this.refusal(null)
    for (const hour of hours) this.hours.set(`${hour.sessionId}|${hour.hourStart}`, structuredClone(hour))
    const previous = this.chunks.get(keyOf(chunk))
    this.chunks.set(keyOf(chunk), structuredClone(chunk))
    const sealedDelta = countedRows(chunk) - countedRows(previous)
    this.totalSamples += sealedDelta

    const { hourlyBasis, ...storedFields } = stored
    this.put({ ...storedFields, ...patch, coverage: retainedCoverage(patch.coverage, stored.retainedFrom), ...(hours.length > 0 || hourlyBasis === 'recorded' ? { hourlyBasis: 'recorded' as const } : {}), sealedSamples: stored.sealedSamples + sealedDelta })

    const executed = await this.prune(this.now?.() ?? patch.heartbeatAt)
    return {
      stored: true,
      totalSamples: this.totalSamples,
      prunedSessionIds: executed.prunedSessionIds,
      truncatedFrom: executed.truncatedFrom,
      failure: null,
    }
  }

  async closeSession(id: SessionId, closure: SessionClosure): Promise<void> {
    const stored = this.sessions.get(id)
    if (stored === undefined) return

    const sealed = this.sealTails(id)
    this.put({
      ...stored,
      ...closure,
      coverage: retainedCoverage(closure.coverage, stored.retainedFrom),
      state: 'closed',
      sealedSamples: stored.sealedSamples + sealed,
    })
  }

  async deleteSession(id: SessionId): Promise<void> {
    this.removeSession(id)
  }

  async appendWarning(record: WarningRecord): Promise<void> {
    this.warnings.set(`${record.sessionId}|${record.seq}`, structuredClone(record))
  }

  async warningsOf(id: SessionId): Promise<readonly WarningRecord[]> {
    return [...this.warnings.values()]
      .filter((warning) => warning.sessionId === id)
      .sort((left, right) => left.seq - right.seq)
      .map((warning) => structuredClone(warning))
  }

  async listWarnings(limit?: number): Promise<readonly WarningRecord[]> {
    const newestFirst = [...this.warnings.values()].sort(
      (left, right) => right.at - left.at || compareWarningKeyDesc(left, right),
    )
    const rows = limit === undefined ? newestFirst : newestFirst.slice(0, limit)
    return rows.map((warning) => structuredClone(warning))
  }

  async warningsInWindow(window: TimeWindow): Promise<readonly WarningRecord[]> {
    return [...this.warnings.values()]
      .filter((warning) => warning.at >= window.from && warning.at <= window.to)
      .sort((left, right) => left.at - right.at || compareWarningKeyAsc(left, right))
      .map((warning) => structuredClone(warning))
  }

  async listSessions(limit?: number): Promise<readonly SessionListing[]> {
    const newestFirst = [...this.sessions.values()].sort(
      (left, right) => right.startedAt - left.startedAt,
    )
    const rows = limit === undefined ? newestFirst : newestFirst.slice(0, limit)
    return rows.map((record) => this.listingOf(record))
  }

  async listDevices(): Promise<readonly DeviceRecord[]> {
    return [...this.devices.values()]
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map((device) => structuredClone(device))
  }

  async readSession(id: SessionId, window?: TimeWindow): Promise<StoredSession | null> {
    const record = this.sessions.get(id)
    if (record === undefined) return null

    const view = renderWindowFor(this.spanOf(record), window)
    return {
      record: structuredClone(record),
      packDevice: this.deviceOf(record.packDeviceKey),
      solarDevice: this.deviceOf(record.solarDeviceKey),
      pack: this.chunksOf(id, PACK_STREAM, view.window) as PackChunk[],
      solar: this.chunksOf(id, SOLAR_STREAM, view.window) as SolarChunk[],
      windowClamped: view.clamped,
      hours: [...this.hours.values()].filter((hour) => hour.sessionId === id).map((hour) => structuredClone(hour)),
    }
  }

  async streamChunks(
    id: SessionId,
    stream: StreamName,
    window: TimeWindow,
    visit: (chunk: HistoryChunk) => void,
  ): Promise<void> {
    for (const chunk of this.decodableChunksOf(id, stream, window)) visit(structuredClone(chunk))
  }

  async upsertDevice(record: DeviceRecord): Promise<DeviceRecord> {
    const stored = this.devices.get(record.key)
    const merged: DeviceRecord =
      stored === undefined
        ? record
        : {
            ...stored,
            ...record,

            userLabel: record.userLabel ?? stored.userLabel,

            packUtcOffsetMinutes: record.packUtcOffsetMinutes ?? stored.packUtcOffsetMinutes,
            packClockAheadSeconds: record.packClockAheadSeconds ?? stored.packClockAheadSeconds,
            firstSeenAt: Math.min(stored.firstSeenAt, record.firstSeenAt),
            lastSeenAt: Math.max(stored.lastSeenAt, record.lastSeenAt),

            sessionCount: Math.max(stored.sessionCount, record.sessionCount),
          }

    this.devices.set(merged.key, structuredClone(merged))
    return structuredClone(merged)
  }

  async renameDevice(key: DeviceKey, label: string | null): Promise<DeviceRecord | null> {
    const stored = this.devices.get(key)
    if (stored === undefined) return null

    const chosen = label?.trim() ?? ''
    const renamed: DeviceRecord = { ...stored, userLabel: chosen === '' ? null : chosen }
    this.devices.set(key, structuredClone(renamed))
    return structuredClone(renamed)
  }

  async appendRingSnapshot(snapshot: RingSnapshot): Promise<RingIngestOutcome> {
    const stored = this.ringRows.get(snapshot.deviceKey) ?? []
    const { rows, merge } = foldRingSnapshot(tailOf(stored), snapshot, snapshot.observedAt)

    const kept = [...stored, ...rows.map((row) => structuredClone(row))]
    this.ringRows.set(snapshot.deviceKey, kept)
    this.journal(snapshot, merge, packRecordsIn(kept))
    const prunedRecords = this.pruneRing()

    return {
      ...merge,
      stored: true,
      totalRecords: (this.ringRows.get(snapshot.deviceKey) ?? []).length,
      prunedRecords,
      failure: null,
    }
  }

  async appendSolarHistory(snapshot: SolarHistorySnapshot): Promise<SolarHistoryIngestOutcome> {
    const stored = this.ringRows.get(snapshot.deviceKey) ?? []
    const { rows, merge } = foldSolarHistorySnapshot(
      solarDaysIn(stored),
      snapshot,
      snapshot.observedAt,
    )

    const written = new Map(rows.map((row) => [row.seq, structuredClone(row)]))
    const kept = stored.map((row) => written.get(row.seq) ?? row)
    for (const [seq, row] of written) {
      if (!stored.some((held) => held.seq === seq)) kept.push(row)
    }
    kept.sort((left, right) => left.seq - right.seq)
    this.ringRows.set(snapshot.deviceKey, kept)

    this.journalSolarSweep(snapshot, merge)
    const prunedRecords = this.pruneRing()

    return {
      ...merge,
      stored: true,

      totalDays: (this.ringRows.get(snapshot.deviceKey) ?? []).length,
      prunedRecords,
      failure: null,
    }
  }

  async readRingLedger(deviceKey: DeviceKey): Promise<StoredRingLedger | null> {
    const rows = this.ringRows.get(deviceKey)
    const journal = this.ringReads.get(deviceKey)

    if (rows === undefined && journal === undefined) return null

    const held = (rows ?? []).map((row) => structuredClone(row))
    const receipts = [...(journal ?? [])].reverse().map((read) => structuredClone(read))
    return {
      deviceKey,
      records: packRecordsIn(held),
      solarDays: solarDaysIn(held),
      reads: packReadsIn(receipts),
      solarReads: solarReadsIn(receipts),
      device: this.deviceOf(deviceKey),
      retainedFromSeq: this.ringRetainedFrom.get(deviceKey) ?? null,
    }
  }

  async listRingLedgers(): Promise<readonly RingLedgerSummary[]> {
    return this.ringDeviceKeys()
      .map((deviceKey) => {
        const rows = this.ringRows.get(deviceKey) ?? []
        const reads = this.ringReads.get(deviceKey) ?? []
        const newest = rows[rows.length - 1] ?? null
        return {
          deviceKey,
          kind: ledgerKindOf(newest, reads[reads.length - 1] ?? null),
          label: deviceLabel(this.devices.get(deviceKey) ?? null),
          records: rows.length,
          lastReadAt: this.lastReadAtOf(deviceKey),
          oldestPackClockSeconds: packClockFaceOf(rows[0] ?? null),
          newestPackClockSeconds: packClockFaceOf(newest),
        }
      })
      .sort((left, right) => right.lastReadAt - left.lastReadAt)
  }

  async setPackClock(
    deviceKey: DeviceKey,
    clock: { readonly utcOffsetMinutes: number | null; readonly aheadSeconds: number | null },
  ): Promise<DeviceRecord | null> {
    const stored = this.devices.get(deviceKey)
    if (stored === undefined) return null

    const answered: DeviceRecord = {
      ...stored,
      packUtcOffsetMinutes: clock.utcOffsetMinutes,
      packClockAheadSeconds: clock.aheadSeconds,
    }
    this.devices.set(deviceKey, structuredClone(answered))
    return structuredClone(answered)
  }

  async deleteRingLedger(deviceKey: DeviceKey): Promise<void> {
    this.dropRingLedger(deviceKey)
  }

  async recover(now: number): Promise<{ readonly closed: number; readonly orphansRemoved: number }> {
    let closed = 0
    for (const record of [...this.sessions.values()]) {
      if (record.state !== 'open') continue
      if (now - record.heartbeatAt < HEARTBEAT_STALE_MS) continue

      if (record.packSamples + record.solarSamples === 0) {
        this.removeSession(record.id)
        continue
      }

      const sealed = this.sealTails(record.id)
      this.put({
        ...record,
        state: 'closed',
        endedAt: this.lastSampleAtOf(record.id) ?? record.heartbeatAt,
        endReason: 'abandoned',
        sealedSamples: record.sealedSamples + sealed,
      })
      closed += 1
    }

    let orphansRemoved = 0
    for (const [key, chunk] of [...this.chunks]) {
      if (this.sessions.has(chunk.sessionId)) continue
      this.totalSamples -= countedRows(chunk)
      this.chunks.delete(key)
      orphansRemoved += 1
    }
    for (const [key, warning] of [...this.warnings]) {
      if (!this.sessions.has(warning.sessionId)) this.warnings.delete(key)
    }

    await this.prune(now)
    return { closed, orphansRemoved }
  }

  async usage(): Promise<{
    readonly totalSamples: number
    readonly sessions: number
    readonly ringRecords: number
    readonly rawBytes: number
    readonly rawCapacityBytes: number
  }> {
    let ringRecords = 0
    for (const rows of this.ringRows.values()) ringRecords += rows.length
    return { totalSamples: this.totalSamples, sessions: this.sessions.size, ringRecords, rawBytes: this.rawBytes(), rawCapacityBytes: this.rawCapacityBytes() }
  }

  watch(onChanged: () => void): () => void {
    this.watchers.add(onChanged)
    return () => {
      this.watchers.delete(onChanged)
    }
  }

  close(): void {
    this.watchers.clear()
  }

  noteViewing(id: SessionId | null): void {
    this.viewedSessionId = id
  }

  private put(record: SessionRecord): void {
    this.sessions.set(record.id, structuredClone(record))
  }

  private refusal(failure: CommitOutcome['failure']): CommitOutcome {
    return {
      stored: false,
      totalSamples: this.totalSamples,
      prunedSessionIds: [],
      truncatedFrom: null,
      failure,
    }
  }

  private listingOf(record: SessionRecord): SessionListing {
    const device = this.deviceOf(record.groupKey)
    return { record: structuredClone(record), device, label: deviceLabel(device) }
  }

  private deviceOf(key: DeviceKey | null): DeviceRecord | null {
    if (key === null) return null
    const stored = this.devices.get(key)
    return stored === undefined ? null : structuredClone(stored)
  }

  private sealTails(id: SessionId): number {
    let folded = 0
    for (const [key, chunk] of this.chunks) {
      if (chunk.sessionId !== id || chunk.sealed) continue
      this.chunks.set(key, { ...chunk, sealed: true })
      this.totalSamples += chunk.length
      folded += chunk.length
    }
    return folded
  }

  private removeSession(id: SessionId): void {
    for (const [key, chunk] of [...this.chunks]) {
      if (chunk.sessionId !== id) continue
      this.totalSamples -= countedRows(chunk)
      this.chunks.delete(key)
    }
    for (const [key, warning] of [...this.warnings]) {
      if (warning.sessionId === id) this.warnings.delete(key)
    }
    for (const [key, hour] of this.hours) {
      if (hour.sessionId === id) this.hours.delete(key)
    }
    this.sessions.delete(id)
  }

  async compactSession(id: SessionId): Promise<void> {
    const record = this.sessions.get(id)
    if (record === undefined || record.hourlyBasis === 'recorded' || (record.state === 'closed' && record.hourlyBasis === 'reconstructed')) return
    const pack = [...this.chunks.values()].filter((chunk) => chunk.sessionId === id && chunk.stream === PACK_STREAM && isReadableLayout(chunk.layout)).flatMap((chunk) => decodePackChunk(chunk as PackChunk))
    const solar = [...this.chunks.values()].filter((chunk) => chunk.sessionId === id && chunk.stream === SOLAR_STREAM && isReadableLayout(chunk.layout)).flatMap((chunk) => decodeSolarChunk(chunk as SolarChunk))
    if (pack.length === 0 && solar.length === 0) return
    for (const hour of summarizeSessionHours(id, pack, solar)) {
      const key = `${id}|${hour.hourStart}`
      const existing = this.hours.get(key)
      const retainedFrom = this.sessions.get(id)?.retainedFrom
      if (existing?.basis === 'recorded' || (existing !== undefined && retainedFrom != null && hour.hourStart < retainedFrom)) continue
      this.hours.set(key, structuredClone(hour))
    }
    this.put({ ...record, hourlyBasis: 'reconstructed' })
  }

  private rawBytes(): number {
    let bytes = 0
    for (const chunk of this.chunks.values()) bytes += chunk.length * sampleBytes(chunk.stream)
    return bytes
  }

  private async prune(now: number): Promise<{ prunedSessionIds: readonly SessionId[]; truncatedFrom: number | null }> {
    const plan = planRawPrune([...this.chunks.values()].filter((chunk) => isReadableLayout(chunk.layout)), this.rawBytes(), this.rawCapacityBytes())
    const compacted = new Set<SessionId>()
    let truncatedFrom: number | null = null
    for (const reference of plan) {
      const chunk = this.chunks.get(keyOf(reference))!
      if (!compacted.has(chunk.sessionId)) {
        await this.compactSession(chunk.sessionId)
        compacted.add(chunk.sessionId)
      }
      let summarized = true
      for (let index = 0; index < chunk.length; index += 1) {
        const at = chunk.baseAt + chunk.offsetMs[index]!
        const hour = this.hours.get(`${chunk.sessionId}|${Math.floor(at / 3_600_000) * 3_600_000}`)
        if (hour === undefined || hour.from > at || hour.to < at) summarized = false
      }
      if (!summarized) continue
      this.chunks.delete(keyOf(chunk))
      this.totalSamples -= countedRows(chunk)
    }
    for (const id of compacted) {
      const record = this.sessions.get(id)!
      const remaining = [...this.chunks.values()].filter((chunk) => chunk.sessionId === id)
      const retainedFrom = remaining.length > 0 ? Math.min(...remaining.map((chunk) => chunk.baseAt)) : record.endedAt ?? record.heartbeatAt
      this.put({ ...record, sealedSamples: remaining.reduce((count, chunk) => count + countedRows(chunk), 0), retainedFrom, coverage: retainedCoverage(record.coverage, retainedFrom) })
      truncatedFrom = retainedFrom
    }
    for (const hour of [...this.hours.values()].sort((left, right) => left.hourStart - right.hourStart)) {
      if (this.hours.size <= MAX_SESSION_HOURS && hour.hourStart >= now - COMPACT_RETENTION_MS) break
      const overlapsRaw = [...this.chunks.values()].some((chunk) => chunk.sessionId === hour.sessionId &&
        (!isReadableLayout(chunk.layout) || (chunk.baseAt < hour.hourStart + 3_600_000 && chunk.baseAt + chunk.offsetMs[chunk.length - 1]! >= hour.hourStart)))
      if (!overlapsRaw) this.hours.delete(`${hour.sessionId}|${hour.hourStart}`)
    }
    const prunedSessionIds: SessionId[] = []
    const oldest = [...this.sessions.values()].sort((left, right) => left.startedAt - right.startedAt)
    for (const record of oldest) {
      if (this.sessions.size <= MAX_SESSIONS && this.hours.size <= MAX_SESSION_HOURS) break
      if (record.state === 'open' || record.id === this.viewedSessionId || now - record.heartbeatAt < HEARTBEAT_STALE_MS) continue
      if (this.sessions.size <= MAX_SESSIONS && ![...this.hours.values()].some((hour) => hour.sessionId === record.id)) continue
      this.removeSession(record.id)
      prunedSessionIds.push(record.id)
    }
    return { prunedSessionIds, truncatedFrom }
  }

  private chunksOf(id: SessionId, stream: StreamName, window: TimeWindow): HistoryChunk[] {
    return this.streamOf(id, stream)
      .filter((chunk) => !isReadableLayout(chunk.layout) || overlaps(chunk, window))
      .map((chunk) => structuredClone(chunk))
  }

  private decodableChunksOf(id: SessionId, stream: StreamName, window: TimeWindow): HistoryChunk[] {
    return this.streamOf(id, stream).filter(
      (chunk) => isReadableLayout(chunk.layout) && overlaps(chunk, window),
    )
  }

  private streamOf(id: SessionId, stream: StreamName): HistoryChunk[] {
    return [...this.chunks.values()]
      .filter((chunk) => chunk.sessionId === id && chunk.stream === stream)
      .sort((left, right) => left.seq - right.seq)
  }

  private spanOf(record: SessionRecord): TimeWindow {
    let from = record.startedAt
    let to = record.endedAt ?? record.startedAt

    for (const chunk of this.chunks.values()) {
      if (chunk.sessionId !== record.id || chunk.length === 0) continue
      if (!isReadableLayout(chunk.layout)) continue
      from = Math.min(from, firstSampleAt(chunk))
      to = Math.max(to, lastSampleAt(chunk))
    }
    return { from, to: Math.max(from, to) }
  }

  private journal(
    snapshot: RingSnapshot,
    merge: RingMergeOutcome,
    ledger: readonly RingRecordRow[],
  ): void {
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
    this.fileReceipt(row)
  }

  private journalSolarSweep(snapshot: SolarHistorySnapshot, merge: SolarMergeOutcome): void {
    this.fileReceipt({
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
    })
  }

  private fileReceipt(row: StoredRingRead): void {
    const kept = (this.ringReads.get(row.deviceKey) ?? []).filter(
      (read) => read.observedAt !== row.observedAt,
    )
    kept.push(structuredClone(row))
    kept.sort((left, right) => left.observedAt - right.observedAt)
    this.ringReads.set(row.deviceKey, kept.slice(-MAX_RING_READS_PER_DEVICE))
  }

  private pruneRing(): number {
    const plan = planRingPrune(this.ringExtents())
    let freed = 0

    for (const deviceKey of plan.dropWhole) {
      freed += (this.ringRows.get(deviceKey) ?? []).length
      this.dropRingLedger(deviceKey)
    }

    for (const eviction of plan.trim) {
      const rows = this.ringRows.get(eviction.deviceKey) ?? []
      const kept = rows.filter((row) => row.seq >= eviction.fromSeq)

      const oldest = kept[0]
      if (oldest !== undefined && isPackRecordRow(oldest)) {
        kept[0] = { ...oldest, followsGap: true }
      }
      freed += rows.length - kept.length
      this.ringRows.set(eviction.deviceKey, kept)
      this.ringRetainedFrom.set(eviction.deviceKey, eviction.fromSeq)
    }

    return freed
  }

  private ringExtents(): RingDeviceExtent[] {
    return this.ringDeviceKeys().map((deviceKey) => {
      const rows = this.ringRows.get(deviceKey) ?? []
      return {
        deviceKey,
        records: rows.length,
        oldestSeq: rows[0]?.seq ?? 0,
        lastReadAt: this.lastReadAtOf(deviceKey),
      }
    })
  }

  private ringDeviceKeys(): DeviceKey[] {
    return [...new Set([...this.ringRows.keys(), ...this.ringReads.keys()])]
  }

  private lastReadAtOf(deviceKey: DeviceKey): number {
    const reads = this.ringReads.get(deviceKey) ?? []
    return reads[reads.length - 1]?.observedAt ?? 0
  }

  private dropRingLedger(deviceKey: DeviceKey): void {
    this.ringRows.delete(deviceKey)
    this.ringReads.delete(deviceKey)
    this.ringRetainedFrom.delete(deviceKey)
  }

  private lastSampleAtOf(id: SessionId): number | null {
    let latest: number | null = null
    for (const chunk of this.chunks.values()) {
      if (chunk.sessionId !== id || chunk.length === 0) continue
      const at = lastSampleAt(chunk)
      if (latest === null || at > latest) latest = at
    }
    return latest
  }
}

function keyOf(chunk: ChunkKey): string {
  return `${chunk.sessionId}|${chunk.stream}|${chunk.seq}`
}

const EVENT_CODE_BYTE = 4
const SCHEDULED_SAMPLE = 0

function tailOf(rows: readonly StoredRingRecord[]): RingLedgerTail {
  const packRecords = packRecordsIn(rows)
  return {
    nextSeq: rows.length === 0 ? 0 : rows[rows.length - 1].seq + 1,
    rows: packRecords.slice(-ALIGNMENT_TAIL_RECORDS),
  }
}

function ledgerKindOf(row: StoredRingRecord | null, read: StoredRingRead | null): 'pack' | 'solar' {
  if (row !== null) return isSolarDayRow(row) ? 'solar' : 'pack'
  if (read !== null && isSolarReadRow(read)) return 'solar'
  return 'pack'
}

function packClockFaceOf(row: StoredRingRecord | null): number {
  return row !== null && isPackRecordRow(row) ? row.packClockSeconds : 0
}

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

function compareWarningKeyDesc(left: WarningRecord, right: WarningRecord): number {
  if (left.sessionId !== right.sessionId) return left.sessionId > right.sessionId ? -1 : 1
  return right.seq - left.seq
}

function compareWarningKeyAsc(left: WarningRecord, right: WarningRecord): number {
  if (left.sessionId !== right.sessionId) return left.sessionId > right.sessionId ? 1 : -1
  return left.seq - right.seq
}

function countedRows(chunk: HistoryChunk | undefined): number {
  if (chunk === undefined || !chunk.sealed) return 0
  return chunk.length
}

function firstSampleAt(chunk: HistoryChunk): number {
  return chunk.baseAt + chunk.offsetMs[0]
}

function lastSampleAt(chunk: HistoryChunk): number {
  return chunk.baseAt + chunk.offsetMs[chunk.length - 1]
}

function overlaps(chunk: HistoryChunk, window: TimeWindow): boolean {
  if (chunk.length === 0) return chunk.baseAt >= window.from && chunk.baseAt <= window.to
  return firstSampleAt(chunk) <= window.to && lastSampleAt(chunk) >= window.from
}

function isCaughtWriteFailure(error: Error): boolean {
  return error.name === 'QuotaExceededError' || error.name === 'AbortError'
}
