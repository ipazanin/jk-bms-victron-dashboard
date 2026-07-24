/**
 * The archive, as the views read it.
 *
 * Everything in this module is a read. The recorder writes and never shares memory with what is
 * shown here, so the Log is a statement about what is on disk rather than about what this tab
 * happens to remember — which is the only way a second tab's recording can appear in this one.
 *
 * The store arrives late and may never arrive at all. Probing IndexedDB is asynchronous, first
 * paint must not wait for it, and a browser in private mode answers with a store that refuses
 * every write. So each accessor tolerates a null store, and a session deep-linked before the
 * database was even open is loaded once the probe answers rather than reported as missing.
 *
 * Chunks are hydrated into samples exactly once, when a session is loaded. The port hands over
 * typed arrays because that is what makes the transfer out of IndexedDB cheap; the ribbon, the
 * ledger and the table all want sample objects, and decoding them again on every redraw is the
 * expensive mistake this shape exists to prevent.
 */

import { computed, ref, shallowRef } from 'vue'
import type { ComputedRef, Ref } from 'vue'

import { MAX_TOTAL_SAMPLES, PRUNE_TARGET_RATIO } from '../../domain/history/budget'
import { decodePackChunk, decodeSolarChunk, isReadableLayout } from '../../domain/history/columns'
import {
  estimateExportBytes,
  exportFileName,
  exportSessionParts,
} from '../../domain/history/exportDocument'
import { deviceLabel } from '../../domain/history/identity'
import { MAX_PAIRING_AGE_MS, pairSamples } from '../../domain/history/join'
import type { PairedSample } from '../../domain/history/join'
import { recomputeAccount, recomputeLedger } from '../../domain/history/ledger'
import type { SessionAccount } from '../../domain/history/ledger'
import { PACK_STREAM, SAMPLE_INTERVAL_MS, SOLAR_STREAM } from '../../domain/history/types'
import type {
  DeviceKey,
  DeviceRecord,
  PackSample,
  SessionId,
  SessionRecord,
  SolarSample,
  TimeWindow,
  WarningRecord,
} from '../../domain/history/types'
import type { HistoryAvailability, HistoryStore, SessionListing, StoredSession } from './port'
import { POWER_COLUMNS, powerTracks } from './statsRange'
import type { PowerTracks, SessionSamples } from './statsRange'

/** The standalone warnings log reads this many at most, most recent first. */
const WARNING_LIST_LIMIT = 500

/** The export is deliberately never windowed: a file holding part of a session would read as all
 *  of it, and on iOS it is the only copy anybody keeps. */
const ENTIRE_SESSION: TimeWindow = { from: 0, to: Number.MAX_SAFE_INTEGER }

export type ExportState = 'idle' | 'working' | 'done' | 'failed'

/** One device and everything it recorded, which is the unit the Log is read in. */
export interface SessionGroup {
  readonly key: DeviceKey
  /** Null when the archive holds sessions for a device row that pruning or a rename outlived. */
  readonly device: DeviceRecord | null
  readonly label: string
  /** Newest first. */
  readonly sessions: readonly SessionListing[]
  readonly recordedMs: number
}

export interface ArchiveSummary {
  readonly sessions: number
  readonly recordedMs: number
  /** Null on an empty archive. Drives the landing page's "back to 3 March". */
  readonly oldestStartedAt: number | null
}

export interface ArchiveUsage {
  readonly totalSamples: number
  readonly sessions: number
  readonly capacitySamples: number
  readonly usedRatio: number
  /** At the pruning target, so the warning appears before the first eviction rather than after. */
  readonly nearCapacity: boolean
}

/**
 * One session, decoded. The sample arrays and the paired timeline are built once at load and are
 * then shared by every band of the session view, so scrubbing and resizing cost nothing.
 */
export interface LoadedSession {
  readonly record: SessionRecord
  readonly packDevice: DeviceRecord | null
  readonly solarDevice: DeviceRecord | null
  readonly label: string
  readonly pack: readonly PackSample[]
  readonly solar: readonly SolarSample[]
  readonly timeline: readonly PairedSample[]
  /** What was actually read, which is not the session's own span when the read was clamped. */
  readonly window: TimeWindow
  readonly windowClamped: boolean
  /** Chunks written by a newer build of this page. Skipped, never deleted, always declared. */
  readonly unreadableChunks: number
}

export interface ExportSize {
  readonly rows: number
  readonly bytes: number
}

/**
 * The per-sample power trace for a range window, read across every session that overlaps it.
 *
 * Kept apart from `loaded`: the Stats power chart and the Session view read different spans for
 * different reasons, and a shared slot would have them evicting each other's work. A window here is
 * never protected from pruning — it is a scan of what is on disk, and a pruned session simply yields
 * an honest gap rather than being held back.
 */
export interface WindowPower {
  readonly window: TimeWindow
  readonly tracks: PowerTracks
  /** Overlapping sessions actually read; a skipped or vanished one does not count. */
  readonly sessions: number
  /** Any session read hit `MAX_RENDER_WINDOW_MS`. Never fires for hour or day, both ≤ 24 h. */
  readonly clamped: boolean
}

/**
 * Every ref here is exposed read-only by type rather than through Vue's `readonly()`. That helper
 * is deep: wrapping the loaded session would hand out a proxy that re-wraps every sample object on
 * every access, on arrays tens of thousands of rows long.
 */
export interface HistoryBrowser {
  /** Null until the storage probe answers — which is not the same as unavailable. */
  readonly availability: ComputedRef<HistoryAvailability | null>
  readonly sessions: Readonly<Ref<readonly SessionListing[]>>
  readonly devices: Readonly<Ref<readonly DeviceRecord[]>>
  /** Warnings across every session, most recent first, refreshed with the session list. */
  readonly warnings: Readonly<Ref<readonly WarningRecord[]>>
  readonly groups: ComputedRef<readonly SessionGroup[]>
  readonly archive: ComputedRef<ArchiveSummary>
  readonly usage: Readonly<Ref<ArchiveUsage | null>>
  readonly refreshing: Readonly<Ref<boolean>>
  readonly loading: Readonly<Ref<boolean>>
  readonly loaded: Readonly<Ref<LoadedSession | null>>
  /** The id of a link that resolved to nothing, so the list can say the session was dropped. */
  readonly missing: Readonly<Ref<SessionId | null>>
  /** What the store said when a read failed. Null when nothing has failed. */
  readonly failure: Readonly<Ref<string | null>>
  readonly selection: Readonly<Ref<TimeWindow | null>>
  /** The stored account, or the account re-integrated over the brush selection. Re-integration
   *  walks every sample in the selection, so a drag should settle before it lands in `select`. */
  readonly account: ComputedRef<SessionAccount | null>
  readonly exportSize: ComputedRef<ExportSize | null>
  readonly exportState: Readonly<Ref<ExportState>>
  /** The per-sample power trace for the last loaded range window, or null when none is loaded. */
  readonly windowPower: Readonly<Ref<WindowPower | null>>
  readonly powerLoading: Readonly<Ref<boolean>>
  /**
   * Every warning inside the last range window read, or null until that read resolves. Kept apart
   * from the capped `warnings` list so a Stats range tally counts the whole window rather than the
   * most recent few — the view falls back to `warnings` only while this is null.
   */
  readonly windowWarnings: Readonly<Ref<readonly WarningRecord[] | null>>

  refresh(): Promise<void>
  loadSession(id: SessionId, window?: TimeWindow): Promise<void>
  unloadSession(): void
  /** Reads every session overlapping `window` and derives a downsampled power trace across them. */
  loadWindowPower(window: TimeWindow, columns?: number): Promise<void>
  /** Releases the loaded window and supersedes any read in flight. */
  clearWindowPower(): void
  /** Reads every warning inside `window`, uncapped, for an honest range tally. Latest wins. */
  loadWindowWarnings(window: TimeWindow): Promise<void>
  select(window: TimeWindow | null): void
  renameDevice(key: DeviceKey, label: string | null): Promise<void>
  deleteSession(id: SessionId): Promise<void>
  downloadSession(): Promise<void>
  dispose(): void
}

export interface HistoryBrowserDeps {
  /** Called on every access rather than captured: the probe resolves after this model is built,
   *  and a captured null would leave the Log empty for the life of the tab. */
  readonly store: () => HistoryStore | null
  readonly now: () => number
  /** Turning a document into a file is the infrastructure's job. It is handed the parts rather
   *  than a string so the whole export is never held twice. */
  readonly download: (fileName: string, parts: Iterable<string>) => void
}

/**
 * How long a session ran, in milliseconds.
 *
 * A clock stepped backwards mid-session can leave `endedAt` before `startedAt`, so a span that is
 * not positive falls back to the sample count — one row a second is the recorder's own gate, and no
 * clock adjustment can corrupt a count. An open session is measured against the caller's clock, so
 * a live row in the list grows if the caller re-reads it.
 */
export function sessionDurationMs(record: SessionRecord, now: number): number {
  const endedAt = record.endedAt ?? (record.state === 'open' ? now : record.heartbeatAt)
  const span = endedAt - record.startedAt
  if (span > 0) return span
  return Math.max(record.packSamples, record.solarSamples) * SAMPLE_INTERVAL_MS
}

export function createHistoryBrowser(deps: HistoryBrowserDeps): HistoryBrowser {
  const sessions = shallowRef<readonly SessionListing[]>([])
  const devices = shallowRef<readonly DeviceRecord[]>([])
  const warnings = shallowRef<readonly WarningRecord[]>([])
  const usage = ref<ArchiveUsage | null>(null)
  const refreshing = ref(false)
  const loading = ref(false)
  const loaded = shallowRef<LoadedSession | null>(null)
  const missing = ref<SessionId | null>(null)
  const failure = ref<string | null>(null)
  const selection = shallowRef<TimeWindow | null>(null)
  const exportState = ref<ExportState>('idle')
  const windowPower = shallowRef<WindowPower | null>(null)
  const powerLoading = ref(false)
  const windowWarnings = shallowRef<readonly WarningRecord[] | null>(null)
  /** Frozen at each refresh so the durations below are a pure function of reactive state; a
   *  component that wants a live figure calls sessionDurationMs with its own ticking clock. */
  const listedAt = ref(0)

  let requestedId: SessionId | null = null
  let requestedWindow: TimeWindow | undefined
  /** A request the probe was not ready for, replayed once a store exists. Never a request that
   *  was attempted and answered — a session that is genuinely gone must not be asked for again. */
  let deferredId: SessionId | null = null
  let listToken = 0
  let loadToken = 0
  let powerToken = 0
  let windowWarningsToken = 0
  let unsubscribe: (() => void) | null = null
  let subscribedTo: HistoryStore | null = null

  const availability = computed<HistoryAvailability | null>(() => deps.store()?.availability ?? null)

  const groups = computed<readonly SessionGroup[]>(() => {
    const byKey = new Map<DeviceKey, SessionListing[]>()
    for (const listing of sessions.value) {
      const rows = byKey.get(listing.record.groupKey)
      if (rows) rows.push(listing)
      else byKey.set(listing.record.groupKey, [listing])
    }

    const at = listedAt.value
    const built: SessionGroup[] = []
    for (const [key, rows] of byKey) {
      const device = devices.value.find((record) => record.key === key) ?? rows[0].device
      built.push({
        key,
        device,
        label: deviceLabel(device, rows[0].label),
        sessions: rows,
        recordedMs: rows.reduce((total, row) => total + sessionDurationMs(row.record, at), 0),
      })
    }

    // The group holding the newest session leads, so reopening the page after a watch puts that
    // watch at the top rather than wherever its device first appeared.
    built.sort(
      (left, right) => right.sessions[0].record.startedAt - left.sessions[0].record.startedAt,
    )
    return built
  })

  const archive = computed<ArchiveSummary>(() => {
    const rows = sessions.value
    const at = listedAt.value
    let recordedMs = 0
    let oldestStartedAt: number | null = null
    for (const row of rows) {
      recordedMs += sessionDurationMs(row.record, at)
      if (oldestStartedAt === null || row.record.startedAt < oldestStartedAt) {
        oldestStartedAt = row.record.startedAt
      }
    }
    return { sessions: rows.length, recordedMs, oldestStartedAt }
  })

  const account = computed<SessionAccount | null>(() => {
    const session = loaded.value
    if (session === null) return null

    const window = selection.value
    if (window === null) return { ledger: session.record.ledger, coverage: session.record.coverage }

    // A selection is re-integrated from the samples rather than scaled out of the stored ledger:
    // the identity holds over a window, and prorating an account across one is not the same thing.
    return recomputeAccount(
      within(session.pack, window),
      within(session.solar, window),
      MAX_PAIRING_AGE_MS,
    )
  })

  const exportSize = computed<ExportSize | null>(() => {
    const record = loaded.value?.record
    if (!record) return null
    return {
      rows: record.packSamples + record.solarSamples,
      bytes: estimateExportBytes(record.packSamples, record.solarSamples),
    }
  })

  async function refresh(): Promise<void> {
    const store = activeStore()
    if (!store) return

    const token = (listToken += 1)
    refreshing.value = true
    try {
      const [listed, known, totals, warned] = await Promise.all([
        store.listSessions(),
        store.listDevices(),
        store.usage(),
        store.listWarnings(WARNING_LIST_LIMIT),
      ])
      if (token !== listToken) return
      sessions.value = listed
      devices.value = known
      warnings.value = warned
      usage.value = usageOf(totals.totalSamples, totals.sessions)
      listedAt.value = deps.now()
      failure.value = null
    } catch (error) {
      if (token === listToken) failure.value = describeFailure(error)
    } finally {
      if (token === listToken) refreshing.value = false
    }

    // A session deep-linked before the probe answered was held rather than reported missing.
    if (deferredId !== null) await read()
  }

  function loadSession(id: SessionId, window?: TimeWindow): Promise<void> {
    const already = loaded.value
    const settled = already !== null && already.record.id === id && !loading.value
    if (settled && window === undefined) return Promise.resolve()

    if (already?.record.id !== id) {
      loaded.value = null
      selection.value = null
      exportState.value = 'idle'
    }
    requestedId = id
    requestedWindow = window
    missing.value = null
    return read()
  }

  function unloadSession(): void {
    requestedId = null
    requestedWindow = undefined
    deferredId = null
    loadToken += 1
    loading.value = false
    loaded.value = null
    selection.value = null
    missing.value = null
    exportState.value = 'idle'
    // Nothing is on screen, so pruning is free to reclaim whatever it was holding back.
    deps.store()?.noteViewing?.(null)
  }

  /**
   * Reads every session overlapping the window and derives one downsampled power trace across them.
   *
   * The overlapping sessions are found in the cached list, so no chunk is read to discover them;
   * each is then read for the window alone (clamped to 24 h in the port, harmless for hour and day),
   * decoded, and handed to `powerTracks`. Latest wins by token, so switching ranges quickly
   * supersedes a read still in flight rather than letting a stale one land.
   */
  async function loadWindowPower(window: TimeWindow, columns = POWER_COLUMNS): Promise<void> {
    const store = activeStore()
    if (!store) {
      windowPower.value = null
      return
    }

    const token = (powerToken += 1)
    powerLoading.value = true
    try {
      const overlapping = sessions.value
        .filter(
          (listing) =>
            listing.record.startedAt <= window.to &&
            (listing.record.endedAt ?? listing.record.heartbeatAt) >= window.from,
        )
        .slice()
        .sort((left, right) => left.record.startedAt - right.record.startedAt)

      const runs: SessionSamples[] = []
      let clamped = false
      for (const listing of overlapping) {
        const stored = await store.readSession(listing.record.id, window)
        if (token !== powerToken) return
        if (stored === null) continue
        if (stored.windowClamped) clamped = true
        const { pack, solar } = decodeStored(stored)
        runs.push({ pack, solar })
      }

      windowPower.value = {
        window,
        tracks: powerTracks(runs, window, columns),
        sessions: runs.length,
        clamped,
      }
    } catch {
      // A window that could not be read is honestly no per-sample data, which the chart already
      // draws as such. Kept off the shared failure line so a Stats read cannot alarm the Log.
      if (token === powerToken) windowPower.value = null
    } finally {
      if (token === powerToken) powerLoading.value = false
    }
  }

  function clearWindowPower(): void {
    powerToken += 1
    powerLoading.value = false
    windowPower.value = null
  }

  /**
   * Reads every warning inside the window, uncapped, so a range tally counts the whole window
   * rather than the most recent few the standalone log caps at. Isolated like `loadWindowPower`:
   * latest wins by token, and it never touches the shared `warnings` list or `failure` line. Reset
   * to null before the read so the capped list stands in until this window's own answer lands.
   */
  async function loadWindowWarnings(window: TimeWindow): Promise<void> {
    const store = activeStore()
    if (!store) {
      windowWarnings.value = null
      return
    }

    const token = (windowWarningsToken += 1)
    windowWarnings.value = null
    try {
      const found = await store.warningsInWindow(window)
      if (token !== windowWarningsToken) return
      windowWarnings.value = found
    } catch {
      // A windowed read that failed is honestly no windowed tally; the view falls back to the
      // capped list. Kept off the shared failure line so a Stats read cannot alarm the Log.
      if (token === windowWarningsToken) windowWarnings.value = null
    }
  }

  function select(window: TimeWindow | null): void {
    // A drag that never moved selects nothing rather than an empty window, which would print a
    // ledger of zeros where the session's own figures were.
    selection.value = window === null || window.to <= window.from ? null : window
  }

  async function renameDevice(key: DeviceKey, label: string | null): Promise<void> {
    const store = deps.store()
    if (!store) return

    const chosen = label?.trim() ?? ''
    try {
      const renamed = await store.renameDevice(key, chosen === '' ? null : chosen)
      if (renamed) relabelLoaded(renamed)
    } catch (error) {
      failure.value = describeFailure(error)
      return
    }
    // A rename in this tab gets no BroadcastChannel message of its own — the channel does not
    // deliver to the context that posted — so the list is re-read here.
    await refresh()
  }

  async function deleteSession(id: SessionId): Promise<void> {
    const store = deps.store()
    if (!store) return

    try {
      await store.deleteSession(id)
    } catch (error) {
      failure.value = describeFailure(error)
      return
    }
    if (requestedId === id || loaded.value?.record.id === id) unloadSession()
    await refresh()
  }

  async function downloadSession(): Promise<void> {
    const session = loaded.value
    const store = deps.store()
    if (!session || !store) return

    exportState.value = 'working'
    try {
      const pack: PackSample[] = []
      const solar: SolarSample[] = []
      // Streamed rather than taken from the loaded session: what is loaded may be a clamped
      // window, and the file has to be the whole recording.
      await store.streamChunks(session.record.id, PACK_STREAM, ENTIRE_SESSION, (chunk) => {
        if (chunk.stream !== PACK_STREAM || !isReadableLayout(chunk.layout)) return
        appendAll(pack, decodePackChunk(chunk))
      })
      await store.streamChunks(session.record.id, SOLAR_STREAM, ENTIRE_SESSION, (chunk) => {
        if (chunk.stream !== SOLAR_STREAM || !isReadableLayout(chunk.layout)) return
        appendAll(solar, decodeSolarChunk(chunk))
      })

      deps.download(
        exportFileName(session.label, session.record.startedAt),
        exportSessionParts({
          record: session.record,
          packDevice: session.packDevice,
          solarDevice: session.solarDevice,
          recomputedLedger: recomputeLedger(pack, solar, MAX_PAIRING_AGE_MS),
          pack,
          solar,
          generatedAt: deps.now(),
        }),
      )
      exportState.value = 'done'
    } catch (error) {
      failure.value = describeFailure(error)
      exportState.value = 'failed'
    }
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    subscribedTo = null
    listToken += 1
    loadToken += 1
  }

  async function read(): Promise<void> {
    const id = requestedId
    if (id === null) return

    const store = activeStore()
    if (!store) {
      // The probe has not answered. Reporting the session missing here would be a guess about a
      // database nobody has opened yet, so the request waits instead.
      deferredId = id
      return
    }
    deferredId = null
    // Declared before the read, so a prune fired by another tab's checkpoint mid-read cannot take
    // the session out from under it.
    store.noteViewing?.(id)

    const token = (loadToken += 1)
    loading.value = true
    try {
      const stored = await store.readSession(id, requestedWindow)
      if (token !== loadToken) return
      if (stored === null) {
        loaded.value = null
        missing.value = id
        return
      }
      loaded.value = hydrate(stored)
      missing.value = null
      failure.value = null
    } catch (error) {
      if (token !== loadToken) return
      loaded.value = null
      failure.value = describeFailure(error)
    } finally {
      if (token === loadToken) loading.value = false
    }
  }

  /**
   * The store, subscribed to the first time the probe offers one. Called from each entry point
   * rather than from a watcher, so this model needs no reactive effect scope to work.
   */
  function activeStore(): HistoryStore | null {
    const store = deps.store()
    if (store === null || store === subscribedTo) return store

    unsubscribe?.()
    subscribedTo = store
    unsubscribe = store.watch(() => {
      void refresh().catch(() => undefined)
    })
    return store
  }

  function relabelLoaded(renamed: DeviceRecord): void {
    const session = loaded.value
    if (!session) return

    const packDevice = session.packDevice?.key === renamed.key ? renamed : session.packDevice
    const solarDevice = session.solarDevice?.key === renamed.key ? renamed : session.solarDevice
    if (packDevice === session.packDevice && solarDevice === session.solarDevice) return

    // Patched rather than re-read: the name is a string and the session behind it is megabytes of
    // samples that did not change.
    loaded.value = {
      ...session,
      packDevice,
      solarDevice,
      label: deviceLabel(packDevice ?? solarDevice, session.label),
    }
  }

  function usageOf(totalSamples: number, sessionCount: number): ArchiveUsage {
    return {
      totalSamples,
      sessions: sessionCount,
      capacitySamples: MAX_TOTAL_SAMPLES,
      usedRatio: totalSamples / MAX_TOTAL_SAMPLES,
      nearCapacity: totalSamples >= MAX_TOTAL_SAMPLES * PRUNE_TARGET_RATIO,
    }
  }

  return {
    availability,
    sessions,
    devices,
    warnings,
    groups,
    archive,
    usage,
    refreshing,
    loading,
    loaded,
    missing,
    failure,
    selection,
    account,
    exportSize,
    exportState,
    windowPower,
    powerLoading,
    windowWarnings,
    refresh,
    loadSession,
    unloadSession,
    loadWindowPower,
    clearWindowPower,
    loadWindowWarnings,
    select,
    renameDevice,
    deleteSession,
    downloadSession,
    dispose,
  }
}

interface DecodedStreams {
  readonly pack: PackSample[]
  readonly solar: SolarSample[]
  /** Chunks this build cannot read, skipped and counted rather than guessed at. */
  readonly unreadableChunks: number
}

/**
 * Chunks to samples. Chunks arrive in seq order and rows inside one are ascending, so the
 * concatenation is already the timeline. Shared by the session loader and the window-power loader
 * so both decode a stored session by exactly one rule.
 */
function decodeStored(stored: StoredSession): DecodedStreams {
  const pack: PackSample[] = []
  const solar: SolarSample[] = []
  let unreadableChunks = 0

  for (const chunk of stored.pack) {
    if (!isReadableLayout(chunk.layout)) unreadableChunks += 1
    else appendAll(pack, decodePackChunk(chunk))
  }
  for (const chunk of stored.solar) {
    if (!isReadableLayout(chunk.layout)) unreadableChunks += 1
    else appendAll(solar, decodeSolarChunk(chunk))
  }

  return { pack, solar, unreadableChunks }
}

function hydrate(stored: StoredSession): LoadedSession {
  const { pack, solar, unreadableChunks } = decodeStored(stored)

  const device = stored.packDevice ?? stored.solarDevice
  return {
    record: stored.record,
    packDevice: stored.packDevice,
    solarDevice: stored.solarDevice,
    label: deviceLabel(device),
    pack,
    solar,
    timeline: pairSamples(pack, solar, MAX_PAIRING_AGE_MS),
    window: windowOf(stored.record, pack, solar),
    windowClamped: stored.windowClamped,
    unreadableChunks,
  }
}

/**
 * What the loaded rows actually span, which is what every axis is drawn against. The session's own
 * stamps are the fallback and not the answer: a clamped read holds a slice, and a pruned head
 * starts later than the session did.
 */
function windowOf(
  record: SessionRecord,
  pack: readonly PackSample[],
  solar: readonly SolarSample[],
): TimeWindow {
  const first = firstStamp(pack, solar) ?? record.retainedFrom ?? record.startedAt
  const last = lastStamp(pack, solar) ?? record.endedAt ?? record.heartbeatAt
  // A single sample, or none, still needs a window with width, or every scale divides by zero.
  return { from: first, to: last > first ? last : first + SAMPLE_INTERVAL_MS }
}

function firstStamp(pack: readonly PackSample[], solar: readonly SolarSample[]): number | null {
  if (pack.length === 0 && solar.length === 0) return null
  if (pack.length === 0) return solar[0].at
  if (solar.length === 0) return pack[0].at
  return Math.min(pack[0].at, solar[0].at)
}

function lastStamp(pack: readonly PackSample[], solar: readonly SolarSample[]): number | null {
  if (pack.length === 0 && solar.length === 0) return null
  if (pack.length === 0) return solar[solar.length - 1].at
  if (solar.length === 0) return pack[pack.length - 1].at
  return Math.max(pack[pack.length - 1].at, solar[solar.length - 1].at)
}

function within<TSample extends { readonly at: number }>(
  samples: readonly TSample[],
  window: TimeWindow,
): TSample[] {
  return samples.filter((sample) => sample.at >= window.from && sample.at <= window.to)
}

/** A spread would pass one argument per row: measured on this engine, 125,000 arguments throws
 *  RangeError, and a browsed session is not bounded by ten minutes. */
function appendAll<TSample>(target: TSample[], samples: readonly TSample[]): void {
  for (const sample of samples) target.push(sample)
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : ''
  return message || 'The log could not be read.'
}

/**
 * The shared read model, and the one call that wires it to the browser.
 *
 * The environment is handed over in one piece after the storage probe answers, rather than
 * imported here, because both halves of it are adapters: the store is IndexedDB and the download
 * is an object URL. The application layer states what it needs and the composition root supplies
 * it, which is also what lets a test drive this with a Map and a spy.
 */
export interface HistoryEnvironment {
  readonly store: HistoryStore
  readonly downloadJson: (fileName: string, parts: Iterable<string>) => void
}

const environment = shallowRef<HistoryEnvironment | null>(null)

const shared = createHistoryBrowser({
  store: () => environment.value?.store ?? null,
  now: () => Date.now(),
  download: (fileName, parts) => {
    const wired = environment.value
    if (!wired) throw new Error('The log is not open yet.')
    wired.downloadJson(fileName, parts)
  },
})

export function provideHistoryEnvironment(next: HistoryEnvironment): void {
  environment.value = next
  void shared.refresh().catch(() => undefined)
}

export function useHistoryBrowser(): HistoryBrowser {
  return shared
}
