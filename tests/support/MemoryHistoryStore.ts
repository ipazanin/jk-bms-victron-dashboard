/**
 * The archive in three Maps.
 *
 * It exists so the recorder and the archive view can be tested without a database: everything
 * above the port is the code most likely to be wrong and least likely to be exercised, and a fake
 * with no dependency at all means every spec above this line runs in an environment where
 * `indexedDB` is genuinely undefined, and proves it needs none.
 *
 * It clones on write and on read, and that is not tidiness. A Map holding references would make
 * these tests structurally blind to the aliasing the seal copy exists to defeat: a chunk kept as a
 * view onto a staging buffer would look correct here and would be written to disk at full capacity
 * on every checkpoint by the real adapter, silently, with nothing to show for it but the budget.
 * structuredClone is also what the browser does to anything crossing into IndexedDB, so a value
 * that survives here survives there.
 *
 * Where it deliberately behaves like the adapter rather than like a convenient stub:
 *
 * - The archive counter moves only when a chunk seals and when a session closes, so a tail
 *   rewritten thirty times costs nothing and can never be double-counted.
 * - Pruning runs through the same pure plan the adapter executes, against the same stored
 *   protections, so the eviction policy is exercised rather than mocked away.
 * - `watch` never fires for this store's own writes. It stands in for a BroadcastChannel, which
 *   does not deliver to the context that posted; a fake that notified its own writer would let a
 *   refresh loop pass here and spin in the browser. `announce()` plays the part of the other tab.
 *
 * Two behaviours are injectable, both for failures the port has to survive and a Map never
 * produces on its own: `failNextCommitWith` and `delayNextOpenBy`.
 */

import type {
  CommitOutcome,
  HistoryAvailability,
  HistoryStore,
  SessionClosure,
  SessionListing,
  SessionPatch,
  StoredSession,
} from '../../src/application/history/port'
import { renderWindowFor } from '../../src/application/history/port'
import { planPrune } from '../../src/domain/history/budget'
import type { ChunkExtent, PruneCandidate, PrunePlan } from '../../src/domain/history/budget'
import { deviceLabel } from '../../src/domain/history/identity'
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
  /** Wall clock for prune protection. Fixed by default, so no spec depends on the real one. */
  readonly now?: () => number
  /**
   * What the store says about itself. Overriding `usable` to false while it keeps storing is the
   * only way to prove a caller refused to write for the right reason: a store that also stored
   * nothing could not tell "refused" from "wrote and lost it".
   */
  readonly availability?: Partial<HistoryAvailability>
}

const USABLE: HistoryAvailability = {
  usable: true,
  reason: null,
  persisted: null,
  estimatedBytes: null,
  quotaBytes: null,
}

/** Late enough that a fixture written at the sample epoch is never accidentally stale. */
const DEFAULT_NOW = Date.UTC(2025, 6, 12, 18, 44, 0)

export class MemoryHistoryStore implements HistoryStore {
  readonly availability: HistoryAvailability

  private readonly sessions = new Map<SessionId, SessionRecord>()
  private readonly chunks = new Map<string, HistoryChunk>()
  private readonly devices = new Map<DeviceKey, DeviceRecord>()
  private readonly warnings = new Map<string, WarningRecord>()
  private readonly watchers = new Set<() => void>()
  private readonly now: () => number

  private totalSamples = 0
  private viewedSessionId: SessionId | null = null
  private queuedCommitFailure: Error | null = null
  private queuedOpenDelayMs = 0

  constructor(options: MemoryHistoryStoreOptions = {}) {
    this.availability = { ...USABLE, ...options.availability }
    this.now = options.now ?? (() => DEFAULT_NOW)
  }

  // ── injected failures ──────────────────────────────────────────────────────

  /**
   * Fails the next commit.
   *
   * A quota error or a transaction abort resolves to `{ stored: false }` carrying
   * `'quota-exhausted'`, which is how the adapter reports a write it caught. Any other error is
   * rejected instead, so a spec can prove the recorder's serial chain swallows the unexpected
   * rather than throwing it back into a BLE frame handler.
   */
  failNextCommitWith(error: Error): void {
    this.queuedCommitFailure = error
  }

  /** Holds the next `openSession` open, so a commit racing it has somewhere to arrive early. */
  delayNextOpenBy(milliseconds: number): void {
    this.queuedOpenDelayMs = milliseconds
  }

  /** What another tab's write would look like from here. */
  announce(): void {
    for (const watcher of [...this.watchers]) watcher()
  }

  // ── writing ────────────────────────────────────────────────────────────────

  async openSession(record: SessionRecord): Promise<void> {
    const delayMs = this.queuedOpenDelayMs
    this.queuedOpenDelayMs = 0
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs))

    // Re-opening an id keeps the counted rows the store already holds for it, so the archive
    // total stays exactly the sum of the rows over the session rows that survive.
    const stored = this.sessions.get(record.id)
    this.put(stored === undefined ? record : { ...record, sealedSamples: stored.sealedSamples })
  }

  async commitChunk(chunk: HistoryChunk, patch: SessionPatch): Promise<CommitOutcome> {
    const failure = this.queuedCommitFailure
    if (failure !== null) {
      this.queuedCommitFailure = null
      if (!isCaughtWriteFailure(failure)) throw failure
      return this.refusal('quota-exhausted')
    }

    const stored = this.sessions.get(chunk.sessionId)
    if (stored === undefined) return this.refusal(null)

    const previous = this.chunks.get(keyOf(chunk))
    this.chunks.set(keyOf(chunk), structuredClone(chunk))
    const sealedDelta = countedRows(chunk) - countedRows(previous)
    this.totalSamples += sealedDelta

    this.put({ ...stored, ...patch, sealedSamples: stored.sealedSamples + sealedDelta })

    const executed = this.prune()
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
    // Ties broken the way the adapter's byTime index breaks them on a 'prev' cursor: equal `at`
    // falls back to descending primary key [sessionId, seq], so both stores select and order an
    // equal-timestamp boundary identically.
    const newestFirst = [...this.warnings.values()].sort(
      (left, right) => right.at - left.at || compareWarningKeyDesc(left, right),
    )
    const rows = limit === undefined ? newestFirst : newestFirst.slice(0, limit)
    return rows.map((warning) => structuredClone(warning))
  }

  async warningsInWindow(window: TimeWindow): Promise<readonly WarningRecord[]> {
    // Bounded to [from, to] and ascending by `at`, as the adapter's byTime cursor over the same
    // bound returns them — uncapped, so a wide range's tally is the whole window.
    return [...this.warnings.values()]
      .filter((warning) => warning.at >= window.from && warning.at <= window.to)
      .sort((left, right) => left.at - right.at || compareWarningKeyAsc(left, right))
      .map((warning) => structuredClone(warning))
  }

  // ── reading ────────────────────────────────────────────────────────────────

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
    }
  }

  async streamChunks(
    id: SessionId,
    stream: StreamName,
    window: TimeWindow,
    visit: (chunk: HistoryChunk) => void,
  ): Promise<void> {
    // Cloned one at a time and never collected, so peak memory here is one chunk, as it is in the
    // cursor this stands in for.
    for (const chunk of this.storedChunksOf(id, stream, window)) visit(structuredClone(chunk))
  }

  // ── devices ────────────────────────────────────────────────────────────────

  async upsertDevice(record: DeviceRecord): Promise<DeviceRecord> {
    const stored = this.devices.get(record.key)
    const merged: DeviceRecord =
      stored === undefined
        ? record
        : {
            ...stored,
            ...record,
            // Only renameDevice may clear the owner's name; a reconnect must not undo a rename.
            userLabel: record.userLabel ?? stored.userLabel,
            firstSeenAt: Math.min(stored.firstSeenAt, record.firstSeenAt),
            lastSeenAt: Math.max(stored.lastSeenAt, record.lastSeenAt),
            // A hint the writer maintains; a device row never counts down.
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

  // ── housekeeping ───────────────────────────────────────────────────────────

  async recover(now: number): Promise<{ readonly closed: number; readonly orphansRemoved: number }> {
    let closed = 0
    for (const record of [...this.sessions.values()]) {
      if (record.state !== 'open') continue
      if (now - record.heartbeatAt < HEARTBEAT_STALE_MS) continue

      if (record.packSamples + record.solarSamples === 0) {
        // A row that recorded nothing is a fabrication once its writer is gone.
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

    return { closed, orphansRemoved }
  }

  async usage(): Promise<{ readonly totalSamples: number; readonly sessions: number }> {
    return { totalSamples: this.totalSamples, sessions: this.sessions.size }
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

  // ── internals ──────────────────────────────────────────────────────────────

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

  /**
   * Every row the session holds, sealed at the instant it is asked for. The tail is the only
   * unsealed chunk per stream, so this is what closing folds in — and it can only fold once,
   * because after it the chunks are sealed and `countedRows` already counts them.
   */
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
    this.sessions.delete(id)
  }

  private prune(): { prunedSessionIds: readonly SessionId[]; truncatedFrom: number | null } {
    const plan = planPrune(this.pruneCandidates(), this.totalSamples, {
      now: this.now(),
      heartbeatStaleMs: HEARTBEAT_STALE_MS,
      viewedSessionId: this.viewedSessionId,
    })
    return this.execute(plan)
  }

  private pruneCandidates(): PruneCandidate[] {
    return [...this.sessions.values()].map((record) => ({
      id: record.id,
      startedAt: record.startedAt,
      sealedSamples: record.sealedSamples,
      state: record.state,
      heartbeatAt: record.heartbeatAt,
      chunks: this.extentsOf(record.id),
    }))
  }

  private extentsOf(id: SessionId): ChunkExtent[] {
    const extents: ChunkExtent[] = []
    for (const chunk of this.chunks.values()) {
      if (chunk.sessionId !== id) continue
      extents.push({
        stream: chunk.stream,
        seq: chunk.seq,
        length: chunk.length,
        baseAt: chunk.baseAt,
      })
    }
    return extents
  }

  private execute(plan: PrunePlan): {
    prunedSessionIds: readonly SessionId[]
    truncatedFrom: number | null
  } {
    for (const id of plan.evict) this.removeSession(id)

    const truncation = plan.truncate
    if (truncation === null) return { prunedSessionIds: plan.evict, truncatedFrom: null }

    for (const reference of truncation.dropChunks) {
      const key = keyOf({ ...reference, sessionId: truncation.sessionId })
      const chunk = this.chunks.get(key)
      if (chunk === undefined) continue
      this.totalSamples -= countedRows(chunk)
      this.chunks.delete(key)
    }

    const stored = this.sessions.get(truncation.sessionId)
    if (stored !== undefined) {
      // The session says where its retained data really begins, so no view can imply it began
      // where what survives begins.
      this.put({
        ...stored,
        sealedSamples: Math.max(0, stored.sealedSamples - truncation.freedSamples),
        retainedFrom: truncation.retainedFrom,
      })
    }

    return { prunedSessionIds: plan.evict, truncatedFrom: truncation.retainedFrom }
  }

  private chunksOf(id: SessionId, stream: StreamName, window: TimeWindow): HistoryChunk[] {
    return this.storedChunksOf(id, stream, window).map((chunk) => structuredClone(chunk))
  }

  private storedChunksOf(id: SessionId, stream: StreamName, window: TimeWindow): HistoryChunk[] {
    return [...this.chunks.values()]
      .filter((chunk) => chunk.sessionId === id && chunk.stream === stream && overlaps(chunk, window))
      .sort((left, right) => left.seq - right.seq)
  }

  /** What the session covers on the wall clock, from the rows it actually holds. */
  private spanOf(record: SessionRecord): TimeWindow {
    let from = record.startedAt
    let to = record.endedAt ?? record.startedAt

    for (const chunk of this.chunks.values()) {
      if (chunk.sessionId !== record.id || chunk.length === 0) continue
      from = Math.min(from, firstSampleAt(chunk))
      to = Math.max(to, lastSampleAt(chunk))
    }
    return { from, to: Math.max(from, to) }
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

/** Descending [sessionId, seq], matching how a 'prev' cursor on the byTime index breaks equal-`at`. */
function compareWarningKeyDesc(left: WarningRecord, right: WarningRecord): number {
  if (left.sessionId !== right.sessionId) return left.sessionId > right.sessionId ? -1 : 1
  return right.seq - left.seq
}

/** Ascending [sessionId, seq], matching how a forward cursor on the byTime index breaks equal-`at`. */
function compareWarningKeyAsc(left: WarningRecord, right: WarningRecord): number {
  if (left.sessionId !== right.sessionId) return left.sessionId > right.sessionId ? 1 : -1
  return left.seq - right.seq
}

/** Rows the archive counter has been told about. An unsealed tail has told it nothing yet. */
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

/**
 * Whether the adapter would have caught this rather than let it out.
 *
 * A full disk arrives as a quota error on the request, and Chromium can also surface it at commit
 * time as a bare abort with no request error at all — which is why both names are named here and
 * why the port carries exactly one write-failure reason for the pair of them.
 */
function isCaughtWriteFailure(error: Error): boolean {
  return error.name === 'QuotaExceededError' || error.name === 'AbortError'
}
