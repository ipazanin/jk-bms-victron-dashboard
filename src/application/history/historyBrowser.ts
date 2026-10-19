import { computed, ref, shallowRef } from 'vue'
import type { ComputedRef, Ref, ShallowRef } from 'vue'

import { decodePackChunk, decodeSolarChunk, isReadableLayout } from '../../domain/history/columns'
import {
  exportFileName,
  exportSessionParts,
} from '../../domain/history/exportDocument'
import { deviceLabel } from '../../domain/history/identity'
import { MAX_PAIRING_AGE_MS, pairSamples } from '../../domain/history/join'
import type { PairedSample } from '../../domain/history/join'
import { recomputeAccount, recomputeLedger } from '../../domain/history/ledger'
import type { SessionAccount } from '../../domain/history/ledger'
import type { SessionHour } from '../../domain/history/SessionHour'
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
import type {
  HistoryAvailability,
  HistoryStore,
  RingLedgerSummary,
  SessionListing,
  StoredRingLedger,
  StoredSession,
} from './port'
import { renderWindowFor } from './port'

const WARNING_LIST_LIMIT = 1000

const ENTIRE_SESSION: TimeWindow = { from: 0, to: Number.MAX_SAFE_INTEGER }

export type ExportState = 'idle' | 'working' | 'done' | 'failed'

export interface SessionGroup {
  readonly key: DeviceKey

  readonly device: DeviceRecord | null
  readonly label: string

  readonly sessions: readonly SessionListing[]
  readonly recordedMs: number
}

export interface ArchiveSummary {
  readonly sessions: number
  readonly recordedMs: number

  readonly oldestStartedAt: number | null
}

export interface ArchiveUsage {
  readonly totalSamples: number
  readonly sessions: number
  readonly rawBytes?: number
  readonly rawCapacityBytes?: number
  readonly ringRecords: number
}

export interface LoadedSession {
  readonly record: SessionRecord
  readonly packDevice: DeviceRecord | null
  readonly solarDevice: DeviceRecord | null
  readonly label: string
  readonly pack: readonly PackSample[]
  readonly solar: readonly SolarSample[]
  readonly timeline: readonly PairedSample[]
  readonly hours: readonly SessionHour[]

  readonly window: TimeWindow
  readonly rawWindow: TimeWindow
  readonly windowClamped: boolean

  readonly unreadableChunks: number
}

/** Deep Vue proxies would repeatedly wrap thousands of decoded sample objects. */
export interface HistoryBrowser {

  readonly availability: Readonly<Ref<HistoryAvailability | null>>
  readonly sessions: Readonly<Ref<readonly SessionListing[]>>
  readonly devices: Readonly<Ref<readonly DeviceRecord[]>>

  readonly warnings: Readonly<Ref<readonly WarningRecord[]>>
  readonly groups: ComputedRef<readonly SessionGroup[]>
  readonly archive: ComputedRef<ArchiveSummary>
  readonly usage: Readonly<Ref<ArchiveUsage | null>>
  readonly refreshing: Readonly<Ref<boolean>>
  readonly loading: Readonly<Ref<boolean>>
  readonly loaded: Readonly<Ref<LoadedSession | null>>

  readonly missing: Readonly<Ref<SessionId | null>>

  readonly failure: Readonly<Ref<string | null>>
  readonly selection: Readonly<Ref<TimeWindow | null>>
  readonly selectedHour: ComputedRef<SessionHour | null>

  readonly account: ComputedRef<SessionAccount | null>
  readonly exportState: Readonly<Ref<ExportState>>

  readonly windowWarnings: Readonly<Ref<readonly WarningRecord[] | null>>

  readonly ringLedgers: Readonly<Ref<readonly RingLedgerSummary[]>>

  readonly ringLedger: Readonly<Ref<StoredRingLedger | null>>
  readonly ringLoading: Readonly<Ref<boolean>>

  readonly solarLedger: Readonly<Ref<StoredRingLedger | null>>
  readonly solarLoading: Readonly<Ref<boolean>>

  refresh(): Promise<void>
  loadSession(id: SessionId, window?: TimeWindow): Promise<void>
  unloadSession(): void

  loadWindowWarnings(window: TimeWindow): Promise<void>

  loadRingLedger(deviceKey: DeviceKey): Promise<void>

  loadSolarLedger(deviceKey: DeviceKey): Promise<void>

  refreshRingLedger(deviceKey: DeviceKey): Promise<void>

  refreshSolarLedger(deviceKey: DeviceKey): Promise<void>

  setPackClock(
    deviceKey: DeviceKey,
    clock: { readonly utcOffsetMinutes: number | null; readonly aheadSeconds: number | null },
  ): Promise<void>
  deleteRingLedger(deviceKey: DeviceKey): Promise<void>
  select(window: TimeWindow | null): void
  selectHour(hourStart: number | null): void
  renameDevice(key: DeviceKey, label: string | null): Promise<void>
  deleteSession(id: SessionId): Promise<void>
  downloadSession(): Promise<void>
  dispose(): void
}

export interface HistoryBrowserDeps {

  readonly store: () => HistoryStore | null
  readonly now: () => number

  readonly download: (fileName: string, parts: Iterable<string>) => void
}

export function sessionDurationMs(record: SessionRecord, now: number): number {
  const endedAt = record.endedAt ?? (record.state === 'open' ? now : record.heartbeatAt)
  const span = endedAt - record.startedAt
  if (span > 0) return span
  return Math.max(record.packSamples, record.solarSamples) * SAMPLE_INTERVAL_MS
}

interface LedgerSlot {
  readonly held: ShallowRef<StoredRingLedger | null>
  readonly loading: Ref<boolean>
  key: DeviceKey | null

  token: number
}

function emptyLedgerSlot(): LedgerSlot {
  return {
    held: shallowRef<StoredRingLedger | null>(null),
    loading: ref(false),
    key: null,
    token: 0,
  }
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
  const selectedHourStart = ref<number | null>(null)
  const exportState = ref<ExportState>('idle')
  const windowWarnings = shallowRef<readonly WarningRecord[] | null>(null)
  const ringLedgers = shallowRef<readonly RingLedgerSummary[]>([])
  const ringSlot = emptyLedgerSlot()
  const solarSlot = emptyLedgerSlot()

  const listedAt = ref(0)

  let requestedId: SessionId | null = null
  let requestedWindow: TimeWindow | undefined

  let deferredId: SessionId | null = null
  let listToken = 0
  let loadToken = 0
  let windowWarningsToken = 0
  let unsubscribe: (() => void) | null = null
  let subscribedTo: HistoryStore | null = null

  const availability = shallowRef<HistoryAvailability | null>(null)

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

  const selectedHour = computed(() =>
    loaded.value?.hours.find((hour) => hour.hourStart === selectedHourStart.value) ?? null,
  )

  const account = computed<SessionAccount | null>(() => {
    const session = loaded.value
    if (session === null) return null
    if (selectedHour.value !== null) return { ledger: selectedHour.value.ledger, coverage: [] }

    const window = selection.value
    if (window === null) return { ledger: session.record.ledger, coverage: session.record.coverage }

    return recomputeAccount(
      within(session.pack, window),
      within(session.solar, window),
      MAX_PAIRING_AGE_MS,
    )
  })

  async function refresh(): Promise<void> {
    const store = activeStore()
    if (!store) return

    const token = (listToken += 1)
    refreshing.value = true
    try {
      const [listed, known, totals, warned, ledgers] = await Promise.all([
        store.listSessions(),
        store.listDevices(),
        store.usage(),
        store.listWarnings(WARNING_LIST_LIMIT),
        store.listRingLedgers(),
      ])
      if (token !== listToken) return
      sessions.value = listed
      devices.value = known
      warnings.value = warned
      ringLedgers.value = ledgers
      usage.value = totals
      listedAt.value = deps.now()
      failure.value = null
    } catch (error) {
      if (token === listToken) failure.value = describeFailure(error)
    } finally {
      if (token === listToken) refreshing.value = false
    }

    if (token !== listToken) return
    if (deferredId !== null) await read()
    for (const slot of [ringSlot, solarSlot]) {
      if (slot.key !== null) await refreshLedgerInto(slot, slot.key)
    }
  }

  function loadSession(id: SessionId, window?: TimeWindow): Promise<void> {
    activeStore()
    const already = loaded.value
    const settled = already !== null && already.record.id === id && !loading.value
    if (settled && window === undefined) return Promise.resolve()

    if (already?.record.id !== id) {
      loaded.value = null
      selection.value = null
      selectedHourStart.value = null
      exportState.value = 'idle'
    }
    requestedId = id
    requestedWindow = window
    if (window !== undefined) select(null)
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
    selectedHourStart.value = null
    missing.value = null
    exportState.value = 'idle'
    deps.store()?.noteViewing?.(null)
  }

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
      if (token === windowWarningsToken) windowWarnings.value = null
    }
  }

  async function loadLedgerInto(slot: LedgerSlot, deviceKey: DeviceKey): Promise<void> {
    const store = activeStore()
    slot.key = deviceKey
    if (!store) {
      slot.held.value = null
      return
    }

    const token = (slot.token += 1)
    slot.held.value = null
    slot.loading.value = true
    try {
      const found = await store.readRingLedger(deviceKey)
      if (token !== slot.token) return
      slot.held.value = found
    } catch {
      if (token === slot.token) slot.held.value = null
    } finally {
      if (token === slot.token) slot.loading.value = false
    }
  }

  async function refreshLedgerInto(slot: LedgerSlot, deviceKey: DeviceKey): Promise<void> {
    const store = activeStore()
    slot.key = deviceKey
    if (!store) return

    const token = (slot.token += 1)
    try {
      const found = await store.readRingLedger(deviceKey)
      if (token !== slot.token) return
      slot.held.value = found
    } catch {
    }
  }

  function loadRingLedger(deviceKey: DeviceKey): Promise<void> {
    return loadLedgerInto(ringSlot, deviceKey)
  }

  function loadSolarLedger(deviceKey: DeviceKey): Promise<void> {
    return loadLedgerInto(solarSlot, deviceKey)
  }

  function refreshRingLedger(deviceKey: DeviceKey): Promise<void> {
    return refreshLedgerInto(ringSlot, deviceKey)
  }

  function refreshSolarLedger(deviceKey: DeviceKey): Promise<void> {
    return refreshLedgerInto(solarSlot, deviceKey)
  }

  async function setPackClock(
    deviceKey: DeviceKey,
    clock: { readonly utcOffsetMinutes: number | null; readonly aheadSeconds: number | null },
  ): Promise<void> {
    const store = activeStore()
    if (!store) return

    try {
      await store.setPackClock(deviceKey, clock)
    } catch (error) {
      if (store !== deps.store()) return
      failure.value = describeFailure(error)
      return
    }
    if (store !== deps.store()) return
    await refresh()
  }

  async function deleteRingLedger(deviceKey: DeviceKey): Promise<void> {
    const store = activeStore()
    if (!store) return

    try {
      await store.deleteRingLedger(deviceKey)
    } catch (error) {
      if (store !== deps.store()) return
      failure.value = describeFailure(error)
      return
    }
    if (store !== deps.store()) return
    for (const slot of [ringSlot, solarSlot]) {
      if (slot.key !== deviceKey) continue
      slot.key = null
      slot.token += 1
      slot.held.value = null
    }
    await refresh()
  }

  function select(window: TimeWindow | null): void {
    selection.value = window === null || window.to <= window.from ? null : window
    selectedHourStart.value = null
  }

  function selectHour(hourStart: number | null): void {
    const hour = loaded.value?.hours.find((candidate) => candidate.hourStart === hourStart)
    selectedHourStart.value = hour?.hourStart ?? null
    selection.value = hour === undefined ? null : { from: hour.from, to: hour.to }
  }

  async function renameDevice(key: DeviceKey, label: string | null): Promise<void> {
    const store = activeStore()
    if (!store) return

    const chosen = label?.trim() ?? ''
    try {
      const renamed = await store.renameDevice(key, chosen === '' ? null : chosen)
      if (store !== deps.store()) return
      if (renamed) relabelLoaded(renamed)
    } catch (error) {
      if (store !== deps.store()) return
      failure.value = describeFailure(error)
      return
    }
    await refresh()
  }

  async function deleteSession(id: SessionId): Promise<void> {
    const store = activeStore()
    if (!store) return

    try {
      await store.deleteSession(id)
    } catch (error) {
      if (store !== deps.store()) return
      failure.value = describeFailure(error)
      return
    }
    if (store !== deps.store()) return
    if (requestedId === id || loaded.value?.record.id === id) unloadSession()
    await refresh()
  }

  async function downloadSession(): Promise<void> {
    const store = activeStore()
    const session = loaded.value
    if (!session || !store) return

    const token = loadToken
    exportState.value = 'working'
    try {
      const pack: PackSample[] = []
      const solar: SolarSample[] = []
      await store.streamChunks(session.record.id, PACK_STREAM, ENTIRE_SESSION, (chunk) => {
        if (chunk.stream !== PACK_STREAM || !isReadableLayout(chunk.layout)) return
        appendAll(pack, decodePackChunk(chunk))
      })
      if (token !== loadToken) return
      await store.streamChunks(session.record.id, SOLAR_STREAM, ENTIRE_SESSION, (chunk) => {
        if (chunk.stream !== SOLAR_STREAM || !isReadableLayout(chunk.layout)) return
        appendAll(solar, decodeSolarChunk(chunk))
      })
      if (token !== loadToken) return

      const rawComplete = pack.length === session.record.packSamples && solar.length === session.record.solarSamples &&
        session.record.retainedFrom === null && session.record.droppedChunks === 0
      deps.download(
        exportFileName(session.label, session.record.startedAt),
        exportSessionParts({
          record: session.record,
          packDevice: session.packDevice,
          solarDevice: session.solarDevice,
          recomputedLedger: rawComplete ? recomputeLedger(pack, solar, MAX_PAIRING_AGE_MS) : null,
          hours: session.hours,
          rawCoverage: pack.length + solar.length === 0 ? 'none' : rawComplete ? 'complete' : 'partial',
          pack,
          solar,
          generatedAt: deps.now(),
        }),
      )
      exportState.value = 'done'
    } catch (error) {
      if (token !== loadToken) return
      failure.value = describeFailure(error)
      exportState.value = 'failed'
    }
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    subscribedTo?.noteViewing?.(null)
    subscribedTo = null
    clearSourceState()
    requestedId = null
    requestedWindow = undefined
    deferredId = null
    availability.value = null
  }

  function clearSourceState(): void {
    listToken += 1
    loadToken += 1
    windowWarningsToken += 1
    sessions.value = []
    devices.value = []
    warnings.value = []
    ringLedgers.value = []
    usage.value = null
    listedAt.value = 0
    refreshing.value = false
    loading.value = false
    loaded.value = null
    missing.value = null
    failure.value = null
    selection.value = null
    selectedHourStart.value = null
    exportState.value = 'idle'
    windowWarnings.value = null
    for (const slot of [ringSlot, solarSlot]) {
      slot.token += 1
      slot.key = null
      slot.held.value = null
      slot.loading.value = false
    }
  }

  async function read(): Promise<void> {
    const id = requestedId
    if (id === null) return

    const store = activeStore()
    if (!store) {
      deferredId = id
      return
    }
    deferredId = null
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
      loaded.value = hydrate(stored, requestedWindow)
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

  function activeStore(): HistoryStore | null {
    const store = deps.store()
    availability.value = store?.availability ?? null
    if (store === subscribedTo) return store

    unsubscribe?.()
    subscribedTo?.noteViewing?.(null)
    clearSourceState()
    deferredId = requestedId
    subscribedTo = store
    unsubscribe = store?.watch(() => {
      void refresh().catch(() => undefined)
    }) ?? null
    return store
  }

  function relabelLoaded(renamed: DeviceRecord): void {
    const session = loaded.value
    if (!session) return

    const packDevice = session.packDevice?.key === renamed.key ? renamed : session.packDevice
    const solarDevice = session.solarDevice?.key === renamed.key ? renamed : session.solarDevice
    if (packDevice === session.packDevice && solarDevice === session.solarDevice) return

    loaded.value = {
      ...session,
      packDevice,
      solarDevice,
      label: deviceLabel(packDevice ?? solarDevice, session.label),
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
    selectedHour,
    account,
    exportState,
    windowWarnings,
    ringLedgers,
    ringLedger: ringSlot.held,
    ringLoading: ringSlot.loading,
    solarLedger: solarSlot.held,
    solarLoading: solarSlot.loading,
    refresh,
    loadSession,
    unloadSession,
    loadWindowWarnings,
    loadRingLedger,
    loadSolarLedger,
    refreshRingLedger,
    refreshSolarLedger,
    setPackClock,
    deleteRingLedger,
    select,
    selectHour,
    renameDevice,
    deleteSession,
    downloadSession,
    dispose,
  }
}

interface DecodedStreams {
  readonly pack: PackSample[]
  readonly solar: SolarSample[]

  readonly unreadableChunks: number
}

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

function hydrate(stored: StoredSession, requestedWindow?: TimeWindow): LoadedSession {
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
    hours: stored.hours ?? [],
    window: windowOf(stored.record, pack, solar),
    rawWindow: renderWindowFor({
      from: stored.record.startedAt,
      to: stored.record.endedAt ?? stored.record.heartbeatAt,
    }, requestedWindow).window,
    windowClamped: stored.windowClamped,
    unreadableChunks,
  }
}

function windowOf(
  record: SessionRecord,
  pack: readonly PackSample[],
  solar: readonly SolarSample[],
): TimeWindow {
  const first = firstStamp(pack, solar) ?? record.retainedFrom ?? record.startedAt
  const last = lastStamp(pack, solar) ?? record.endedAt ?? record.heartbeatAt
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

/** Large sessions exceed the JavaScript argument limit when spread into push. */
function appendAll<TSample>(target: TSample[], samples: readonly TSample[]): void {
  for (const sample of samples) target.push(sample)
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : ''
  return message || 'The log could not be read.'
}

export interface HistoryEnvironment {
  readonly store: HistoryStore
  readonly downloadJson: (fileName: string, parts: Iterable<string>) => void
  readonly capturedAt?: number
}

const environment = shallowRef<HistoryEnvironment | null>(null)

const shared = createHistoryBrowser({
  store: () => environment.value?.store ?? null,
  now: () => environment.value?.capturedAt ?? Date.now(),
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
