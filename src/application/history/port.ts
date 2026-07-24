/**
 * The seam the archive is reached through, and the store that exists when there is no archive.
 *
 * Everything above this line — the recorder, the archive view, the export — is written against
 * this interface and never against IndexedDB. That is what lets the recorder's whole state
 * machine be exercised with a Map behind it, in a browser environment that has no database at
 * all, and it is why the interface has to be complete: a caller that reaches around the port for
 * one thing it cannot express here takes that one thing out of every test above it.
 *
 * Two rules shape the surface.
 *
 * A store executes plans and never makes them. What to evict is decided by a pure function over
 * session rows; the store is handed the plan and carries it out in the same transaction as the
 * write that overran the budget. So the eviction policy is testable with no database, and the
 * adapter holds no policy to disagree with.
 *
 * Nothing here throws for being unavailable. A browser with no IndexedDB, or one that refused to
 * open the database, gets a store whose every method answers honestly and stores nothing. Honest
 * degradation is a value rather than a branch: the application layer has one availability check,
 * where it prints the reason, instead of a null test at every call site.
 */

import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../../domain/bms/types'
import type {
  CoverageRun,
  DeviceKey,
  DeviceRecord,
  HistoryChunk,
  PackChunk,
  SessionEndReason,
  SessionEntry,
  SessionId,
  SessionLedger,
  SessionRecord,
  SolarChunk,
  StreamName,
  TimeWindow,
  WarningRecord,
} from '../../domain/history/types'
import type { SolarReading } from '../../domain/solar/types'

export type HistoryUnavailableReason =
  /** The API is absent: Safari private browsing, and several in-app browsers. */
  | 'no-indexeddb'
  /** open() rejected. */
  | 'open-denied'
  /** Another tab holds an older version of the database open. */
  | 'open-blocked'
  /** What is on disk was written by a newer build of this page, and is never deleted for it. */
  | 'version-newer'
  /** Writes are aborting. */
  | 'quota-exhausted'

export interface HistoryAvailability {
  readonly usable: boolean
  readonly reason: HistoryUnavailableReason | null
  /** navigator.storage.persist(); null when the browser will not say, which is common. */
  readonly persisted: boolean | null
  /** navigator.storage.estimate(); one display line, and never an input to pruning. */
  readonly estimatedBytes: number | null
  readonly quotaBytes: number | null
}

export interface CommitOutcome {
  readonly stored: boolean
  readonly totalSamples: number
  readonly prunedSessionIds: readonly SessionId[]
  /** Wall clock of the first row that survived a truncation, or null when nothing was cut. */
  readonly truncatedFrom: number | null
  readonly failure: HistoryUnavailableReason | null
}

/**
 * The fields the recorder owns, merged over the stored row on every commit.
 *
 * `sealedSamples` is deliberately absent. It counts rows in sealed chunks and the store is the
 * only party that knows which chunks it holds sealed, so letting a writer assert it would let two
 * tabs disagree about the archive's total with nothing able to arbitrate.
 */
export interface SessionPatch {
  readonly heartbeatAt: number
  readonly packSamples: number
  readonly solarSamples: number
  readonly packChunks: number
  readonly solarChunks: number
  readonly droppedChunks: number
  readonly coverage: readonly CoverageRun[]
  readonly ledger: SessionLedger
  readonly entries: readonly SessionEntry[]
  readonly packDeviceKey: DeviceKey | null
  readonly solarDeviceKey: DeviceKey | null
  readonly groupKey: DeviceKey
  readonly deviceInfo: DeviceInfo | null
  readonly settings: BmsSettings | null
  readonly finalBattery: BatterySnapshot | null
  readonly finalSolar: SolarReading | null
}

export interface SessionClosure extends SessionPatch {
  readonly endedAt: number
  readonly endReason: SessionEndReason
}

/** The list row. Carries no chunk, so the archive list costs one index scan at any size. */
export interface SessionListing {
  readonly record: SessionRecord
  /** The device the session groups under, or null when its row has not been written yet. */
  readonly device: DeviceRecord | null
  /** What to print: the owner's name for the device, else the derived one, else the fallback. */
  readonly label: string
}

export interface StoredSession {
  readonly record: SessionRecord
  readonly packDevice: DeviceRecord | null
  readonly solarDevice: DeviceRecord | null
  /** Chunks, not samples. Hydrating two million objects to fill two thousand pixels is the cost
   *  the columnar layout exists to avoid, so the thinning happens after this. */
  readonly pack: readonly PackChunk[]
  readonly solar: readonly SolarChunk[]
  /** True when the span asked for was wider than one read may return. */
  readonly windowClamped: boolean
}

/**
 * The widest span a single read may cover.
 *
 * The session view's clock band is a noon-to-noon day, so nothing it draws is wider than this,
 * and a read returning more would hydrate chunks no pixel could show. A longer session is
 * returned from its latest data backwards with `windowClamped` set, so the view can say it is
 * looking at a window onto the session rather than at the whole of it.
 */
export const MAX_RENDER_WINDOW_MS = 24 * 60 * 60_000

export interface RenderWindow {
  readonly window: TimeWindow
  readonly clamped: boolean
}

/**
 * The span a read actually covers: what was asked for, intersected with what the session holds,
 * cut to `MAX_RENDER_WINDOW_MS` from its late end.
 *
 * It belongs to the port rather than to either implementation because both have to answer
 * identically — the same session read through a Map and through IndexedDB must draw the same
 * ribbon, and a clamp invented twice is a clamp that will eventually differ.
 */
export function renderWindowFor(available: TimeWindow, requested?: TimeWindow): RenderWindow {
  const from = requested === undefined ? available.from : Math.max(available.from, requested.from)
  const requestedTo = requested === undefined ? available.to : Math.min(available.to, requested.to)
  // An intersection with nothing in it is an empty window, never an inverted one.
  const to = Math.max(from, requestedTo)

  if (to - from <= MAX_RENDER_WINDOW_MS) return { window: { from, to }, clamped: false }
  return { window: { from: to - MAX_RENDER_WINDOW_MS, to }, clamped: true }
}

export interface HistoryStore {
  readonly availability: HistoryAvailability

  openSession(record: SessionRecord): Promise<void>
  /**
   * Writes the chunk, merges the session patch, moves the archive counter — for a seal only —
   * and executes the prune plan, all as one indivisible write.
   *
   * A chunk whose session was never opened is refused rather than stored: a session row invented
   * here would carry none of the fields only the recorder knows, and would be indistinguishable
   * from a real one afterwards.
   */
  commitChunk(chunk: HistoryChunk, patch: SessionPatch): Promise<CommitOutcome>
  /** Folds the unsealed tails into the counted totals, exactly once, and closes the row. */
  closeSession(id: SessionId, closure: SessionClosure): Promise<void>
  /** Row and chunks die together. An orphan chunk is unreachable and holds budget forever. */
  deleteSession(id: SessionId): Promise<void>

  /**
   * Appends one warning episode. Out of the sample budget — warnings are bounded per session and
   * die with it, so they never trip pruning and pruning never counts them.
   */
  appendWarning(record: WarningRecord): Promise<void>
  /** Every warning of one session, in the order they fired. */
  warningsOf(id: SessionId): Promise<readonly WarningRecord[]>
  /** Warnings across every session, most recent first, for the standalone log. */
  listWarnings(limit?: number): Promise<readonly WarningRecord[]>
  /**
   * Every warning whose `at` lies inside the window, across every session. Read straight off the
   * time index and uncapped, so a wide range's tally counts the whole window rather than only the
   * most recent few the standalone log holds.
   */
  warningsInWindow(window: TimeWindow): Promise<readonly WarningRecord[]>

  /** Newest first. */
  listSessions(limit?: number): Promise<readonly SessionListing[]>
  listDevices(): Promise<readonly DeviceRecord[]>
  readSession(id: SessionId, window?: TimeWindow): Promise<StoredSession | null>
  /** Streams chunks one at a time, so peak memory is one chunk rather than one session. */
  streamChunks(
    id: SessionId,
    stream: StreamName,
    window: TimeWindow,
    visit: (chunk: HistoryChunk) => void,
  ): Promise<void>

  /**
   * Merges a derived device row over the stored one. It never clears a name the owner chose:
   * `userLabel` belongs to `renameDevice` alone, so a reconnect cannot undo a rename.
   */
  upsertDevice(record: DeviceRecord): Promise<DeviceRecord>
  /**
   * Read and write as one indivisible step, so two tabs cannot interleave into a lost update.
   * An empty label restores the derived default rather than blanking the device.
   */
  renameDevice(key: DeviceKey, label: string | null): Promise<DeviceRecord | null>

  /**
   * Runs once on open. Closes sessions a killed tab left open, deletes the ones that recorded
   * nothing, and sweeps chunks whose session row is gone. Never destructive to a session that
   * still holds rows — a merely frozen tab must find its work intact when it thaws.
   */
  recover(now: number): Promise<{ readonly closed: number; readonly orphansRemoved: number }>
  usage(): Promise<{ readonly totalSamples: number; readonly sessions: number }>
  /**
   * Fires when another tab changed the archive. Returns an unsubscribe, like watchAdapter.
   *
   * A store never notifies its own writer: this is carried by BroadcastChannel, which does not
   * deliver to the context that posted, and a view refreshing itself off its own writes would
   * reload the list under the user on every checkpoint.
   */
  watch(onChanged: () => void): () => void
  close(): void

  /**
   * The session on screen, which pruning must not evict from under the reader.
   *
   * Optional because a store with no budget has nothing to protect, and because protection is
   * ultimately derived from stored fields — a second tab cannot be told what this one is reading,
   * so a reader whose session is pruned elsewhere still has to survive `readSession → null`.
   */
  noteViewing?(id: SessionId | null): void
}

/**
 * The store for a browser that cannot keep an archive. Never throws, never returns null for a
 * shape that has one, and stores nothing.
 *
 * Every read answers as an empty archive, which is true, and every write reports the reason it
 * did not happen, which is the sentence the storage line prints. Nothing above has to ask whether
 * it holds a store.
 */
export function unavailableHistoryStore(reason: HistoryUnavailableReason): HistoryStore {
  const availability: HistoryAvailability = {
    usable: false,
    reason,
    persisted: null,
    estimatedBytes: null,
    quotaBytes: null,
  }

  return {
    availability,
    openSession: async () => undefined,
    commitChunk: async () => ({
      stored: false,
      totalSamples: 0,
      prunedSessionIds: [],
      truncatedFrom: null,
      failure: reason,
    }),
    closeSession: async () => undefined,
    deleteSession: async () => undefined,
    appendWarning: async () => undefined,
    warningsOf: async () => [],
    listWarnings: async () => [],
    warningsInWindow: async () => [],
    listSessions: async () => [],
    listDevices: async () => [],
    readSession: async () => null,
    streamChunks: async () => undefined,
    // The row it was handed, so a caller may still name the device on screen for this page load.
    upsertDevice: async (record: DeviceRecord) => record,
    renameDevice: async () => null,
    recover: async () => ({ closed: 0, orphansRemoved: 0 }),
    usage: async () => ({ totalSamples: 0, sessions: 0 }),
    watch: () => () => undefined,
    close: () => undefined,
  }
}
