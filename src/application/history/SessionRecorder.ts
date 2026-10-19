import { SessionHourAccumulator } from '../../domain/history/SessionHourAccumulator'
import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../../domain/bms/types'
import { MIN_SESSION_SAMPLES } from '../../domain/history/budget'
import { PackChunkBuilder, SolarChunkBuilder } from '../../domain/history/columns'
import {
  groupKeyFor,
  packDefaultLabel,
  packDeviceKeyFor,
  solarDefaultLabel,
} from '../../domain/history/identity'
import { MAX_PAIRING_AGE_MS } from '../../domain/history/join'
import type { PairedSample } from '../../domain/history/join'
import { EMPTY_FOLD, pushSample } from '../../domain/history/ledger'
import type { AccountFold } from '../../domain/history/ledger'
import { packSampleOf, solarSampleOf } from '../../domain/history/samples'
import {
  CHUNK_CAPACITY,
  MAX_SESSION_WARNINGS,
  PACK_STREAM,
  SAMPLE_INTERVAL_MS,
} from '../../domain/history/types'
import type {
  DeviceKey,
  DeviceRecord,
  HistoryChunk,
  PackSample,
  SessionEndReason,
  SessionEntry,
  SessionId,
  SessionRecord,
  SolarSample,
  WarningRecord,
  WarningSnapshot,
} from '../../domain/history/types'
import { SNAPSHOT_SCHEMA_VERSION } from '../../domain/schemaVersion'
import type { SolarReading } from '../../domain/solar/types'
import { browserSchedule } from '../schedule'
import type { CancelScheduled, Schedule } from '../schedule'
import type { Fault, FaultLevel } from '../severity'
import { storageKey } from '../storageKey'
import type {
  HistoryStore,
  HistoryUnavailableReason,
  SessionClosure,
  SessionPatch,
} from './port'

export const CHECKPOINT_INTERVAL_MS = 10_000

export const SESSION_IDLE_TIMEOUT_MS = 120_000

const MAX_COMMIT_ATTEMPTS = 2

export const MAX_SESSION_ENTRIES = 500

const RECORDING_LEASE = 'shunt.recording'

export const LEASE_RETRY_INTERVAL_MS = 30_000

export interface RecorderClock {
  now(): number
  monotonic(): number
}

export interface SessionRecorderOptions {
  readonly store: () => HistoryStore | null
  readonly clock?: RecorderClock
  readonly newId?: () => string

  readonly schedule?: Schedule
  readonly onStateChange?: (state: RecorderState) => void
}

export type RecordingLease = 'undecided' | 'held' | 'refused'

export interface RecorderState {
  readonly sessionId: SessionId | null
  readonly startedAt: number | null
  readonly packSamples: number
  readonly solarSamples: number
  readonly droppedChunks: number

  readonly failure: HistoryUnavailableReason | null

  readonly lease: RecordingLease
}

export type PackStreamEndReason = 'link-lost' | 'stalled' | 'user'

export function endReasonPhrase(reason: SessionEndReason): string {
  switch (reason) {
    case 'user-disconnect':
      return 'you disconnected'
    case 'link-lost':
      return 'the BMS dropped'
    case 'stalled':
      return 'the BMS went quiet'
    case 'device-changed':
      return 'a different pack connected'
    case 'page-away':
      return 'the page was put away'
    case 'archive-lost':

      return 'the log could not be written to'
    case 'abandoned':
      return 'this tab was closed'
  }
}

interface OpenSession {
  readonly id: SessionId
  readonly startedAt: number
  readonly continues: SessionId | null

  leased: boolean

  packDeviceKey: DeviceKey | null
  solarDeviceKey: DeviceKey | null
  packDeviceCounted: boolean
  solarDeviceCounted: boolean
  deviceInfo: DeviceInfo | null
  settings: BmsSettings | null
  finalBattery: BatterySnapshot | null
  finalSolar: SolarReading | null

  packBuilder: PackChunkBuilder | null
  solarBuilder: SolarChunkBuilder | null
  nextPackSeq: number
  nextSolarSeq: number
  packSamples: number
  solarSamples: number
  packChunks: number
  solarChunks: number
  droppedChunks: number

  packStreamOpen: boolean
  solarStreamOpen: boolean
  packGapReason: PackStreamEndReason | null
  lastPackRowAt: number | null
  lastPackRowMonotonic: number
  lastSolarRowMonotonic: number

  heldPack: PackSample | null
  heldSolar: SolarSample | null
  account: AccountFold
  readonly hours: SessionHourAccumulator
  entries: SessionEntry[]
  entriesCapped: boolean
  faultStanding: boolean

  activeWarnings: Set<string>
  warnings: number
  warningsCapped: boolean
  deepest: { readonly at: number; readonly stateOfCharge: number } | null

  pending: { chunk: HistoryChunk; attempts: number }[]
  writing: boolean
  writeRequested: boolean
}

type CommitResult = 'stored' | 'retry' | 'lost'

type DeviceTally = 'opens-a-session' | 'already-counted'

// Public observations stay synchronous so Bluetooth handlers keep their user activation.
export class SessionRecorder {
  private readonly resolveStore: () => HistoryStore | null
  private readonly clock: RecorderClock
  private readonly newId: () => string
  private readonly schedule: Schedule
  private readonly onStateChange: ((state: RecorderState) => void) | null

  private readonly writerId: string

  private session: OpenSession | null = null
  private failure: HistoryUnavailableReason | null = null

  private archiveLost = false
  private published: RecorderState
  private chain: Promise<void> = Promise.resolve()

  private cancelHeartbeat: CancelScheduled | null = null

  private heldForRejoin = false
  private disposed = false

  private packDeviceKey: DeviceKey | null = null
  private packLabel = ''
  private solarDeviceKey: DeviceKey | null = null
  private solarLabel = ''
  private deviceInfo: DeviceInfo | null = null
  private settings: BmsSettings | null = null
  private statusWorst: FaultLevel = 'good'
  private statusHeadline = ''

  private lastObservationMonotonic = 0

  private continuesSessionId: SessionId | null = null

  private releaseHeldLease: (() => void) | null = null

  private leaseRefusedMonotonic: number | null = null

  private leaseReleaseAnnounced = false
  private stopWatchingArchive: (() => void) | null = null

  private watchedStore: HistoryStore | null = null

  constructor(options: SessionRecorderOptions) {
    this.resolveStore = options.store
    this.clock = options.clock ?? browserClock()
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.schedule = options.schedule ?? browserSchedule
    this.onStateChange = options.onStateChange ?? null
    this.writerId = this.newId()
    this.published = idleState()
  }

  get state(): RecorderState {
    return this.published
  }

  notePack(snapshot: BatterySnapshot): void {
    if (this.disposed) return
    const at = this.clock.now()
    const monotonic = this.clock.monotonic()
    this.lastObservationMonotonic = monotonic

    const session = this.ensureOpen(at)
    if (session === null) return

    if (!session.packStreamOpen) this.reopenPackStream(session, at)
    session.finalBattery = snapshot

    if (this.failure !== null) return
    if (monotonic - session.lastPackRowMonotonic < SAMPLE_INTERVAL_MS) return
    this.appendPack(session, packSampleOf(snapshot, at), monotonic)
    this.publish()
  }

  noteSolar(reading: SolarReading, rssi: number): void {
    if (this.disposed) return
    const at = this.clock.now()
    const monotonic = this.clock.monotonic()
    this.lastObservationMonotonic = monotonic

    const session = this.ensureOpen(at)
    if (session === null) return

    session.solarStreamOpen = true
    session.finalSolar = reading

    if (this.failure !== null) return
    if (monotonic - session.lastSolarRowMonotonic < SAMPLE_INTERVAL_MS) return
    this.appendSolar(session, solarSampleOf(reading, rssi, at), monotonic)
    this.publish()
  }

  identify(info: DeviceInfo, advertisedName: string | null): void {
    if (this.disposed) return
    const key = packDeviceKeyFor(info, advertisedName)
    const open = this.session
    const contradicts =
      open !== null && key !== null && open.packDeviceKey !== null && open.packDeviceKey !== key

    if (contradicts) this.finish('device-changed')

    this.deviceInfo = info
    this.packDeviceKey = key
    this.packLabel = packDefaultLabel(info, advertisedName)

    const session = contradicts ? this.ensureOpen(this.clock.now()) : this.session
    if (session === null) return

    session.deviceInfo = info
    session.packDeviceKey = key
    if (key !== null && !session.packDeviceCounted) {
      session.packDeviceCounted = true
      this.rememberPackDevice(session, key, this.clock.now())
    }
    this.publish()
  }

  identifySolar(key: DeviceKey, modelId: number | null): void {
    if (this.disposed) return
    const label = solarDefaultLabel(modelId)
    const renamed = label !== this.solarLabel
    this.solarDeviceKey = key
    this.solarLabel = label

    const session = this.session
    if (session === null) return
    session.solarDeviceKey = key
    if (!session.solarDeviceCounted) {
      session.solarDeviceCounted = true
      this.rememberSolarDevice(session, key, this.clock.now(), 'opens-a-session')
      return
    }
    if (renamed) this.rememberSolarDevice(session, key, this.clock.now(), 'already-counted')
  }

  noteSettings(settings: BmsSettings): void {
    if (this.disposed) return
    this.settings = settings
    if (this.session !== null) this.session.settings = settings
  }

  noteStatus(worst: FaultLevel, headline: string): void {
    if (this.disposed) return
    if (worst === this.statusWorst && headline === this.statusHeadline) return
    this.statusWorst = worst
    this.statusHeadline = headline

    const session = this.session
    if (session === null) return
    this.appendStatusEntry(session, this.clock.now(), worst, headline)
  }

  noteWarnings(faults: readonly Fault[], snapshot: WarningSnapshot, at: number): void {
    if (this.disposed) return
    const session = this.session
    if (session === null || this.failure !== null) return

    const present = new Set<string>()
    for (const fault of faults) {
      if (fault.level === 'good') continue
      const key = `${fault.level}:${fault.title}`
      present.add(key)
      if (session.activeWarnings.has(key)) continue
      session.activeWarnings.add(key)
      if (session.warningsCapped) continue
      if (session.warnings >= MAX_SESSION_WARNINGS) {
        session.warningsCapped = true
        continue
      }
      const record: WarningRecord = {
        sessionId: session.id,
        seq: session.warnings,
        at,
        level: fault.level,
        title: fault.title,
        detail: fault.detail,
        snapshot,
      }
      session.warnings += 1
      this.enqueue(async () => {
        const store = this.usableStore()
        if (store !== null) await store.appendWarning(record)
      })
    }

    for (const key of session.activeWarnings) {
      if (!present.has(key)) session.activeWarnings.delete(key)
    }
  }

  endPackStream(final: BatterySnapshot | null, reason: PackStreamEndReason): void {
    const session = this.session
    if (session === null || !session.packStreamOpen) return
    if (final !== null) session.finalBattery = final
    session.packStreamOpen = false
    session.packGapReason = reason

    session.heldPack = null
    this.sealPackChunk(session)
    this.flush(session)
  }

  beginPackStream(): void {
    const session = this.session
    if (session === null || session.packStreamOpen) return
    this.reopenPackStream(session, this.clock.now())
    this.publish()
  }

  endSolarStream(): void {
    const session = this.session
    if (session === null || !session.solarStreamOpen) return
    session.solarStreamOpen = false
    session.heldSolar = null
    this.sealSolarChunk(session)
    this.flush(session)
  }

  holdOpenForRejoin(): void {
    if (this.session === null) return
    this.heldForRejoin = true
  }

  releaseRejoinHold(): void {
    this.heldForRejoin = false
  }

  checkpoint(): void {
    const session = this.session
    if (session === null) return
    this.flush(session)
  }

  finish(reason: SessionEndReason): void {
    const session = this.session
    if (session === null) {
      this.leaseRefusedMonotonic = null
      this.leaseReleaseAnnounced = false
      this.publish()
      return
    }

    const endedAt = this.clock.now()
    this.sealPackChunk(session)
    this.sealSolarChunk(session)

    const entries = [...session.entries]
    const deepest = session.deepest
    if (deepest !== null) {
      const mark: SessionEntry = {
        at: deepest.at,
        kind: 'deepest',
        level: 'neutral',
        text: `Deepest — ${deepest.stateOfCharge}%`,
      }

      const following = entries.findIndex((entry) => entry.at > mark.at)
      if (following < 0) entries.push(mark)
      else entries.splice(following, 0, mark)
    }
    entries.push({
      at: endedAt,
      kind: 'end',
      level: 'neutral',
      text: `Session ends — ${endReasonPhrase(reason)}`,
    })
    session.entries = entries

    this.session = null
    this.stopClock()
    this.releaseRejoinHold()
    this.publish()

    this.enqueue(async () => {
      this.releaseRecordingLease()
      const store = this.usableStore()
      if (store === null) return
      if (session.packSamples + session.solarSamples < MIN_SESSION_SAMPLES) {
        await store.deleteSession(session.id)
        return
      }
      await this.writePending(session)
      const closure: SessionClosure = { ...this.patchOf(session), endedAt, endReason: reason }
      await store.closeSession(session.id, closure)
    })
  }

  drain(): Promise<void> {
    return this.chain
  }

  dispose(): void {
    if (this.disposed) return
    this.checkpoint()
    this.disposed = true
    this.stopClock()
    this.releaseRejoinHold()
    this.stopWatchingArchive?.()
    this.stopWatchingArchive = null
    this.watchedStore = null
    this.releaseRecordingLease()
    this.session = null
    this.publish()
  }

  private ensureOpen(at: number): OpenSession | null {
    if (this.disposed) return null

    this.followArchive()
    if (this.session !== null) return this.session
    if (!this.mayClaimLease()) return null
    const store = this.usableStore()
    if (store === null) return null

    const id = this.newId()
    const session: OpenSession = {
      id,
      startedAt: at,
      continues: this.continuesSessionId,

      leased: this.releaseHeldLease !== null,
      packDeviceKey: this.packDeviceKey,
      solarDeviceKey: this.solarDeviceKey,
      packDeviceCounted: false,
      solarDeviceCounted: false,
      deviceInfo: this.deviceInfo,
      settings: this.settings,
      finalBattery: null,
      finalSolar: null,
      packBuilder: null,
      solarBuilder: null,
      nextPackSeq: 0,
      nextSolarSeq: 0,
      packSamples: 0,
      solarSamples: 0,
      packChunks: 0,
      solarChunks: 0,
      droppedChunks: 0,
      packStreamOpen: true,
      solarStreamOpen: true,
      packGapReason: null,
      lastPackRowAt: null,
      lastPackRowMonotonic: Number.NEGATIVE_INFINITY,
      lastSolarRowMonotonic: Number.NEGATIVE_INFINITY,
      heldPack: null,
      heldSolar: null,
      account: EMPTY_FOLD,
      hours: new SessionHourAccumulator(id, 'recorded'),
      entries: [{ at, kind: 'begin', level: 'neutral', text: 'Session begins' }],
      entriesCapped: false,
      faultStanding: false,
      activeWarnings: new Set(),
      warnings: 0,
      warningsCapped: false,
      deepest: null,
      pending: [],
      writing: false,
      writeRequested: false,
    }

    if (this.statusWorst !== 'good') {
      this.appendStatusEntry(session, at, this.statusWorst, this.statusHeadline)
    }

    this.session = session
    this.failure = null
    this.archiveLost = false
    this.continuesSessionId = null
    this.startClock()

    if (session.packDeviceKey !== null) session.packDeviceCounted = true
    if (session.solarDeviceKey !== null) session.solarDeviceCounted = true

    const record: SessionRecord = {
      ...this.patchOf(session),
      id: session.id,
      schema: SNAPSHOT_SCHEMA_VERSION,
      writerId: this.writerId,
      state: 'open',
      startedAt: at,
      endedAt: null,
      endReason: null,
      sealedSamples: 0,
      retainedFrom: null,
      continues: session.continues,
    }
    this.enqueue(async () => {
      if (!(await this.claimRecordingLease())) {
        this.standDown(session)
        return
      }
      session.leased = true

      this.leaseRefusedMonotonic = null
      this.leaseReleaseAnnounced = false
      this.publish()
      await store.openSession(record)

      if (this.disposed) this.releaseRecordingLease()
    })

    if (session.packDeviceKey !== null) this.rememberPackDevice(session, session.packDeviceKey, at)
    if (session.solarDeviceKey !== null) {
      this.rememberSolarDevice(session, session.solarDeviceKey, at, 'opens-a-session')
    }

    this.publish()
    return session
  }

  private standDown(session: OpenSession): void {
    if (this.session !== session) return
    this.session = null
    this.stopClock()
    this.releaseRejoinHold()
    this.leaseRefusedMonotonic = this.clock.monotonic()
    this.leaseReleaseAnnounced = false
    this.publish()
  }

  private abandonLostSession(session: OpenSession): void {
    if (this.session !== session) return
    this.continuesSessionId = session.id
    this.session = null
    this.stopClock()
    this.releaseRejoinHold()
    this.publish()
  }

  private reopenPackStream(session: OpenSession, at: number): void {
    const silentSince = session.lastPackRowAt
    if (silentSince !== null) {
      this.appendEntry(session, {
        at,
        kind: 'gap',
        level: 'neutral',
        text: `No samples for ${describeSpan(at - silentSince)} — ${packGapPhrase(session.packGapReason)}`,
      })
    }
    session.packStreamOpen = true
    session.packGapReason = null
  }

  private appendPack(session: OpenSession, sample: PackSample, monotonic: number): void {
    if (session.packBuilder === null) session.packBuilder = this.openPackChunk(session, sample, monotonic)
    if (!session.packBuilder.append(sample, monotonic)) {
      this.sealPackChunk(session)
      this.flush(session)
      session.packBuilder = this.openPackChunk(session, sample, monotonic)
      session.packBuilder.append(sample, monotonic)
    }

    session.packSamples += 1
    session.lastPackRowAt = sample.at
    session.lastPackRowMonotonic = monotonic
    session.heldPack = sample
    this.foldRow(session, sample.at)

    if (session.packBuilder.length >= CHUNK_CAPACITY) {
      this.sealPackChunk(session)
      this.flush(session)
    }
  }

  private appendSolar(session: OpenSession, sample: SolarSample, monotonic: number): void {
    if (session.solarBuilder === null) session.solarBuilder = this.openSolarChunk(session, sample, monotonic)
    if (!session.solarBuilder.append(sample, monotonic)) {
      this.sealSolarChunk(session)
      this.flush(session)
      session.solarBuilder = this.openSolarChunk(session, sample, monotonic)
      session.solarBuilder.append(sample, monotonic)
    }

    session.solarSamples += 1
    session.lastSolarRowMonotonic = monotonic
    session.heldSolar = sample
    this.foldRow(session, sample.at)

    if (session.solarBuilder.length >= CHUNK_CAPACITY) {
      this.sealSolarChunk(session)
      this.flush(session)
    }
  }

  private foldRow(session: OpenSession, at: number): void {
    const row: PairedSample = {
      at,
      pack: pairedWithin(session.heldPack, at),
      solar: pairedWithin(session.heldSolar, at),
    }
    session.account = pushSample(session.account, row)
    session.hours.push(row)

    const pack = row.pack
    if (pack !== null && (session.deepest === null || pack.stateOfCharge < session.deepest.stateOfCharge)) {
      session.deepest = { at, stateOfCharge: pack.stateOfCharge }
    }
  }

  private openPackChunk(session: OpenSession, sample: PackSample, monotonic: number): PackChunkBuilder {
    const seq = session.nextPackSeq
    session.nextPackSeq = seq + 1
    session.packChunks += 1
    return new PackChunkBuilder({
      sessionId: session.id,
      seq,
      baseAt: sample.at,
      baseMonotonic: monotonic,
    })
  }

  private openSolarChunk(session: OpenSession, sample: SolarSample, monotonic: number): SolarChunkBuilder {
    const seq = session.nextSolarSeq
    session.nextSolarSeq = seq + 1
    session.solarChunks += 1
    return new SolarChunkBuilder({
      sessionId: session.id,
      seq,
      baseAt: sample.at,
      baseMonotonic: monotonic,
    })
  }

  private sealPackChunk(session: OpenSession): void {
    const builder = session.packBuilder
    session.packBuilder = null
    if (builder === null) return
    if (builder.isEmpty) {
      session.nextPackSeq -= 1
      session.packChunks -= 1
      return
    }
    session.pending.push({ chunk: builder.seal(), attempts: 0 })
  }

  private sealSolarChunk(session: OpenSession): void {
    const builder = session.solarBuilder
    session.solarBuilder = null
    if (builder === null) return
    if (builder.isEmpty) {
      session.nextSolarSeq -= 1
      session.solarChunks -= 1
      return
    }
    session.pending.push({ chunk: builder.seal(), attempts: 0 })
  }

  private flush(session: OpenSession): void {
    if (this.disposed) return
    session.writeRequested = true
    if (session.writing) return
    session.writing = true
    this.enqueue(async () => {
      try {
        while (session.writeRequested) {
          session.writeRequested = false
          await this.writePending(session)
        }
      } finally {
        session.writing = false
      }
    })
  }

  private async writePending(session: OpenSession): Promise<void> {
    if (!session.leased) return
    const store = this.usableStore()
    if (store === null) return

    while (session.pending.length > 0) {
      const oldest = session.pending[0]
      const result = await this.commit(store, session, oldest.chunk)
      if (result === 'lost') {
        this.abandonLostSession(session)
        return
      }
      if (result === 'stored') {
        session.pending.shift()
        continue
      }
      oldest.attempts += 1

      if (oldest.attempts < MAX_COMMIT_ATTEMPTS) return
      session.pending.shift()
      this.dropChunk(session, oldest.chunk)
    }

    const packTail = session.packBuilder
    if (packTail !== null && !packTail.isEmpty) {
      if ((await this.commit(store, session, packTail.tail())) === 'lost') {
        this.abandonLostSession(session)
        return
      }
    }
    const solarTail = session.solarBuilder
    if (solarTail !== null && !solarTail.isEmpty) {
      if ((await this.commit(store, session, solarTail.tail())) === 'lost') {
        this.abandonLostSession(session)
      }
    }
  }

  // Storage failures must not escape into radio callbacks.
  private async commit(
    store: HistoryStore,
    session: OpenSession,
    chunk: HistoryChunk,
  ): Promise<CommitResult> {
    try {
      const hours = session.hours.updatedHours()
      const outcome = await store.commitChunk(chunk, this.patchOf(session), hours)
      if (outcome.stored) {
        session.hours.acknowledge(hours)
        return 'stored'
      }
      if (outcome.failure === null) return 'lost'

      this.failure = outcome.failure
      this.publish()
      return 'retry'
    } catch {
      return 'retry'
    }
  }

  private dropChunk(session: OpenSession, chunk: HistoryChunk): void {
    session.droppedChunks += 1
    if (chunk.stream === PACK_STREAM) session.packChunks -= 1
    else session.solarChunks -= 1

    const spanMs = chunk.length > 0 ? chunk.offsetMs[chunk.length - 1] : 0
    this.appendEntry(session, {
      at: chunk.baseAt,
      kind: 'gap',
      level: 'warning',
      text: `${describeSpan(spanMs)} of samples could not be stored`,
    })
    this.publish()
  }

  private patchOf(session: OpenSession): SessionPatch {
    return {
      heartbeatAt: this.clock.now(),
      packSamples: session.packSamples,
      solarSamples: session.solarSamples,
      packChunks: session.packChunks,
      solarChunks: session.solarChunks,
      droppedChunks: session.droppedChunks,
      coverage: session.account.coverage,
      ledger: session.account.ledger,
      entries: session.entries,
      packDeviceKey: session.packDeviceKey,
      solarDeviceKey: session.solarDeviceKey,
      groupKey: groupKeyFor(session.packDeviceKey, session.solarDeviceKey),
      deviceInfo: session.deviceInfo,
      settings: session.settings,
      finalBattery: session.finalBattery,
      finalSolar: session.finalSolar,
    }
  }

  private rememberPackDevice(session: OpenSession, key: DeviceKey, at: number): void {
    const info = this.deviceInfo
    this.upsertDevice(session, key, 'opens-a-session', (sessionCount) => ({
      key,
      kind: 'pack',
      defaultLabel: this.packLabel,
      userLabel: null,
      model: info?.model ?? null,
      serialNumber: info?.serialNumber ?? null,
      hardwareVersion: info?.hardwareVersion ?? null,
      softwareVersion: info?.softwareVersion ?? null,
      firstSeenAt: at,
      lastSeenAt: at,
      sessionCount,
      packUtcOffsetMinutes: null,
      packClockAheadSeconds: null,
    }))
  }

  private rememberSolarDevice(
    session: OpenSession,
    key: DeviceKey,
    at: number,
    tally: DeviceTally,
  ): void {
    this.upsertDevice(session, key, tally, (sessionCount) => ({
      key,
      kind: 'solar',
      defaultLabel: this.solarLabel,
      userLabel: null,
      model: null,
      serialNumber: null,
      hardwareVersion: null,
      softwareVersion: null,
      firstSeenAt: at,
      lastSeenAt: at,
      sessionCount,
      packUtcOffsetMinutes: null,
      packClockAheadSeconds: null,
    }))
  }

  private upsertDevice(
    session: OpenSession,
    key: DeviceKey,
    tally: DeviceTally,
    build: (sessionCount: number) => DeviceRecord,
  ): void {
    const store = this.usableStore()
    if (store === null) return
    this.enqueue(async () => {
      if (!session.leased) return

      const known = (await store.listDevices()).find((device) => device.key === key)
      const counted = known?.sessionCount ?? 0
      await store.upsertDevice(build(tally === 'opens-a-session' ? counted + 1 : counted))
    })
  }

  private appendStatusEntry(
    session: OpenSession,
    at: number,
    worst: FaultLevel,
    headline: string,
  ): void {
    if (worst !== 'good') {
      session.faultStanding = true
      this.appendEntry(session, { at, kind: 'fault', level: worst, text: headline })
      return
    }
    if (!session.faultStanding) return
    session.faultStanding = false
    this.appendEntry(session, { at, kind: 'cleared', level: 'good', text: headline })
  }

  private appendEntry(session: OpenSession, entry: SessionEntry): void {
    if (session.entriesCapped) return
    if (session.entries.length < MAX_SESSION_ENTRIES) {
      session.entries = [...session.entries, entry]
      return
    }
    session.entriesCapped = true
    session.entries = [
      ...session.entries,
      {
        at: entry.at,
        kind: 'gap',
        level: 'neutral',
        text: 'Too many status changes to list — later ones are not recorded',
      },
    ]
  }

  private mayClaimLease(): boolean {
    const refusedAt = this.leaseRefusedMonotonic
    if (refusedAt === null) return true
    if (this.leaseReleaseAnnounced) return true
    return this.clock.monotonic() - refusedAt >= LEASE_RETRY_INTERVAL_MS
  }

  private claimRecordingLease(): Promise<boolean> {
    if (this.releaseHeldLease !== null) return Promise.resolve(true)
    const locks = lockManager()
    if (locks === null) return Promise.resolve(true)

    return new Promise<boolean>((answer) => {
      const settled = locks.request(storageKey(RECORDING_LEASE), { ifAvailable: true }, (lock) => {
        if (lock === null) {
          answer(false)
          return Promise.resolve()
        }

        return new Promise<void>((release) => {
          this.releaseHeldLease = release
          answer(true)
        })
      })

      void settled.catch(() => answer(false))
    })
  }

  private leaseStanding(): RecordingLease {
    if (this.leaseRefusedMonotonic !== null) return 'refused'
    if (this.session !== null && this.session.leased) return 'held'
    return 'undecided'
  }

  private releaseRecordingLease(): void {
    const release = this.releaseHeldLease
    if (release === null) return
    this.releaseHeldLease = null
    release()
  }

  private followArchive(): void {
    const store = this.resolveStore()
    if (store !== this.watchedStore) {
      this.stopWatchingArchive?.()
      this.watchedStore = store
      this.stopWatchingArchive = store?.watch(() => this.archiveAnnounced()) ?? null
    }
    if (this.session === null || store === null) return
    const { usable, reason } = store.availability
    if (usable) {
      if (!this.archiveLost) return

      this.archiveLost = false
      this.failure = null
      this.finish('archive-lost')
      return
    }
    if (reason === null) return
    this.loseArchive(reason)
  }

  private archiveAnnounced(): void {
    this.leaseReleaseAnnounced = true
    this.followArchive()
  }

  private loseArchive(reason: HistoryUnavailableReason): void {
    if (this.failure !== null) return
    this.failure = reason
    this.archiveLost = true
    this.publish()
  }

  private usableStore(): HistoryStore | null {
    const store = this.resolveStore()
    if (store === null || !store.availability.usable) return null
    return store
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch(() => undefined)
  }

  private startClock(): void {
    if (this.cancelHeartbeat !== null) return
    this.armHeartbeat()
  }

  private armHeartbeat(): void {
    this.cancelHeartbeat = this.schedule(() => {
      this.cancelHeartbeat = null
      this.tick()

      if (this.session !== null && !this.disposed) this.startClock()
    }, CHECKPOINT_INTERVAL_MS)
  }

  private stopClock(): void {
    if (this.cancelHeartbeat === null) return
    this.cancelHeartbeat()
    this.cancelHeartbeat = null
  }

  private tick(): void {
    this.followArchive()
    const session = this.session
    if (session === null) return
    const idleFor = this.clock.monotonic() - this.lastObservationMonotonic
    if (!this.heldForRejoin && idleFor >= SESSION_IDLE_TIMEOUT_MS) {
      this.finish('stalled')
      return
    }
    this.flush(session)
  }

  private publish(): void {
    const session = this.session
    const next: RecorderState = {
      sessionId: session?.id ?? null,
      startedAt: session?.startedAt ?? null,
      packSamples: session?.packSamples ?? 0,
      solarSamples: session?.solarSamples ?? 0,
      droppedChunks: session?.droppedChunks ?? 0,
      failure: this.failure,
      lease: this.leaseStanding(),
    }
    if (sameState(this.published, next)) return
    this.published = next
    this.onStateChange?.(next)
  }
}

function browserClock(): RecorderClock {
  return {
    now: () => Date.now(),

    monotonic: () => performance.now(),
  }
}

function idleState(): RecorderState {
  return {
    sessionId: null,
    startedAt: null,
    packSamples: 0,
    solarSamples: 0,
    droppedChunks: 0,
    failure: null,
    lease: 'undecided',
  }
}

function sameState(left: RecorderState, right: RecorderState): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.startedAt === right.startedAt &&
    left.packSamples === right.packSamples &&
    left.solarSamples === right.solarSamples &&
    left.droppedChunks === right.droppedChunks &&
    left.failure === right.failure &&
    left.lease === right.lease
  )
}

function lockManager(): LockManager | null {
  if (typeof navigator === 'undefined') return null
  const locks: LockManager | undefined = navigator.locks
  return locks ?? null
}

function pairedWithin<T extends { readonly at: number }>(sample: T | null, at: number): T | null {
  return sample !== null && at - sample.at <= MAX_PAIRING_AGE_MS ? sample : null
}

function packGapPhrase(reason: PackStreamEndReason | null): string {
  switch (reason) {
    case 'link-lost':
      return 'the BMS dropped'
    case 'stalled':
      return 'the BMS went quiet'
    case 'user':
      return 'you disconnected'
    default:
      return 'the pack stopped reporting'
  }
}

function describeSpan(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 90) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min`
  return `${Math.round(minutes / 60)} h`
}
