/**
 * The recording state machine: what is open, what has been observed, and what still owes the store
 * a write.
 *
 * **Every method here is synchronous and returns void.** That is a hard constraint rather than a
 * preference. `connectBms` has to touch the recorder on the line before `requestDevice`, and
 * anything awaited on that path spends the click's transient activation, after which the browser
 * refuses the chooser — the same reason `stopSolarLink` and `leaveRemembered` are already
 * synchronous. So observation is synchronous and cheap, and every write is pushed onto one serial
 * promise chain that the caller can await through `drain()` but never has to.
 *
 * The chain is also what makes ordering free. `openSession` is never awaited by the caller, yet a
 * commit enqueued a millisecond later cannot overtake it, because both sit on the same chain.
 *
 * Nothing thrown by the store reaches a radio callback. A BLE notification handler that raises is a
 * lost frame at best and a dropped link at worst, so every enqueued step swallows its failure and
 * the recorder degrades instead: a refused write is retried once, then dropped with the hole
 * recorded as a hole. A full disk stops the Log and never the instrument.
 *
 * What ends a session is written down once, here, because every other rule follows from it:
 *
 * > A session is one continuous recording period, bounded by the radios, not by the pack link.
 * > It ends when both links are idle, or when the pack identity changes, or when the idle timer
 * > fires. Nothing else ends it.
 *
 * So a BMS that drops and comes back while the solar scan is still up produces one session with a
 * gap in its pack stream, not two sessions — and the solar rows recorded across that gap, which the
 * live sampler throws away for want of a battery snapshot, are kept.
 */

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
import {
  EMPTY_LEDGER,
  appendCoverage,
  classifyInterval,
  ledgerOfInterval,
  ledgerOfSample,
  mergeLedgers,
} from '../../domain/history/ledger'
import {
  CHUNK_CAPACITY,
  MAX_SESSION_WARNINGS,
  PACK_STREAM,
  SAMPLE_INTERVAL_MS,
} from '../../domain/history/types'
import type {
  CoverageRun,
  DeviceKey,
  DeviceRecord,
  HistoryChunk,
  PackSample,
  SessionEndReason,
  SessionEntry,
  SessionId,
  SessionLedger,
  SessionRecord,
  SolarSample,
  WarningRecord,
  WarningSnapshot,
} from '../../domain/history/types'
import { SNAPSHOT_SCHEMA_VERSION } from '../../domain/schemaVersion'
import type { SolarReading } from '../../domain/solar/types'
import type { Fault, FaultLevel } from '../severity'
import type {
  HistoryStore,
  HistoryUnavailableReason,
  SessionClosure,
  SessionPatch,
} from './port'

/**
 * How often the buffered tails reach the disk, and therefore how much a killed tab loses: the
 * crash-loss window and the heartbeat period are deliberately the same number, so a session that
 * looks fresh is a session whose data is fresh.
 */
export const CHECKPOINT_INTERVAL_MS = 10_000

/**
 * The zombie guard. A session with no observation on either stream for this long is closed
 * 'stalled' whatever the link state says. Without it, a session opened by a stray frame during a
 * `connect()` that then threw would stay open forever — heartbeating, immune to recovery, and
 * protected from eviction by the very heartbeat that proves nothing is watching it.
 */
export const SESSION_IDLE_TIMEOUT_MS = 120_000

/** One retry, then the chunk is given up. Five lost minutes beat a recorder that stops recording. */
const MAX_COMMIT_ATTEMPTS = 2

/**
 * A flapping threshold could otherwise append an entry a second for twelve hours, and the whole
 * list rides in every checkpoint patch. Past the cap the recorder says so once and stops.
 */
export const MAX_SESSION_ENTRIES = 500

/** Wall clock for stamps, monotonic for every gate and every row offset. Never the other way. */
export interface RecorderClock {
  now(): number
  monotonic(): number
}

export interface SessionRecorderOptions {
  /** Lazy: the store is probed asynchronously and may never arrive. */
  readonly store: () => HistoryStore | null
  readonly clock?: RecorderClock
  readonly newId?: () => string
  readonly onStateChange?: (state: RecorderState) => void
}

/** What the recording plate needs, and nothing the plate does not need. */
export interface RecorderState {
  /** Null when nothing is being recorded, which is also the answer when the store is unusable. */
  readonly sessionId: SessionId | null
  readonly startedAt: number | null
  readonly packSamples: number
  readonly solarSamples: number
  readonly droppedChunks: number
  /**
   * Set once the archive refused a write. No further rows are appended to this session; the
   * instruments carry on untouched.
   */
  readonly failure: HistoryUnavailableReason | null
}

/** Why the pack half of a session stopped. Narrower than a session end: the session survives it. */
export type PackStreamEndReason = 'link-lost' | 'stalled' | 'user'

/** The words the archive prints for each way a session ended, so no view invents its own. */
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
    case 'abandoned':
      return 'this tab was closed'
  }
}

/**
 * The recorder's working set for one session: everything mutable, in one object, so opening and
 * closing is one assignment and no field can be left over from the session before. What reaches
 * the store is derived from it and is immutable, as `SessionRecord` and `SessionPatch` declare.
 */
interface OpenSession {
  readonly id: SessionId
  readonly startedAt: number
  readonly continues: SessionId | null

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

  /** The last row of each stream that actually reached a chunk — what a re-read would pair with. */
  heldPack: PackSample | null
  heldSolar: SolarSample | null
  lastPaired: PairedSample | null
  /** The running total up to but excluding the last row, so a same-instant row can replace it. */
  ledgerBeforeLastRow: SessionLedger
  ledger: SessionLedger
  coverage: readonly CoverageRun[]
  entries: SessionEntry[]
  entriesCapped: boolean
  faultStanding: boolean
  /** Titles of the faults currently standing, so each episode is written once and only recurs
   *  after it clears. */
  activeWarnings: Set<string>
  warnings: number
  warningsCapped: boolean
  deepest: { readonly at: number; readonly stateOfCharge: number } | null

  /** Sealed chunks the store has not accepted yet, oldest first. */
  pending: { chunk: HistoryChunk; attempts: number }[]
  writing: boolean
  writeRequested: boolean
}

type CommitResult = 'stored' | 'retry' | 'lost'

export class SessionRecorder {
  private readonly resolveStore: () => HistoryStore | null
  private readonly clock: RecorderClock
  private readonly newId: () => string
  private readonly onStateChange: ((state: RecorderState) => void) | null
  /** One per tab. A shared "current session" pointer across tabs is exactly what this avoids. */
  private readonly writerId: string

  private session: OpenSession | null = null
  private failure: HistoryUnavailableReason | null = null
  private published: RecorderState
  private chain: Promise<void> = Promise.resolve()
  private ticker: ReturnType<typeof setInterval> | null = null
  private disposed = false

  /** The tab's current knowledge of the two radios, used to seed the next session it opens. */
  private packDeviceKey: DeviceKey | null = null
  private packLabel = ''
  private solarDeviceKey: DeviceKey | null = null
  private solarLabel = ''
  private deviceInfo: DeviceInfo | null = null
  private settings: BmsSettings | null = null
  private statusWorst: FaultLevel = 'good'
  private statusHeadline = ''

  private lastObservationMonotonic = 0
  /** Set when the store rejected a write because this tab's row was closed underneath it. */
  private continuesSessionId: SessionId | null = null

  constructor(options: SessionRecorderOptions) {
    this.resolveStore = options.store
    this.clock = options.clock ?? browserClock()
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.onStateChange = options.onStateChange ?? null
    this.writerId = this.newId()
    this.published = idleState()
  }

  get state(): RecorderState {
    return this.published
  }

  /**
   * A battery snapshot arrived.
   *
   * The gate is the recorder's own monotonic clock and not telemetry's `lastSampleAt`: that field
   * is cleared by one of the two view resets and not the other, which is harmless for a live
   * rate limiter and would silently double the archive's sample rate.
   */
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

  /** A Victron advertisement decoded. Opens a session on its own: a solar-only watch is a watch. */
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

  /**
   * The device-info frame decoded, which may be long after the session opened — the BMS notifies
   * its frames in whatever order it likes, and a decode failure is swallowed to `onError`.
   *
   * A key that contradicts the one this session already carries ends the session rather than
   * relabelling it. Two banks and one controller is an ordinary boat, and a silent relabel would
   * hand one bank's amp-hours to the other with nothing on screen to say so.
   */
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
      this.rememberPackDevice(key, this.clock.now())
    }
    this.publish()
  }

  /** The controller's key digest, computed once per scan after `start()` has already resolved. */
  identifySolar(key: DeviceKey, modelId: number | null): void {
    if (this.disposed) return
    this.solarDeviceKey = key
    this.solarLabel = solarDefaultLabel(modelId)

    const session = this.session
    if (session === null) return
    session.solarDeviceKey = key
    if (!session.solarDeviceCounted) {
      session.solarDeviceCounted = true
      this.rememberSolarDevice(key, this.clock.now())
    }
  }

  /** The settings frame is not in the read commands, so it arrives if the BMS volunteers it, or never. */
  noteSettings(settings: BmsSettings): void {
    if (this.disposed) return
    this.settings = settings
    if (this.session !== null) this.session.settings = settings
  }

  /**
   * The annunciator changed. The entry keeps the headline exactly as it read at the time; nothing
   * downstream re-runs the alarm engine against numbers from hours later.
   */
  noteStatus(worst: FaultLevel, headline: string): void {
    if (this.disposed) return
    if (worst === this.statusWorst && headline === this.statusHeadline) return
    this.statusWorst = worst
    this.statusHeadline = headline

    const session = this.session
    if (session === null) return
    this.appendStatusEntry(session, this.clock.now(), worst, headline)
  }

  /**
   * The faults standing this instant, with the readings behind them.
   *
   * A warning is written once, when its title first stands at a given level, and again if it
   * clears and returns — so a fault standing for an hour is one row, not thirty-six hundred. An
   * episode is keyed on level as well as title, so a fault that escalates (warning → serious) is
   * recorded a second time at the higher level rather than frozen at the first: the imbalance and
   * path-resistance faults share one title across two levels, where the MOSFET tiers do not. The
   * snapshot is the caller's raw readings at this instant. Out of the sample budget: warnings die
   * with their session, never on their own.
   */
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
    // Drop cleared episodes so a fault that returns, or steps back down a level, records afresh.
    for (const key of session.activeWarnings) {
      if (!present.has(key)) session.activeWarnings.delete(key)
    }
  }

  /**
   * The pack link went away while the scan may still be up.
   *
   * The snapshot is passed in because the caller nulls its own ref immediately afterwards, and the
   * session has to keep the freshest state it saw. Solar rows carry on into the same session; the
   * coverage runs across the gap become pack-only, which is the true statement.
   */
  endPackStream(final: BatterySnapshot | null, reason: PackStreamEndReason): void {
    const session = this.session
    if (session === null || !session.packStreamOpen) return
    if (final !== null) session.finalBattery = final
    session.packStreamOpen = false
    session.packGapReason = reason
    // Stop the last snapshot standing in for a pack that is no longer reporting: without this the
    // house figure would be computed against a frozen current for as long as the scan runs.
    session.heldPack = null
    this.sealPackChunk(session)
    this.flush(session)
  }

  /** Idempotent: `notePack` calls it on the first snapshot back, and telemetry may call it too. */
  beginPackStream(): void {
    const session = this.session
    if (session === null || session.packStreamOpen) return
    this.reopenPackStream(session, this.clock.now())
    this.publish()
  }

  /**
   * The controller went quiet or the scan stopped. Not a session end — the scan may still be up
   * and the controller may come back, and a later reading reopens the stream on its own.
   */
  endSolarStream(): void {
    const session = this.session
    if (session === null || !session.solarStreamOpen) return
    session.solarStreamOpen = false
    session.heldSolar = null
    this.sealSolarChunk(session)
    this.flush(session)
  }

  /** Push the buffered tails at the disk. Safe to call at any time and on no session at all. */
  checkpoint(): void {
    const session = this.session
    if (session === null) return
    this.flush(session)
  }

  /**
   * Closes the session for good. Idempotent, and never resurrects one it already closed.
   *
   * A session that recorded fewer rows than the archive's floor is deleted rather than kept: a row
   * claiming a watch that holds four samples is worse than no row.
   */
  finish(reason: SessionEndReason): void {
    const session = this.session
    if (session === null) return

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
      // It is only knowable at the end, but it belongs where it happened.
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
    this.publish()

    this.enqueue(async () => {
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

  /** Resolves once every write enqueued so far has been attempted. It never rejects. */
  drain(): Promise<void> {
    return this.chain
  }

  /**
   * Stops the timers and lets go of the open session without closing it. A recorder torn down mid
   * recording has not learned anything about how the session ended, and inventing an end reason
   * would be a lie; the stale-heartbeat sweep closes it 'abandoned' on the next load, which is
   * exactly what happened.
   */
  dispose(): void {
    if (this.disposed) return
    this.checkpoint()
    this.disposed = true
    this.stopClock()
    this.session = null
    this.publish()
  }

  // ── opening and closing ────────────────────────────────────────────────────

  /**
   * The session opens on the first row of either stream, never on a link going live: `connect()`
   * resolves once the read commands are written, and at that instant there is no identity and no
   * reading to open a session with. A BMS that connects and sends nothing therefore records
   * nothing, which is the honest outcome.
   */
  private ensureOpen(at: number): OpenSession | null {
    if (this.session !== null) return this.session
    if (this.disposed) return null
    const store = this.usableStore()
    if (store === null) return null

    const session: OpenSession = {
      id: this.newId(),
      startedAt: at,
      continues: this.continuesSessionId,
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
      lastPaired: null,
      ledgerBeforeLastRow: EMPTY_LEDGER,
      ledger: EMPTY_LEDGER,
      coverage: [],
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

    // A fault standing when the session opened belongs in its entries: the status watch only fires
    // on a change, so nothing else would ever record it.
    if (this.statusWorst !== 'good') {
      this.appendStatusEntry(session, at, this.statusWorst, this.statusHeadline)
    }

    this.session = session
    this.failure = null
    this.continuesSessionId = null
    this.startClock()

    if (session.packDeviceKey !== null) {
      session.packDeviceCounted = true
      this.rememberPackDevice(session.packDeviceKey, at)
    }
    if (session.solarDeviceKey !== null) {
      session.solarDeviceCounted = true
      this.rememberSolarDevice(session.solarDeviceKey, at)
    }

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
      await store.openSession(record)
    })
    this.publish()
    return session
  }

  /**
   * The store rejected a write for this session without a storage failure to name, which leaves
   * one explanation: the row is gone or was closed under us, by the recovery sweep or by another
   * tab. A frozen tab that thaws lands here. It does not resurrect the closed row — the next
   * observation opens a fresh session pointing back at it.
   */
  private abandonLostSession(session: OpenSession): void {
    if (this.session !== session) return
    this.continuesSessionId = session.id
    this.session = null
    this.stopClock()
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

  // ── appending ──────────────────────────────────────────────────────────────

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

  /**
   * Folds one instant of the merged timeline into the running account.
   *
   * This has to walk the same rows a later recomputation over the stored chunks would walk, or the
   * cached ledger stops being a cache and becomes a second opinion. Two rows stamped in the same
   * millisecond are one instant to the join, so the second replaces the first here rather than
   * accumulating beside it.
   */
  private foldRow(session: OpenSession, at: number): void {
    const row: PairedSample = {
      at,
      pack: pairedWithin(session.heldPack, at),
      solar: pairedWithin(session.heldSolar, at),
    }
    const previous = session.lastPaired

    if (previous !== null && previous.at === at) {
      session.ledger = mergeLedgers(session.ledgerBeforeLastRow, ledgerOfSample(row))
    } else {
      const upToRow =
        previous === null ? EMPTY_LEDGER : mergeLedgers(session.ledger, ledgerOfInterval(previous, row))
      if (previous !== null) {
        session.coverage = appendCoverage(
          session.coverage,
          previous.at,
          at,
          classifyInterval(previous, row),
        )
      }
      session.ledgerBeforeLastRow = upToRow
      session.ledger = mergeLedgers(upToRow, ledgerOfSample(row))
    }
    session.lastPaired = row

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
      // Nothing was ever written into it, so the sequence number is handed back rather than
      // leaving a gap in the chunk keys of a stream that never stopped.
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

  // ── writing ────────────────────────────────────────────────────────────────

  /**
   * Asks for a write. Only one is ever in flight per session: a sealed chunk that went out twice
   * would be counted twice, because the archive's total moves on a seal and nowhere else.
   */
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

  /** The sealed chunks in order, then whatever each tail holds now. */
  private async writePending(session: OpenSession): Promise<void> {
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
      // A first failure waits for the next checkpoint; the store may have pruned itself room.
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

  private async commit(
    store: HistoryStore,
    session: OpenSession,
    chunk: HistoryChunk,
  ): Promise<CommitResult> {
    try {
      const outcome = await store.commitChunk(chunk, this.patchOf(session))
      if (outcome.stored) return 'stored'
      if (outcome.failure === null) return 'lost'
      // The archive is refusing writes. Rows already buffered stay buffered and are retried, but
      // nothing new is appended for the rest of this session — the instruments do not care.
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
      coverage: session.coverage,
      ledger: session.ledger,
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

  // ── devices ────────────────────────────────────────────────────────────────

  /**
   * One upsert per device per session. `userLabel` is null because the recorder has never seen
   * one; the store keeps whatever the owner typed.
   */
  private rememberPackDevice(key: DeviceKey, at: number): void {
    const info = this.deviceInfo
    this.upsertDevice(key, (sessionCount) => ({
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
    }))
  }

  private rememberSolarDevice(key: DeviceKey, at: number): void {
    this.upsertDevice(key, (sessionCount) => ({
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
    }))
  }

  private upsertDevice(key: DeviceKey, build: (sessionCount: number) => DeviceRecord): void {
    const store = this.usableStore()
    if (store === null) return
    this.enqueue(async () => {
      // The store never lowers a count it already holds, so the writer asserts the new total
      // rather than an increment. Reading it costs one scan of a handful of rows, once per
      // session, and it happens on the write chain rather than in a radio callback.
      const known = (await store.listDevices()).find((device) => device.key === key)
      await store.upsertDevice(build((known?.sessionCount ?? 0) + 1))
    })
  }

  // ── entries ────────────────────────────────────────────────────────────────

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

  // ── plumbing ───────────────────────────────────────────────────────────────

  /** Null whenever nothing may be written: no probe yet, or a store that answered honestly no. */
  private usableStore(): HistoryStore | null {
    const store = this.resolveStore()
    if (store === null || !store.availability.usable) return null
    return store
  }

  private enqueue(work: () => Promise<void>): void {
    // The chain must never reject: a rejection here surfaces as an unhandled rejection with no
    // caller to catch it, and there is nothing useful to do about a store that will not write.
    this.chain = this.chain.then(work).catch(() => undefined)
  }

  private startClock(): void {
    if (this.ticker !== null || typeof setInterval !== 'function') return
    this.ticker = setInterval(() => this.tick(), CHECKPOINT_INTERVAL_MS)
  }

  private stopClock(): void {
    if (this.ticker === null) return
    clearInterval(this.ticker)
    this.ticker = null
  }

  private tick(): void {
    const session = this.session
    if (session === null) return
    if (this.clock.monotonic() - this.lastObservationMonotonic >= SESSION_IDLE_TIMEOUT_MS) {
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
    }
    if (sameState(this.published, next)) return
    this.published = next
    this.onStateChange?.(next)
  }
}

function browserClock(): RecorderClock {
  return {
    now: () => Date.now(),
    // Not `performance.timeOrigin + performance.now()`: the offset is the wall clock again, and
    // the whole point of the monotonic reading is that a clock step cannot move it.
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
  }
}

function sameState(left: RecorderState, right: RecorderState): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.startedAt === right.startedAt &&
    left.packSamples === right.packSamples &&
    left.solarSamples === right.solarSamples &&
    left.droppedChunks === right.droppedChunks &&
    left.failure === right.failure
  )
}

/** The same bound the read-side join applies, so the recorded rows and a re-read agree. */
function pairedWithin<T extends { readonly at: number }>(sample: T | null, at: number): T | null {
  return sample !== null && at - sample.at <= MAX_PAIRING_AGE_MS ? sample : null
}

function packSampleOf(snapshot: BatterySnapshot, at: number): PackSample {
  return {
    at,
    currentA: snapshot.current,
    packVoltageV: snapshot.packVoltage,
    stateOfCharge: snapshot.stateOfCharge,
    remainingCapacityAh: snapshot.remainingCapacity,
    cellDeltaV: snapshot.cellDelta,
    highestCell: snapshot.highestCell,
    lowestCell: snapshot.lowestCell,
    mosfetTemperatureC: snapshot.mosfetTemperature,
    temperatureSensor1C: snapshot.temperatureSensor1,
    temperatureSensor2C: snapshot.temperatureSensor2,
    chargingEnabled: snapshot.chargingEnabled,
    dischargingEnabled: snapshot.dischargingEnabled,
  }
}

function solarSampleOf(reading: SolarReading, rssi: number, at: number): SolarSample {
  return {
    at,
    chargeState: reading.chargeState,
    chargerError: reading.chargerError,
    batteryVoltageV: reading.batteryVoltage,
    batteryCurrentA: reading.batteryCurrent,
    yieldTodayKwh: reading.yieldTodayKwh,
    pvPowerW: reading.pvPower,
    loadCurrentA: reading.loadCurrent,
    rssi,
  }
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

/** Coarse enough to read at a glance, precise enough that nobody mistakes 8 s for 8 min. */
function describeSpan(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 90) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min`
  return `${Math.round(minutes / 60)} h`
}
