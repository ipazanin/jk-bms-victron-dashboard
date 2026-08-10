/**
 * The whole control surface of the fake, in one object with no Vue in it.
 *
 * Every state the dashboard can be in that needs hardware to reach is a method here: a pack that
 * refuses the connection, a controller that answers a register with a status code, a cell drifting
 * apart from its neighbours, a radio switched off. A method rather than a handler inside a panel,
 * because the panel is one caller — the other is a spec, which has to reach the same states without
 * a DOM to click on.
 *
 * Two rules shape the rest of the file.
 *
 * Nothing plays into a link that is not up, and no frame is ever handed over from inside an
 * attempt. The app only calls what it is looking at live once `connect()` has resolved, and gates
 * recording, warnings and the automatic stored-log read on that; a fake that emitted a snapshot
 * synchronously inside `connect()` would paint numbers, record none of them, and do it under the
 * styling of a session being reviewed. Playback is therefore started from a timer, which cannot run
 * until the caller's own continuation has.
 *
 * And the recording is never edited. Every lever is a pure function over the frame on its way out,
 * held in a stack that is rebuilt whenever a lever moves, so the same scenario replayed with the
 * levers off is the bytes the boat produced.
 */

import type { BatterySnapshot, DeviceInfo } from '../../../domain/bms/types'
import type { ChargeState, SolarReading } from '../../../domain/solar/types'
import { forgetLastDevice, saveLastDevice } from '../../../application/lastDevice'
import {
  forgetAdvertisementKey,
  loadAdvertisementKey,
  saveAdvertisementKey,
} from '../../../application/storage'
import { unavailableHistoryStore } from '../../../application/history/port'
import type { HistoryStore, HistoryUnavailableReason } from '../../../application/history/port'
import type { BleCapabilities } from '../capabilities'
import type { BmsLink, JkBmsHandlers } from '../JkBmsClient'
import type { SolarHistoryHandlers, SolarHistoryLink } from '../VictronHistoryClient'
import type { SolarScan, VictronHandlers } from '../solarScan'
import { FakeBleEnvironment } from './FakeBleEnvironment'
import { PlaybackClock } from './PlaybackClock'
import { fakeBmsRadio, fakeSolarHistoryRadio, fakeSolarRadio } from './fakeRadios'
import type { FakeBmsRadio, FakeSolarHistoryRadio, FakeSolarRadio } from './fakeRadios'
import type { PackFrame } from './fixture/PackFrame'
import type { PlaybackFixture } from './fixture/PlaybackFixture'
import type { PlaybackScenario } from './fixture/PlaybackScenario'
import type { ScenarioName } from './fixture/ScenarioName'
import type { SolarFrame } from './fixture/SolarFrame'
import {
  partialRingRead,
  readWithoutStoredLog,
  refusedSweep,
  revisedTodaySweep,
  shortRunRead,
  tornBurstRead,
  tornStreamSweep,
  totalsOnlySweep,
  unansweredRead,
  unansweredSweep,
  unwrittenHistorySweep,
  wholeHistorySweep,
  wholeRingRead,
} from './transfers'

/** Applied to a played frame on its way to the handler. The fixture itself is never touched. */
type PackMutation = (snapshot: BatterySnapshot) => BatterySnapshot

type SolarMutation = (reading: SolarReading) => SolarReading

/**
 * What the panel renders about playback. It is a snapshot taken when something changes, and
 * deliberately not on every frame: a readout that moved four times a second would put the dev panel
 * on the same render path as the instruments it exists to watch.
 */
export interface FakePlaybackState {
  /**
   * Null until the recording has arrived, and for good if it never does — `recordingFailure` is
   * what separates the two.
   */
  readonly scenario: ScenarioName | null
  /**
   * Why the recording never arrived, and null while it is on its way or already in hand.
   *
   * The fetch is the one thing here that can fail outright — a development server restarted
   * mid-load, a phone tether that dropped, a hand-edited fixture — and a fake with no recording sits
   * there looking exactly like a fake nobody has connected yet. Whoever renders this state has to
   * say so, because that is the failure which otherwise reads as working software.
   */
  readonly recordingFailure: string | null
  /** True while a radio is up and frames are being handed over. */
  readonly running: boolean
  readonly paused: boolean
  readonly speed: number
  /** Frames handed over on this lap, out of the scenario's own total. */
  readonly delivered: number
  readonly total: number
  /** How many times the scenario has been round. */
  readonly laps: number
  /** Both radios are down, which is the only time the clock may be moved. */
  readonly linksIdle: boolean
}

const MS_PER_SECOND = 1000
const MS_PER_HOUR = 3_600_000
const MILLIVOLTS_PER_VOLT = 1000
const MILLIOHMS_PER_OHM = 1000

/** The opaque Web Bluetooth id a chooser would have handed back, and the name beside it. */
const DEMO_DEVICE_ID = 'fake-pack-0001'
const DEMO_DEVICE_NAME = 'JK-BMS demo'

/**
 * Thirty-two hex characters that decrypt nothing. The Connect page will not offer to start a solar
 * scan until a key of that shape is stored, and the key a real controller needs can only be read
 * back out of the vendor app — so playback seeds its own throwaway rather than tempting anyone to
 * paste the real one into a fake.
 */
const DEMO_ADVERTISEMENT_KEY = '00112233445566778899aabbccddeeff'

/**
 * What the Log prints when the archive is set to fail. It names the lever rather than guessing at a
 * cause, because there is no cause: the store is working and has been told to refuse.
 */
const ARCHIVE_FAILURE_MESSAGE = 'The archive is set to fail every call.'

/** Recomputes everything the pack derives from its own cell readings, so a lever cannot half-move. */
function withCellVoltages(snapshot: BatterySnapshot, cellVoltages: readonly number[]): BatterySnapshot {
  if (cellVoltages.length === 0) return snapshot
  let highest = 0
  let lowest = 0
  let total = 0
  for (let cell = 0; cell < cellVoltages.length; cell += 1) {
    if (cellVoltages[cell] > cellVoltages[highest]) highest = cell
    if (cellVoltages[cell] < cellVoltages[lowest]) lowest = cell
    total += cellVoltages[cell]
  }
  return {
    ...snapshot,
    cellVoltages,
    averageCellVoltage: total / cellVoltages.length,
    cellDelta: cellVoltages[highest] - cellVoltages[lowest],
    // The pack numbers its cells from one.
    highestCell: highest + 1,
    lowestCell: lowest + 1,
  }
}

/**
 * Cells spread evenly about their own mean, so they move apart without the pack's terminal voltage
 * moving with them. The offset does not vary with load, which is what makes it charge divergence:
 * the fit reads a slope of zero and an intercept spread, and the alarm can then say the balancer
 * should be working rather than that something is uncorrected.
 */
function spreadCellsBy(millivolts: number): PackMutation {
  return (snapshot) => {
    const cells = snapshot.cellVoltages.length
    if (cells < 2) return snapshot
    const volts = millivolts / MILLIVOLTS_PER_VOLT
    const mean = snapshot.averageCellVoltage
    return withCellVoltages(
      snapshot,
      snapshot.cellVoltages.map((_unused, cell) => mean + volts * (cell / (cells - 1) - 0.5)),
    )
  }
}

/**
 * One cell's terminal moved against the pack's own current, which is what extra resistance in its
 * lead, terminal or busbar does. The last cell carries it, and the sign follows the load: it reads
 * low under discharge and high under charge, so the fit recovers the milliohms as a slope.
 *
 * Not `cellResistances`. The BMS measures that through its balance leads at milliamps and reports
 * tens of milliohms, which is not this resistance and is roughly fifty times too large to be it;
 * writing there would move a number on the ladder and nothing else.
 */
function tiltLastCellAgainstCurrent(milliohms: number): PackMutation {
  return (snapshot) => {
    const cells = snapshot.cellVoltages.length
    if (cells === 0) return snapshot
    const voltages = [...snapshot.cellVoltages]
    voltages[cells - 1] += (milliohms * snapshot.current) / MILLIOHMS_PER_OHM
    return withCellVoltages(snapshot, voltages)
  }
}

/**
 * Whether a member of the store is one the real archive must always answer.
 *
 * The subscription outlives every flip of the levers, so a page told its archive vanished has to
 * keep the channel it will hear about the archive coming back on; and a store that is never closed
 * holds the database open against the next schema upgrade in every other tab.
 */
function reachesTheRealArchive(property: string | symbol): boolean {
  return property === 'watch' || property === 'close' || property === 'noteViewing'
}

/**
 * Whether a member of the store is one of the writes that reports a refusal instead of throwing.
 *
 * These three are the whole of the archive's polite-refusal surface: each answers with a record
 * carrying `stored: false` and the reason it did not store, and `commitChunk` is the only route the
 * recorder has to a failure of its own. Nothing else here can refuse without inventing a channel.
 */
function reportsItsOwnRefusal(property: string | symbol): boolean {
  return (
    property === 'commitChunk' ||
    property === 'appendRingSnapshot' ||
    property === 'appendSolarHistory'
  )
}

/**
 * A member of one store, ready to be called on the store it came from.
 *
 * Bound rather than handed over bare: the adapter's methods reach their own fields, and a method
 * pulled off a facade and called against it would send every one of those reads back through the
 * facade for it to answer.
 */
function boundTo(store: HistoryStore, property: string | symbol): unknown {
  const member: unknown = Reflect.get(store, property)
  return typeof member === 'function' ? member.bind(store) : member
}

/**
 * One store handed to the app, standing in front of four: the real archive, a browser that keeps
 * none, an archive whose every call fails, and an archive that reads back fine and turns away the
 * rows offered to it.
 *
 * The levers are read here, once, rather than on every call the app makes — which is what gives a
 * lever a store of its own to be seen through. Everything the lever decides is settled by the time
 * this returns, so the page has to be handed the new object for a lever to reach it at all:
 * measured, a screen left holding the previous store goes on reading and writing the setting that
 * store was built with, and the archive controls stop changing anything a reader can see.
 */
function archiveAsTheLeversLeaveIt(
  real: HistoryStore,
  standIn: HistoryStore | null,
  everyCallFails: boolean,
  refusingWrites: HistoryStore | null,
): HistoryStore {
  return new Proxy(real, {
    get(target, property) {
      if (reachesTheRealArchive(property)) return boundTo(target, property)
      if (standIn !== null) return boundTo(standIn, property)
      if (everyCallFails) {
        // Availability is a fact about the browser and stays true: this archive is there, and it is
        // failing. What the Log prints for it is the failure line, not the blocked one.
        const member = boundTo(target, property)
        if (typeof member !== 'function') return member
        return () => Promise.reject(new Error(ARCHIVE_FAILURE_MESSAGE))
      }
      if (refusingWrites !== null && reportsItsOwnRefusal(property)) {
        return boundTo(refusingWrites, property)
      }
      return boundTo(target, property)
    },
  })
}

/** The scenario a name asks for, from the recording that holds it. */
function scenarioNamed(fixture: PlaybackFixture, name: ScenarioName): PlaybackScenario {
  const scenario = fixture.scenarios.find((candidate) => candidate.name === name)
  if (scenario === undefined) throw new Error(`the recording holds no scenario named ${name}`)
  return scenario
}

export class FakeRadioController {
  /**
   * The recording, fetched rather than imported so that the real page never carries it, which makes
   * it the one thing here that is not in hand the moment the controller is. Everything that reads a
   * frame, a scenario or the pack's own account of itself waits on it; the levers, the capabilities
   * and the archive do not, because none of them is about what was recorded.
   *
   * Being fetched, it can also fail. That is reported once, from the constructor, and every waiter
   * below then declines to play rather than each raising the same failure again.
   */
  private readonly recording: Promise<PlaybackFixture>
  private fixture: PlaybackFixture | null = null
  private recordingFailure: string | null = null
  readonly bleEnvironment: FakeBleEnvironment
  private readonly pack: FakeBmsRadio
  private readonly solar: FakeSolarRadio
  private readonly solarHistory: FakeSolarHistoryRadio
  private readonly clock: PlaybackClock
  private readonly listeners = new Set<() => void>()

  private scenario: PlaybackScenario | null = null
  private laps = 0
  /**
   * Seconds added to every snapshot's uptime, one span per lap. The app resolves the pack's event
   * log against uptime, so a walk that started again at the recorded value would re-date the whole
   * logbook backwards every few minutes.
   */
  private uptimeCarrySeconds = 0
  private holdingAtFirstFrame = false
  private anonymousPack = false
  private clockOffset = 0

  private realArchive: HistoryStore | null = null
  private absentArchive: HistoryStore | null = null
  private archiveRejects = false
  private archiveRefusingWrites: HistoryStore | null = null
  private readonly archiveListeners = new Set<(store: HistoryStore) => void>()

  private cellSpreadMv: number | null = null
  private pathResistanceMilliohms: number | null = null
  private mosfetTemperatureC: number | null = null
  private cellTemperatureC: number | null = null
  private chargeMosfetOn: boolean | null = null
  private dischargeMosfetOn: boolean | null = null
  private stateOfChargePercent: number | null = null
  private packMutations: readonly PackMutation[] = []

  private chargerErrorCode: number | null = null
  private forcedChargeState: ChargeState | null = null
  private loadCurrentA: number | null = null
  private measurementsBlanked = false
  private busVoltageOffsetV: number | null = null
  private houseLoadOffsetA: number | null = null
  private forcedRssi: number | null = null
  private solarMutations: readonly SolarMutation[] = []

  constructor(recording: Promise<PlaybackFixture>) {
    this.bleEnvironment = new FakeBleEnvironment()
    this.pack = fakeBmsRadio(() => this.packLinkChanged())
    this.solar = fakeSolarRadio(() => this.syncPlayback())
    this.solarHistory = fakeSolarHistoryRadio()
    this.clock = new PlaybackClock({
      onPack: this.deliverPack,
      onSolar: this.deliverSolar,
      onLap: this.countLap,
    })

    this.pack.identifyAs(DEMO_DEVICE_NAME, DEMO_DEVICE_ID)
    this.answerStoredLogWithWholeRing('earlier')
    this.answerSweepWithWholeHistory()
    if (loadAdvertisementKey() === '') this.seedAdvertisementKey()

    this.recording = recording.then((fixture) => {
      this.fixture = fixture
      this.scenario = fixture.scenarios[0]
      // A radio that came up before the recording landed asked for a walk there was no scenario
      // for, and loading one arms it. Nothing is missed by the wait: the walk starts at its own
      // first frame whenever it starts.
      this.clock.play(this.scenario)
      this.announce()
      return fixture
    })

    // The one place a recording that never arrived is reported.
    void this.recording.catch((rejection: unknown) => {
      this.recordingFailure = rejection instanceof Error ? rejection.message : String(rejection)
      this.announce()
    })
  }

  /**
   * Resolves once the recording is in memory and its first scenario is the one loaded, and rejects
   * with whatever stopped it arriving. A caller that waits on this is asking to be told either way.
   */
  whenReady(): Promise<void> {
    return this.recording.then(() => undefined)
  }

  // ── the ports ──────────────────────────────────────────────────────────────

  createBmsLink(handlers: JkBmsHandlers): BmsLink {
    return this.pack.create(handlers)
  }

  createSolarScan(handlers: VictronHandlers): SolarScan {
    return this.solar.create(handlers)
  }

  createSolarHistoryLink(handlers: SolarHistoryHandlers): SolarHistoryLink {
    return this.solarHistory.create(handlers)
  }

  /**
   * The wall clock, moved by however far the clock lever has been pushed. Real, and never frozen:
   * a stopped clock gives every session zero duration and the archive deletes them all on close.
   */
  now(): number {
    return Date.now() + this.clockOffset
  }

  // ── watching ───────────────────────────────────────────────────────────────

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get state(): FakePlaybackState {
    return {
      scenario: this.scenario?.name ?? null,
      recordingFailure: this.recordingFailure,
      running: this.clock.running,
      paused: this.clock.paused,
      speed: this.clock.speed,
      delivered: this.clock.delivered,
      total: this.clock.total,
      laps: this.laps,
      linksIdle: !this.pack.connected && !this.solar.scanning,
    }
  }

  /** What the recording holds, so the panel can name its own buttons from the fixture. */
  get scenarios(): readonly PlaybackScenario[] {
    return this.fixture?.scenarios ?? []
  }

  // ── playback ───────────────────────────────────────────────────────────────

  /**
   * Swaps what is playing without touching either link. The instruments jump, which is the point of
   * the control, and the archive records the jump because it cannot tell one afternoon from another.
   */
  playScenario(name: ScenarioName): void {
    this.withRecording((fixture) => {
      this.scenario = scenarioNamed(fixture, name)
      this.clock.play(this.scenario)
      this.announce()
    })
  }

  pausePlayback(): void {
    this.clock.pause()
    this.announce()
  }

  resumePlayback(): void {
    this.clock.resume()
    this.announce()
  }

  /** One frame, so a state that lasts a quarter of a second can be looked at. */
  stepPlayback(): void {
    this.clock.step()
    this.announce()
  }

  setSpeed(multiplier: number): void {
    this.clock.setSpeed(multiplier)
    this.announce()
  }

  /**
   * Holds the link open with no frame behind it. A connected pack that has not yet said anything is
   * a state of its own, and it is the one a real handshake passes through on its way to live.
   */
  holdAtFirstFrame(hold: boolean): void {
    this.holdingAtFirstFrame = hold
    this.syncPlayback()
  }

  // ── what the browser can do ────────────────────────────────────────────────

  /** Takes effect on the next load, because the app reads its capabilities once and paints them. */
  overrideCapabilities(overrides: Partial<BleCapabilities>): void {
    this.bleEnvironment.override(overrides)
    this.announce()
  }

  clearCapabilityOverrides(): void {
    this.bleEnvironment.clearOverrides()
    this.announce()
  }

  get capabilityOverrides(): Partial<BleCapabilities> {
    return this.bleEnvironment.overrides
  }

  /** Live, as on real hardware. True is the one value that sets a silent reconnect going. */
  pushAdapter(available: boolean | null): void {
    this.bleEnvironment.pushAdapter(available)
    this.announce()
  }

  /** The chooser-free reconnect needs a remembered pack, which is read from storage on load. */
  seedLastDevice(): void {
    saveLastDevice(DEMO_DEVICE_ID, DEMO_DEVICE_NAME, this.now())
  }

  clearLastDevice(): void {
    forgetLastDevice()
  }

  seedAdvertisementKey(): void {
    saveAdvertisementKey(DEMO_ADVERTISEMENT_KEY)
  }

  /** Leaves the controller unnameable, so a swept history has no ledger to be filed under. */
  clearAdvertisementKey(): void {
    forgetAdvertisementKey()
  }

  // ── the pack's link ────────────────────────────────────────────────────────

  /** How long the app sits on 'Connecting…' before the attempt settles. */
  holdPackAttemptFor(dwellMs: number): void {
    this.pack.holdAttemptsFor(dwellMs)
  }

  /** Null lets the connection succeed. Anything else is what the banner has to explain. */
  failPackConnectWith(rejection: Error | null): void {
    this.pack.failConnectWith(rejection)
  }

  failPackReconnectWith(rejection: Error | null): void {
    this.pack.failReconnectWith(rejection)
  }

  /**
   * The pack goes away inside the next attempt and the attempt then fails. Two banners are in play
   * and only one may be left standing: the drop names the event, and the rejection names its
   * symptom.
   */
  dropDuringNextAttempt(): void {
    this.pack.reportDuringNextAttempt(() => this.pack.emitDisconnect('dropped'))
  }

  /** The link went away underneath the app: out of range, or something else took the pack's slot. */
  dropPack(): void {
    this.pack.emitDisconnect('dropped')
  }

  /** The link is still up and the pack has stopped notifying — the same banner, a different word. */
  stallPack(): void {
    this.pack.emitDisconnect('stalled')
  }

  /** A frame that would not decode, which is an error about the pack and not about an attempt. */
  reportPackFrameError(error: Error): void {
    this.pack.emitError(error)
  }

  /**
   * Anonymous is a pack that gives neither a serial nor a name, which cannot be filed against any
   * device — the archive refuses to invent a key for it and says so on the receipt.
   */
  usePackIdentity(identity: 'named' | 'anonymous'): void {
    this.anonymousPack = identity === 'anonymous'
    this.pack.identifyAs(this.anonymousPack ? null : DEMO_DEVICE_NAME, DEMO_DEVICE_ID)
    this.withRecording((fixture) => {
      if (this.pack.connected) this.pack.emitDeviceInfo(this.deviceInfo(fixture))
    })
  }

  /** The settings frame, which carries the balance trigger every imbalance warning is judged against. */
  emitPackSettings(): void {
    this.withRecording((fixture) => this.pack.emitSettings(fixture.settings))
  }

  emitPackLogbook(): void {
    this.withRecording((fixture) => this.pack.emitLogbook([...fixture.logbook]))
  }

  // ── the controller's link ──────────────────────────────────────────────────

  holdSolarStartFor(dwellMs: number): void {
    this.solar.holdStartFor(dwellMs)
  }

  failSolarStartWith(rejection: Error | null): void {
    this.solar.failStartWith(rejection)
  }

  /** Advertisements have stopped: sunset, or out of range. The scan stays up and may hear it again. */
  emitSolarStale(): void {
    this.solar.emitStale()
  }

  /** Something else on Victron's company id answered, which is a marina and not a fault. */
  emitForeignDevice(): void {
    this.solar.emitForeignDevice()
  }

  /** The model id, which is the whole of what a controller we never connect to says about itself. */
  emitSolarIdentity(modelId: number): void {
    this.solar.emitIdentity(modelId)
  }

  reportSolarError(error: Error): void {
    this.solar.emitError(error)
  }

  // ── what the pack reports ──────────────────────────────────────────────────

  /** Null leaves the captured cells alone. Past fifty millivolts the alarm stops asking questions. */
  setCellSpreadMv(millivolts: number | null): void {
    this.cellSpreadMv = millivolts
    this.rebuildPackMutations()
  }

  /** Milliohms of extra path resistance on one cell, which is wiring and no balancer can fix it. */
  setCellPathResistanceMilliohms(milliohms: number | null): void {
    this.pathResistanceMilliohms = milliohms
    this.rebuildPackMutations()
  }

  setMosfetTemperature(celsius: number | null): void {
    this.mosfetTemperatureC = celsius
    this.rebuildPackMutations()
  }

  setCellTemperature(celsius: number | null): void {
    this.cellTemperatureC = celsius
    this.rebuildPackMutations()
  }

  setChargeMosfet(on: boolean | null): void {
    this.chargeMosfetOn = on
    this.rebuildPackMutations()
  }

  setDischargeMosfet(on: boolean | null): void {
    this.dischargeMosfetOn = on
    this.rebuildPackMutations()
  }

  setStateOfCharge(percent: number | null): void {
    this.stateOfChargePercent = percent
    this.rebuildPackMutations()
  }

  // ── what the controller reports ────────────────────────────────────────────

  /** Any non-zero code is a critical fault and a chip on the solar row. */
  setChargerError(code: number | null): void {
    this.chargerErrorCode = code
    this.rebuildSolarMutations()
  }

  setChargeState(state: ChargeState | null): void {
    this.forcedChargeState = state
    this.rebuildSolarMutations()
  }

  /** Null in every captured advertisement, so the load figure is unreachable without this. */
  setLoadCurrent(amps: number | null): void {
    this.loadCurrentA = amps
    this.rebuildSolarMutations()
  }

  /** A reading with no voltage or current in it: no bus view, and no derived house load. */
  blankSolarMeasurements(blank: boolean): void {
    this.measurementsBlanked = blank
    this.rebuildSolarMutations()
  }

  /** Volts added to the controller's own reading, so the two devices disagree about the bus. */
  setBusVoltageOffset(volts: number | null): void {
    this.busVoltageOffsetV = volts
    this.rebuildSolarMutations()
  }

  /**
   * Amps taken off the current the house load is derived from. Past the noise floor the difference
   * goes negative, which is what an unmeasured charger on the bus looks like: the figure stops
   * being a house load and every renderer of it has to say so.
   */
  setHouseLoadOffsetAmps(amps: number | null): void {
    this.houseLoadOffsetA = amps
    this.rebuildSolarMutations()
  }

  /** dBm, and negative. Zero is read as no signal to show rather than as a weak one. */
  setSolarRssi(rssi: number | null): void {
    this.forcedRssi = rssi
  }

  // ── the pack's stored log ──────────────────────────────────────────────────

  /**
   * A whole captured burst. The two reads are three and a half hours apart on the same pack, so
   * filing the earlier one and then the later one is a real overlap, a real ring shift and the
   * records appended in between — none of it arithmetic invented here.
   */
  answerStoredLogWithWholeRing(read: 'earlier' | 'later'): void {
    this.pack.answerStoredLogWith((packClock) => wholeRingRead(read, packClock.packUtcOffsetMinutes))
  }

  /**
   * Only the frames touching a stretch of the ring. Filing the oldest of one read and then the
   * newest of the other leaves nothing in common between them, which is the break the archive has
   * to declare rather than close.
   */
  answerStoredLogWithRingWindow(read: 'earlier' | 'later', fromIndex: number, toIndex: number): void {
    this.pack.answerStoredLogWith((packClock) =>
      partialRingRead(read, fromIndex, toIndex, packClock.packUtcOffsetMinutes),
    )
  }

  /** A burst whose last stretch is too short to place against anything already held. */
  answerStoredLogWithShortRun(): void {
    this.pack.answerStoredLogWith((packClock) => shortRunRead(packClock.packUtcOffsetMinutes))
  }

  /** The pack ignored the command entirely. */
  answerStoredLogWithSilence(): void {
    this.pack.answerStoredLogWith((packClock) => unansweredRead(packClock.packUtcOffsetMinutes))
  }

  /** Bytes came back and nothing assembled out of them. */
  answerStoredLogWithTornBurst(): void {
    this.pack.answerStoredLogWith((packClock) => tornBurstRead(packClock.packUtcOffsetMinutes))
  }

  /** Whole frames came back and not one of them was a stored log. */
  answerStoredLogWithForeignFrames(): void {
    this.pack.answerStoredLogWith((packClock) => readWithoutStoredLog(packClock.packUtcOffsetMinutes))
  }

  /** No link to read over, which is the one thing a read rejects for rather than reports. */
  rejectStoredLogRead(rejection: Error): void {
    this.pack.answerStoredLogWith(() => Promise.reject(rejection))
  }

  /** How long 'Reading…' stays on screen before the pack answers. */
  holdStoredLogRead(dwellMs: number): void {
    this.pack.holdStoredLogFor(dwellMs)
  }

  // ── the controller's stored history ────────────────────────────────────────

  /** Every register the captured controller answered: the totals, then a month of days. */
  answerSweepWithWholeHistory(): void {
    this.solarHistory.answerSweepWith((handlers) => wholeHistorySweep(handlers))
  }

  /**
   * The same registers again, with today's record further along than the last sweep left it.
   *
   * Worth arming only over a ledger that already holds today, which means after a whole sweep has
   * filed one. Nothing is stored here, so against an empty ledger this appends today like any other
   * first sighting and revises nothing.
   */
  answerSweepWithRevisedToday(): void {
    this.solarHistory.answerSweepWith((handlers) => revisedTodaySweep(handlers))
  }

  /** Every register answers and none of them has been written: a controller just commissioned. */
  answerSweepWithUnwrittenDays(): void {
    this.solarHistory.answerSweepWith((handlers) => unwrittenHistorySweep(handlers))
  }

  /** The totals came back and then the controller stopped answering. */
  answerSweepWithTotalsOnly(): void {
    this.solarHistory.answerSweepWith(() => totalsOnlySweep())
  }

  /** The first read was answered with a status code, so no day was ever asked for. */
  answerSweepWithRefusal(): void {
    this.solarHistory.answerSweepWith(() => refusedSweep())
  }

  /** The tunnel opened and the controller said nothing about a single register. */
  answerSweepWithSilence(): void {
    this.solarHistory.answerSweepWith(() => unansweredSweep())
  }

  /** Bytes arrived off the tunnel and not one protocol unit parsed out of them. */
  answerSweepWithTornStream(): void {
    this.solarHistory.answerSweepWith(() => tornStreamSweep())
  }

  /** A tunnel that would not open, which is the one thing a sweep rejects for. */
  rejectSolarHistorySweep(rejection: Error): void {
    this.solarHistory.answerSweepWith(() => Promise.reject(rejection))
  }

  /** How long 'Sweeping…' stays on screen. A real sweep is bounded at forty-five seconds. */
  holdSolarHistorySweep(dwellMs: number): void {
    this.solarHistory.holdSweepFor(dwellMs)
  }

  // ── the archive ────────────────────────────────────────────────────────────

  /**
   * The store the app should record and read through, given whichever archive levers are set.
   *
   * Called where the storage probe answers — the composition root is the only place that ever holds
   * the archive, and every lever here is inert until what it opens goes through this. The store
   * itself is kept, because the panel's seeding and its wipe have to reach past every lever to the
   * archive that actually holds rows.
   *
   * Whoever calls this also has to take `onArchiveChange`: a lever moving mints a new store, and a
   * page still holding the old one shows the archive it was wired with rather than the one it has.
   */
  archiveFor(store: HistoryStore): HistoryStore {
    this.realArchive = store
    return this.archiveShownFor(store)
  }

  /**
   * Fires with the store the page must switch both halves to, whenever an archive lever moves.
   *
   * Its own listener set rather than `onChange`, which every other lever announces on: switching the
   * store re-reads the whole archive on the other side, and a change of playback speed has no
   * business paying for that.
   */
  onArchiveChange(listener: (store: HistoryStore) => void): () => void {
    this.archiveListeners.add(listener)
    return () => {
      this.archiveListeners.delete(listener)
    }
  }

  /**
   * The archive as it really is, whatever the levers are showing the app. Null only until the
   * storage probe answers, which is long before anyone can open the panel.
   */
  get archive(): HistoryStore | null {
    return this.realArchive
  }

  /**
   * Every reason a browser can have for keeping no archive at all, and null for one that keeps it.
   *
   * The store this switches to never throws: it answers each read as an empty archive and each write
   * with the reason, which is the sentence the Log prints. That is a different screen from a failing
   * archive, and it is the only route to four of them.
   */
  failArchiveWith(reason: HistoryUnavailableReason | null): void {
    this.absentArchive = reason === null ? null : unavailableHistoryStore(reason)
    this.archiveChanged()
  }

  /**
   * An archive that is there and rejects everything asked of it. The only producer of the failure
   * line the views print above the log and above a session, because the store for a browser that
   * keeps no archive is honest by design and cannot fail a caller that asked it politely.
   *
   * Moot while the archive is switched out for an absent one — a browser with no archive has nothing
   * to fail from.
   */
  failEveryArchiveCall(failing: boolean): void {
    this.archiveRejects = failing
    this.archiveChanged()
  }

  /**
   * An archive that is open, reads back everything it holds, and turns away every row that has a
   * way of saying so — a chunk of samples, a stored-log read, a history sweep. The other writes go
   * through, because none of them carries a channel to report a refusal on.
   *
   * The distinction it draws is the one the recorder is written against, and the only route to one
   * of the plate's lines. A store the recorder may not use is a store it never calls, so it opens no
   * session and has nothing to report; a rejected call is swallowed and retried. Only a write that
   * was accepted and answered `stored: false` sets the recorder's own failure, which is what puts
   * 'the log could not be written to' on screen.
   *
   * Quota is the reason, and the only honest one: every other member of the union is a fact settled
   * when the database was opened, and a browser with one of those would never have handed over a
   * store that reads. Moot while either of the levers above is set.
   */
  refuseArchiveWrites(refusing: boolean): void {
    this.archiveRefusingWrites = refusing ? unavailableHistoryStore('quota-exhausted') : null
    this.archiveChanged()
  }

  // ── the clock ──────────────────────────────────────────────────────────────

  /**
   * Moves the wall clock, so a record filed a moment ago can be made a day old and the automatic
   * stored-log read becomes due.
   *
   * Ignored while either radio is up, and the panel disables it for the same reason: a recorder
   * running against a clock that has just jumped writes rows into the future, and the archive keeps
   * them.
   */
  ageClockByHours(hours: number): void {
    if (this.pack.connected || this.solar.scanning) return
    this.clockOffset = hours * MS_PER_HOUR
    this.announce()
  }

  get clockOffsetMs(): number {
    return this.clockOffset
  }

  // ── playing ────────────────────────────────────────────────────────────────

  /**
   * The pack's link came up or went down.
   *
   * The handshake goes out on a timer rather than straight from here, and the delay is the point:
   * the app flips to live in the continuation of the `connect()` it is awaiting, and a device-info
   * frame delivered before that flip is one the archive never hears about. A timer cannot run until
   * that continuation has.
   */
  private packLinkChanged(): void {
    if (this.pack.connected) {
      setTimeout(() => {
        this.withRecording((fixture) => {
          if (!this.pack.connected) return
          this.pack.emitDeviceInfo(this.deviceInfo(fixture))
          this.pack.emitSettings(fixture.settings)
          this.pack.emitLogbook([...fixture.logbook])
        })
      }, 0)
    }
    this.syncPlayback()
  }

  /**
   * Runs something the moment the recording is in hand, and quietly does nothing if it never
   * arrives — the constructor has already said so once, and a lever that raised it again on every
   * press would bury that one report under a wall of the same sentence.
   *
   * The rejection handler is `then`'s second argument rather than a `catch` chained behind it, so
   * the only thing it can ever see is the recording failing. An error thrown by `use` is a bug in
   * the fake and stays an unhandled rejection, which is where a bug belongs.
   */
  private withRecording(use: (fixture: PlaybackFixture) => void): void {
    void this.recording.then(use, () => undefined)
  }

  /**
   * Playback follows the radios: it runs while either is up and stops when both are down, keeping
   * its place, because the boat carried on while nobody was listening. The clock arms itself with a
   * timer, so the first frame after a connection lands strictly after the caller's own continuation.
   */
  private syncPlayback(): void {
    if ((this.pack.connected || this.solar.scanning) && !this.holdingAtFirstFrame) this.clock.start()
    else this.clock.stop()
    this.announce()
  }

  private deviceInfo(fixture: PlaybackFixture): DeviceInfo {
    if (!this.anonymousPack) return fixture.device
    return { ...fixture.device, serialNumber: '' }
  }

  private readonly deliverPack = (frame: PackFrame): void => {
    if (!this.pack.connected) return
    let snapshot = this.carryUptime(frame.battery)
    for (const mutate of this.packMutations) snapshot = mutate(snapshot)
    this.pack.emitSnapshot(snapshot)
  }

  private readonly deliverSolar = (frame: SolarFrame): void => {
    if (!this.solar.scanning) return
    let reading = frame.reading
    for (const mutate of this.solarMutations) reading = mutate(reading)
    this.solar.emitReading(reading, this.forcedRssi ?? frame.rssi)
  }

  private readonly countLap = (): void => {
    const scenario = this.scenario
    if (scenario === null) return
    this.laps += 1
    this.uptimeCarrySeconds += Math.round(scenario.spanMs / MS_PER_SECOND)
    this.announce()
  }

  /** Remaining capacity is left to jump at the seam; nothing dates anything against it. */
  private carryUptime(snapshot: BatterySnapshot): BatterySnapshot {
    if (this.uptimeCarrySeconds === 0) return snapshot
    return { ...snapshot, uptimeSeconds: snapshot.uptimeSeconds + this.uptimeCarrySeconds }
  }

  /**
   * Rebuilt whenever a lever moves, so setting the same lever twice does the same thing as setting
   * it once. The cell levers run first because everything after them reads fields they recompute.
   */
  private rebuildPackMutations(): void {
    const stack: PackMutation[] = []
    if (this.cellSpreadMv !== null) stack.push(spreadCellsBy(this.cellSpreadMv))
    if (this.pathResistanceMilliohms !== null) {
      stack.push(tiltLastCellAgainstCurrent(this.pathResistanceMilliohms))
    }
    const mosfetTemperature = this.mosfetTemperatureC
    if (mosfetTemperature !== null) stack.push((snapshot) => ({ ...snapshot, mosfetTemperature }))
    const temperatureSensor1 = this.cellTemperatureC
    if (temperatureSensor1 !== null) stack.push((snapshot) => ({ ...snapshot, temperatureSensor1 }))
    const chargingEnabled = this.chargeMosfetOn
    if (chargingEnabled !== null) stack.push((snapshot) => ({ ...snapshot, chargingEnabled }))
    const dischargingEnabled = this.dischargeMosfetOn
    if (dischargingEnabled !== null) stack.push((snapshot) => ({ ...snapshot, dischargingEnabled }))
    const stateOfCharge = this.stateOfChargePercent
    if (stateOfCharge !== null) stack.push((snapshot) => ({ ...snapshot, stateOfCharge }))
    this.packMutations = stack
  }

  /** Blanking runs last, so it wins over every lever that would otherwise put a number back. */
  private rebuildSolarMutations(): void {
    const stack: SolarMutation[] = []
    const chargerError = this.chargerErrorCode
    if (chargerError !== null) stack.push((reading) => ({ ...reading, chargerError }))
    const chargeState = this.forcedChargeState
    if (chargeState !== null) stack.push((reading) => ({ ...reading, chargeState }))
    const loadCurrent = this.loadCurrentA
    if (loadCurrent !== null) stack.push((reading) => ({ ...reading, loadCurrent }))
    const offsetVolts = this.busVoltageOffsetV
    if (offsetVolts !== null) {
      stack.push((reading) => ({
        ...reading,
        batteryVoltage: reading.batteryVoltage === null ? null : reading.batteryVoltage + offsetVolts,
      }))
    }
    const offsetAmps = this.houseLoadOffsetA
    if (offsetAmps !== null) {
      stack.push((reading) => ({
        ...reading,
        batteryCurrent: reading.batteryCurrent === null ? null : reading.batteryCurrent - offsetAmps,
      }))
    }
    if (this.measurementsBlanked) {
      stack.push((reading) => ({ ...reading, batteryVoltage: null, batteryCurrent: null, pvPower: null }))
    }
    this.solarMutations = stack
  }

  private archiveShownFor(real: HistoryStore): HistoryStore {
    return archiveAsTheLeversLeaveIt(
      real,
      this.absentArchive,
      this.archiveRejects,
      this.archiveRefusingWrites,
    )
  }

  /**
   * A lever moved, so the page is handed the store it now has. Nothing is announced before the
   * probe answers: there is no archive to stand in front of, and `archiveFor` builds against
   * whatever the levers say the moment it is called.
   */
  private archiveChanged(): void {
    const real = this.realArchive
    if (real !== null) {
      const shown = this.archiveShownFor(real)
      for (const listener of this.archiveListeners) listener(shown)
    }
    this.announce()
  }

  private announce(): void {
    for (const listener of this.listeners) listener()
  }
}
