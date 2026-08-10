// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import type { App as MountedApp, Component } from 'vue'

import { MOSFET_CRITICAL } from '../src/application/severity'
import { loadAdvertisementKey } from '../src/application/storage'
import { createTelemetry } from '../src/application/telemetry'
import type { FaultLevel, Telemetry, TelemetryDeps } from '../src/application/telemetry'
import { CHECKPOINT_INTERVAL_MS } from '../src/application/history/SessionRecorder'
import {
  createHistoryBrowser,
  provideHistoryEnvironment,
  useHistoryBrowser,
} from '../src/application/history/historyBrowser'
import type { HistoryBrowser } from '../src/application/history/historyBrowser'
import type { HistoryStore } from '../src/application/history/port'
import RecordingPlate from '../src/components/RecordingPlate.vue'
import LogView from '../src/components/history/LogView.vue'
import SessionRow from '../src/components/history/SessionRow.vue'
import {
  dropViewedSession,
  fillSampleCounterToNearCapacity,
  seedFakeArchive,
  wipeFakeArchive,
} from '../src/components/dev/seedFakeArchive'
import { MAX_TOTAL_SAMPLES, PRUNE_TARGET_RATIO } from '../src/domain/history/budget'
import type { HistoryMeta, SessionId } from '../src/domain/history/types'
import { FakeRadioController } from '../src/infrastructure/ble/fake/FakeRadioController'
import { loadPlaybackFixture } from '../src/infrastructure/ble/fake/fixture/loadPlaybackFixture'
import { FAKE_ARCHIVE_NAME } from '../src/infrastructure/history/fakeArchiveName'
import { requestAsPromise } from '../src/infrastructure/history/idb'
import {
  DATABASE_NAME,
  DATABASE_VERSION,
  META,
  TOTALS_KEY,
  applySchema,
} from '../src/infrastructure/history/IdbHistoryStore'
import { openHistoryStore } from '../src/infrastructure/history/openHistoryStore'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'

// One row per control the dev panel offers: press it, then look at what the app does about it.
//
// This is the whole reason the controls are methods on a controller with no Vue in it. A panel
// whose levers lived in its own click handlers could only be checked by mounting it and clicking,
// which would test the panel's markup and leave the states it exists to reach — a pack that refuses
// the connection, a ring with a hole in it, an archive that fails every call — asserted nowhere.
// Each case here presses the same method the button presses and then reads what the app made of it.
//
// Three rules the rows obey. A capability is read once, when telemetry is built, so a row that moves
// one reloads the page rather than pretending otherwise. Nothing plays into a link that is not up,
// so a row about what the pack reports connects first. And nothing is asserted against an object the
// fake itself built: a row reads a ref an instrument reads, or the words a view prints with the view
// already on screen. A lever that answers correctly when asked is not a lever a reader can see.

const fixture = await loadPlaybackFixture()

/** Enough of the recording for the first few pack frames of either scenario to have landed. */
const FIRST_FRAMES_MS = 4000
/** Longer than any case waits, so an attempt held for this long is outstanding when it is read. */
const HELD_ATTEMPT_MS = 8000

/** Volts of disagreement about the bus, against a tolerance of three tenths. */
const BUS_DISAGREEMENT_V = 0.5
/** Amps taken off the controller's reading, which puts the derived house load below zero. */
const HOUSE_LOAD_OFFSET_A = 20
/** Milliohms on one cell's path, well past the three the alarm calls a loose joint. */
const LOOSE_JOINT_MILLIOHMS = 8
/** The panel's smaller step on the same lever, which its label states as what it adds. */
const ADDED_JOINT_MILLIOHMS = 4
const MILLIOHMS_PER_OHM = 1000
/**
 * How long the fit needs before it claims a slope. Twice what it measured at: the captured float
 * afternoon separates enough current pairs to identify one inside ten seconds, and the estimator
 * compares every pair with every other, so a window twice that long costs four times as much.
 */
const BALANCE_FIT_MS = 20_000

const CONTROLLER_MODEL_ID = 0xa060

/**
 * The page the panel is pinned to: the controller its buttons call, the telemetry the instruments
 * read, and the archive both write through. Held as accessors so a row that reloads gets the new
 * pair without every row having to take them as arguments.
 */
interface FakePage {
  readonly controller: FakeRadioController
  readonly telemetry: Telemetry
  /**
   * The archive as it really is, which is what a seeding or an assertion about stored rows has to
   * reach. Deliberately the only archive a row is handed: whichever store the levers put in front of
   * it is the app's business, and a row that read the app's copy would be asserting that the fake
   * knows its own mind rather than that a reader saw anything.
   */
  readonly store: MemoryHistoryStore
  /** What a reload does. The persisted levers come back; nothing that was running does. */
  reload(): Promise<void>
  /** Walks the recording for as long as the app would have seen it, then settles the writes. */
  play(forMs: number): Promise<void>
}

/** One control, as the panel offers it. */
interface DevControl {
  /** What the panel's button says. */
  readonly control: string
  /** Presses it, and then whichever of the app's own buttons the state needs. */
  readonly press: (page: FakePage) => Promise<void>
  /** The state it exists to reach. */
  readonly reaches: (page: FakePage) => void | Promise<void>
}

let controller: FakeRadioController
let telemetry: Telemetry
let store: MemoryHistoryStore
let archive: HistoryStore
let sessions = 0

function playbackDeps(): TelemetryDeps {
  return {
    createBmsLink: (handlers) => controller.createBmsLink(handlers),
    createSolarScan: (handlers) => controller.createSolarScan(handlers),
    createSolarHistoryLink: (handlers) => controller.createSolarHistoryLink(handlers),
    bleEnvironment: controller.bleEnvironment,
    historyStore: () => archive,
    refreshRingLedger: async () => undefined,
    refreshSolarLedger: async () => undefined,
    now: () => controller.now(),
    monotonic: () => controller.now(),
    newId: () => `session-${(sessions += 1)}`,
  }
}

/** Builds the pair the composition root builds, in the order it builds them. */
async function load(): Promise<void> {
  controller = new FakeRadioController(loadPlaybackFixture())
  // The recording is fetched rather than imported, so a page is only ready once it has landed.
  await controller.whenReady()
  archive = controller.archiveFor(store)
  // Every archive lever mints a store of its own, so the page has to be handed the new one — this
  // is the shell's own subscription, and without it a lever moves an object nothing is holding.
  controller.onArchiveChange((next) => {
    archive = next
  })
  telemetry = createTelemetry(playbackDeps())
}

const page: FakePage = {
  get controller() {
    return controller
  },
  get telemetry() {
    return telemetry
  },
  get store() {
    return store
  },
  async reload() {
    telemetry.dispose()
    await load()
  },
  async play(forMs) {
    await vi.advanceTimersByTimeAsync(forMs)
    await telemetry.drain()
  },
}

beforeEach(async () => {
  localStorage.clear()
  vi.useFakeTimers()
  sessions = 0
  store = new MemoryHistoryStore({ now: () => controller.now() })
  await load()
})

afterEach(async () => {
  telemetry.dispose()
  await telemetry.drain()
  store.close()
  vi.useRealTimers()
  localStorage.clear()
})

function eachControl(controls: readonly DevControl[]): void {
  it.each(controls)('$control', async (control) => {
    await control.press(page)
    await control.reaches(page)
  })
}

function faultTitles(): string[] {
  return telemetry.faults.value.map((fault) => fault.title)
}

function faultLevel(title: string): FaultLevel | undefined {
  return telemetry.faults.value.find((fault) => fault.title === title)?.level
}

/** Ohms of path resistance the fit claims, and a refusal that names why when it claims none. */
function fittedJointSpread(): number {
  const verdict = telemetry.balance.value
  if (verdict?.kind !== 'fitted') {
    throw new Error('the load has not varied enough for the fit to claim a slope')
  }
  return verdict.jointSpread
}

async function packLive(): Promise<void> {
  await telemetry.connectBms()
  await page.play(FIRST_FRAMES_MS)
}

async function solarLive(): Promise<void> {
  await telemetry.startSolar(loadAdvertisementKey())
  await page.play(FIRST_FRAMES_MS)
}

/** Both radios up before either plays, so the first pack frame has a reading to pair with. */
async function bothLive(): Promise<void> {
  await telemetry.connectBms()
  await telemetry.startSolar(loadAdvertisementKey())
  await page.play(FIRST_FRAMES_MS)
}

/**
 * A live pack that has not yet said anything. The automatic stale-ring read fires off the first
 * snapshot, so a case about what one read did needs a ledger nothing has already filled.
 */
async function packLiveBeforeAnyFrame(): Promise<void> {
  controller.holdAtFirstFrame(true)
  await telemetry.connectBms()
  await page.play(FIRST_FRAMES_MS)
}

describe('what this browser can do', () => {
  eachControl([
    {
      control: 'Web Bluetooth withheld',
      press: async (page) => {
        page.controller.overrideCapabilities({ canConnect: false })
        await page.reload()
      },
      reaches: (page) => expect(page.telemetry.capabilities.canConnect).toBe(false),
    },
    {
      control: 'Insecure context',
      press: async (page) => {
        page.controller.overrideCapabilities({ secureContext: false })
        await page.reload()
      },
      reaches: (page) => expect(page.telemetry.capabilities.secureContext).toBe(false),
    },
    {
      control: 'No chooser-free reconnect',
      press: async (page) => {
        page.controller.seedLastDevice()
        page.controller.overrideCapabilities({ canReconnect: false })
        await page.reload()
        await page.telemetry.reconnectBms()
      },
      reaches: (page) => {
        // The pack is remembered, so the only thing stopping the attempt is the missing API.
        expect(page.telemetry.lastDevice.value).not.toBeNull()
        expect(page.telemetry.bmsState.value).toBe('idle')
      },
    },
    {
      control: 'No route to the controller',
      press: async (page) => {
        page.controller.overrideCapabilities({ canListenSolar: false })
        await page.reload()
      },
      reaches: (page) => expect(page.telemetry.capabilities.canListenSolar).toBe(false),
    },
    {
      control: 'No Bluetooth at all',
      press: async (page) => {
        page.controller.overrideCapabilities({ hasBluetooth: false })
        await page.reload()
      },
      reaches: (page) => {
        // Never reported on rather than reported off: the requirements row then says this browser
        // will not answer instead of blaming a radio that was never there.
        expect(page.telemetry.capabilities.hasBluetooth).toBe(false)
        expect(page.telemetry.adapterOn.value).toBeNull()
      },
    },
    {
      control: 'Every capability back',
      press: async (page) => {
        page.controller.overrideCapabilities({ canConnect: false, canListenSolar: false })
        page.controller.clearCapabilityOverrides()
        await page.reload()
      },
      reaches: (page) => {
        expect(page.telemetry.capabilities.canConnect).toBe(true)
        expect(page.telemetry.capabilities.canListenSolar).toBe(true)
      },
    },
    {
      control: 'Radio on',
      press: async (page) => page.controller.pushAdapter(true),
      reaches: (page) => expect(page.telemetry.adapterOn.value).toBe(true),
    },
    {
      control: 'Radio off',
      press: async (page) => page.controller.pushAdapter(false),
      reaches: (page) => expect(page.telemetry.adapterOn.value).toBe(false),
    },
    {
      control: 'Radio unknown',
      press: async (page) => page.controller.pushAdapter(null),
      reaches: (page) => expect(page.telemetry.adapterOn.value).toBeNull(),
    },
    {
      control: 'Remember a pack',
      press: async (page) => {
        page.controller.seedLastDevice()
        await page.reload()
      },
      reaches: (page) => expect(page.telemetry.lastDevice.value?.id).toBeTruthy(),
    },
    {
      control: 'Forget the remembered pack',
      press: async (page) => {
        page.controller.seedLastDevice()
        page.controller.clearLastDevice()
        await page.reload()
      },
      reaches: (page) => expect(page.telemetry.lastDevice.value).toBeNull(),
    },
  ])
})

describe("the pack's link", () => {
  eachControl([
    {
      control: 'Connect succeeds',
      press: async (page) => {
        await page.telemetry.connectBms()
      },
      reaches: (page) => {
        expect(page.telemetry.bmsState.value).toBe('live')
        expect(page.telemetry.source.value).toBe('live')
      },
    },
    {
      control: 'Hold the attempt open',
      press: async (page) => {
        page.controller.holdPackAttemptFor(HELD_ATTEMPT_MS)
        void page.telemetry.connectBms()
        await page.play(FIRST_FRAMES_MS)
      },
      reaches: (page) => expect(page.telemetry.bmsState.value).toBe('connecting'),
    },
    {
      control: 'Hold at the first frame',
      press: async () => {
        await packLiveBeforeAnyFrame()
      },
      reaches: (page) => {
        expect(page.telemetry.bmsState.value).toBe('live')
        expect(page.telemetry.battery.value).toBeNull()
      },
    },
    {
      control: 'Connect fails — no BMS offered',
      press: async (page) => {
        page.controller.failPackConnectWith(new DOMException('nothing found', 'NotFoundError'))
        await page.telemetry.connectBms()
      },
      reaches: (page) => expect(page.telemetry.bmsError.value).toMatch(/No BMS offered/),
    },
    {
      control: 'Connect fails — the pack refused',
      press: async (page) => {
        page.controller.failPackConnectWith(new DOMException('refused', 'NetworkError'))
        await page.telemetry.connectBms()
      },
      reaches: (page) => expect(page.telemetry.bmsError.value).toMatch(/refused the connection/),
    },
    {
      control: 'Connect fails — the browser blocked it',
      press: async (page) => {
        page.controller.failPackConnectWith(new DOMException('blocked', 'SecurityError'))
        await page.telemetry.connectBms()
      },
      reaches: (page) => expect(page.telemetry.bmsError.value).toMatch(/blocked the request/),
    },
    {
      control: 'Connect fails — this browser cannot',
      press: async (page) => {
        page.controller.failPackConnectWith(new DOMException('no', 'NotSupportedError'))
        await page.telemetry.connectBms()
      },
      reaches: (page) => expect(page.telemetry.bmsError.value).toMatch(/cannot talk to the BMS/),
    },
    {
      control: 'Connect fails — an error of its own',
      press: async (page) => {
        page.controller.failPackConnectWith(new Error('the handshake timed out'))
        await page.telemetry.connectBms()
      },
      reaches: (page) => expect(page.telemetry.bmsError.value).toBe('the handshake timed out'),
    },
    {
      control: 'Connect fails — silently',
      press: async (page) => {
        page.controller.failPackConnectWith(new DOMException('gone', 'AbortError'))
        await page.telemetry.connectBms()
      },
      reaches: (page) => {
        // A chooser the user closed is a decision, not a fault, and the page says nothing.
        expect(page.telemetry.bmsState.value).toBe('idle')
        expect(page.telemetry.bmsError.value).toBeNull()
      },
    },
    {
      control: 'Drop the pack',
      press: async (page) => {
        await packLive()
        page.controller.dropPack()
        await page.telemetry.drain()
      },
      reaches: (page) => {
        expect(page.telemetry.bmsError.value).toMatch(/Lost the BMS/)
        expect(page.telemetry.source.value).toBe('remembered')
      },
    },
    {
      control: 'Stall the pack',
      press: async (page) => {
        await page.telemetry.connectBms()
        await page.play(15_000)
        page.controller.stallPack()
        await page.telemetry.drain()
      },
      reaches: async (page) => {
        // The same banner as a drop, and a different word in the archive.
        expect(page.telemetry.bmsError.value).toMatch(/Lost the BMS/)
        const [listing] = await page.store.listSessions()
        expect(listing.record.endReason).toBe('stalled')
      },
    },
    {
      control: 'A frame that would not decode',
      press: async (page) => {
        await packLive()
        page.controller.reportPackFrameError(new Error('cell frame failed its checksum'))
      },
      reaches: (page) => {
        expect(page.telemetry.bmsError.value).toBe('cell frame failed its checksum')
        expect(page.telemetry.bmsState.value).toBe('live')
      },
    },
    {
      control: 'The pack goes away inside the attempt',
      press: async (page) => {
        page.controller.dropDuringNextAttempt()
        page.controller.failPackConnectWith(new DOMException('refused', 'NetworkError'))
        await page.telemetry.connectBms()
      },
      reaches: (page) => {
        // Two banners were in play and the one naming the event is the one left standing.
        expect(page.telemetry.bmsError.value).toMatch(/Lost the BMS/)
        expect(page.telemetry.bmsError.value).not.toMatch(/refused the connection/)
      },
    },
    {
      control: 'A pack that will not name itself',
      press: async (page) => {
        page.controller.usePackIdentity('anonymous')
        await packLiveBeforeAnyFrame()
        await page.telemetry.readDetailLog()
      },
      reaches: (page) => {
        expect(page.telemetry.detailLog.value?.outcome).toBe('records-read')
        // Read, and filed under nothing: one invented key would merge every unnamed pack.
        expect(page.telemetry.ringFilingNote.value).not.toBeNull()
        expect(page.telemetry.ringIngest.value).toBeNull()
      },
    },
    {
      control: 'Emit the settings frame',
      press: async (page) => page.controller.emitPackSettings(),
      reaches: (page) => expect(page.telemetry.settings.value).toBe(fixture.settings),
    },
    {
      control: 'Emit the logbook',
      press: async (page) => page.controller.emitPackLogbook(),
      reaches: (page) =>
        expect(page.telemetry.logbook.value?.events).toHaveLength(fixture.logbook.length),
    },
    {
      control: 'Disconnect',
      press: async (page) => {
        await packLive()
        await page.telemetry.disconnectBms()
        await page.telemetry.drain()
      },
      reaches: (page) => {
        expect(page.telemetry.bmsState.value).toBe('idle')
        expect(page.telemetry.source.value).toBe('remembered')
      },
    },
  ])
})

describe("the controller's link", () => {
  eachControl([
    {
      control: 'The scan starts and the controller is heard',
      press: async () => {
        await solarLive()
      },
      reaches: (page) => {
        expect(page.telemetry.solarState.value).toBe('live')
        expect(page.telemetry.solar.value).not.toBeNull()
      },
    },
    {
      control: 'Hold the scan starting',
      press: async (page) => {
        page.controller.holdSolarStartFor(HELD_ATTEMPT_MS)
        void page.telemetry.startSolar(loadAdvertisementKey())
        await page.play(FIRST_FRAMES_MS)
      },
      reaches: (page) => expect(page.telemetry.solarState.value).toBe('connecting'),
    },
    {
      control: 'The scan is declined',
      press: async (page) => {
        page.controller.failSolarStartWith(new DOMException('no', 'NotAllowedError'))
        await page.telemetry.startSolar(loadAdvertisementKey())
      },
      reaches: (page) => expect(page.telemetry.solarError.value).toMatch(/scanning was declined/),
    },
    {
      control: 'The scan fails with an error of its own',
      press: async (page) => {
        page.controller.failSolarStartWith(new Error('the radio is busy'))
        await page.telemetry.startSolar(loadAdvertisementKey())
      },
      reaches: (page) => expect(page.telemetry.solarError.value).toBe('the radio is busy'),
    },
    {
      control: 'The chooser is dismissed',
      press: async (page) => {
        page.controller.failSolarStartWith(new DOMException('gone', 'AbortError'))
        await page.telemetry.startSolar(loadAdvertisementKey())
      },
      reaches: (page) => {
        expect(page.telemetry.solarState.value).toBe('idle')
        expect(page.telemetry.solarError.value).toBeNull()
      },
    },
    {
      control: 'The advertisements stop',
      press: async (page) => {
        await solarLive()
        page.controller.emitSolarStale()
        await page.telemetry.drain()
      },
      reaches: (page) => {
        // The scan is still up and the controller may come back, so this is not a session end.
        expect(page.telemetry.solarState.value).toBe('listening')
        expect(page.telemetry.solar.value).toBeNull()
      },
    },
    {
      control: 'Another Victron device answers',
      press: async (page) => page.controller.emitForeignDevice(),
      reaches: (page) => expect(page.telemetry.foreignDeviceSeen.value).toBe(true),
    },
    {
      control: 'The controller names its model',
      press: async (page) => {
        await page.telemetry.startSolar(loadAdvertisementKey())
        await page.telemetry.drain()
        page.controller.emitSolarIdentity(CONTROLLER_MODEL_ID)
        await page.play(FIRST_FRAMES_MS)
      },
      reaches: async (page) => {
        const devices = await page.store.listDevices()
        expect(devices.map((device) => device.defaultLabel)).toContain(
          `SmartSolar · 0x${CONTROLLER_MODEL_ID.toString(16)}`,
        )
      },
    },
    {
      control: 'The scan reports an error',
      press: async (page) => {
        await solarLive()
        page.controller.reportSolarError(new Error('the advertisement would not decrypt'))
      },
      reaches: (page) =>
        expect(page.telemetry.solarError.value).toBe('the advertisement would not decrypt'),
    },
    {
      control: 'Stop the scan',
      press: async (page) => {
        await solarLive()
        page.telemetry.stopSolar()
        await page.telemetry.drain()
      },
      reaches: (page) => expect(page.telemetry.solarState.value).toBe('idle'),
    },
    {
      control: 'Clear the advertisement key',
      press: async (page) => {
        page.controller.clearAdvertisementKey()
        await page.telemetry.readSolarHistory()
      },
      reaches: (page) => {
        expect(page.telemetry.solarHistory.value?.outcome).toBe('days-read')
        expect(page.telemetry.solarHistoryFilingNote.value).not.toBeNull()
        expect(page.telemetry.solarHistoryIngest.value).toBeNull()
      },
    },
  ])
})

describe('what the pack reports', () => {
  /** The fit over the discharge recording as it stands, and again with the panel's step on it. */
  let jointSpreadAsRecorded: number
  let jointSpreadWithTheStep: number

  eachControl([
    {
      control: 'Cell imbalance — serious',
      press: async (page) => {
        page.controller.setCellSpreadMv(60)
        await packLive()
      },
      reaches: () => {
        expect(faultTitles()).toContain('Cell imbalance')
        expect(faultLevel('Cell imbalance')).toBe('serious')
      },
    },
    {
      control: 'Cell imbalance — charge divergence',
      press: async (page) => {
        // Over the pack's own balance trigger and under the fifty millivolts that stops the alarm
        // asking questions, which is the arm that names the balancer.
        page.controller.setCellSpreadMv(20)
        await packLive()
      },
      reaches: () => {
        expect(faultTitles()).toContain('Cell imbalance')
        expect(faultLevel('Cell imbalance')).toBe('warning')
      },
    },
    {
      control: 'Cell path resistance',
      press: async (page) => {
        page.controller.setCellPathResistanceMilliohms(LOOSE_JOINT_MILLIOHMS)
        await page.telemetry.connectBms()
        await page.play(BALANCE_FIT_MS)
      },
      reaches: (page) => {
        // A slope against the load, which is the wiring rather than the charge, so the verdict has
        // to be a fitted one before the alarm may name a joint at all.
        expect(page.telemetry.balance.value?.kind).toBe('fitted')
        expect(faultTitles()).toContain('Cell path resistance')
        expect(faultLevel('Cell path resistance')).toBe('serious')
      },
    },
    {
      control: 'Cell path resistance — the step is what it adds',
      press: async (page) => {
        page.controller.playScenario('discharge')
        await page.telemetry.connectBms()
        await page.play(BALANCE_FIT_MS)
        jointSpreadAsRecorded = fittedJointSpread()

        // The same window again from the top, rather than the lever thrown mid-session: a fit run
        // across the throw would be taken over frames half of which never carried the step.
        await page.reload()
        page.controller.playScenario('discharge')
        page.controller.setCellPathResistanceMilliohms(ADDED_JOINT_MILLIOHMS)
        await page.telemetry.connectBms()
        await page.play(BALANCE_FIT_MS)
        jointSpreadWithTheStep = fittedJointSpread()
      },
      reaches: () => {
        // Why the panel's steps are labelled as what they add rather than as the verdict they
        // produce. The captured discharge carries path resistance of its own before anything is
        // levered, and the fit reports the step on top of it — so a step naming the figure the fit
        // would report would be wrong by whatever the recording underneath happened to be carrying.
        expect(jointSpreadAsRecorded).toBeGreaterThan(0)
        expect(jointSpreadWithTheStep - jointSpreadAsRecorded).toBeCloseTo(
          ADDED_JOINT_MILLIOHMS / MILLIOHMS_PER_OHM,
          6,
        )
      },
    },
    {
      control: 'MOSFET over temperature',
      press: async (page) => {
        page.controller.setMosfetTemperature(MOSFET_CRITICAL)
        await packLive()
      },
      reaches: () => {
        expect(faultTitles()).toContain('MOSFET over temperature')
        expect(faultLevel('MOSFET over temperature')).toBe('critical')
      },
    },
    {
      control: 'Cells warm',
      press: async (page) => {
        page.controller.setCellTemperature(46)
        await packLive()
      },
      reaches: () => expect(faultTitles()).toContain('Cells warm'),
    },
    {
      control: 'Charge MOSFET off',
      press: async (page) => {
        page.controller.setChargeMosfet(false)
        await packLive()
      },
      reaches: () => expect(faultTitles()).toContain('Charge MOSFET off'),
    },
    {
      control: 'Discharge MOSFET off',
      press: async (page) => {
        page.controller.setDischargeMosfet(false)
        await packLive()
      },
      reaches: () => expect(faultTitles()).toContain('Discharge MOSFET off'),
    },
    {
      control: 'Low charge',
      press: async (page) => {
        page.controller.setStateOfCharge(12)
        await packLive()
      },
      reaches: (page) => {
        expect(faultTitles()).toContain('Low charge')
        expect(page.telemetry.battery.value?.stateOfCharge).toBe(12)
      },
    },
  ])
})

describe('what the controller reports', () => {
  eachControl([
    {
      control: 'Charger error',
      press: async (page) => {
        page.controller.setChargerError(2)
        await solarLive()
      },
      reaches: () => {
        expect(faultTitles()).toContain('Charger error')
        expect(faultLevel('Charger error')).toBe('critical')
      },
    },
    {
      control: 'A charge state of your choosing',
      press: async (page) => {
        page.controller.setChargeState('equalize')
        await solarLive()
      },
      reaches: (page) => expect(page.telemetry.solar.value?.chargeState).toBe('equalize'),
    },
    {
      control: 'A load current, which no advertisement carried',
      press: async (page) => {
        page.controller.setLoadCurrent(3.2)
        await solarLive()
      },
      reaches: (page) => expect(page.telemetry.solar.value?.loadCurrent).toBe(3.2),
    },
    {
      control: 'Blank the measurements',
      press: async (page) => {
        page.controller.blankSolarMeasurements(true)
        await bothLive()
      },
      reaches: (page) => {
        // Nothing to reconcile: no bus view and no derived house load.
        expect(page.telemetry.solar.value?.batteryVoltage).toBeNull()
        expect(page.telemetry.bus.value).toBeNull()
      },
    },
    {
      control: 'The two devices disagree about the bus',
      press: async (page) => {
        page.controller.setBusVoltageOffset(BUS_DISAGREEMENT_V)
        await bothLive()
      },
      reaches: (page) => {
        expect(page.telemetry.bus.value?.voltagesAgree).toBe(false)
        expect(faultTitles()).toContain('Devices disagree on bus voltage')
      },
    },
    {
      control: 'An implausible house load',
      press: async (page) => {
        page.controller.setHouseLoadOffsetAmps(HOUSE_LOAD_OFFSET_A)
        await bothLive()
      },
      reaches: (page) => expect(page.telemetry.bus.value?.houseLoadPlausible).toBe(false),
    },
    {
      control: 'No signal to show',
      press: async (page) => {
        page.controller.setSolarRssi(0)
        await solarLive()
      },
      reaches: (page) => expect(page.telemetry.solarRssi.value).toBe(0),
    },
  ])
})

describe("the pack's stored log", () => {
  eachControl([
    {
      control: 'The whole ring',
      press: async (page) => {
        await packLiveBeforeAnyFrame()
        await page.telemetry.readDetailLog()
      },
      reaches: (page) => {
        expect(page.telemetry.detailLog.value?.outcome).toBe('records-read')
        expect(page.telemetry.ringIngest.value?.appended).toBe(
          page.telemetry.detailLog.value?.records.length,
        )
      },
    },
    {
      control: 'The same ring three and a half hours later',
      press: async (page) => {
        await packLiveBeforeAnyFrame()
        await page.telemetry.readDetailLog()
        page.controller.answerStoredLogWithWholeRing('later')
        await page.telemetry.readDetailLog()
      },
      reaches: (page) => {
        const merge = page.telemetry.ringIngest.value
        // The ring moved under the reader between the two reads, and every figure here is what
        // the fold made of two real bursts rather than arithmetic anyone wrote down.
        expect(merge?.overlap).toBeGreaterThan(0)
        expect(merge?.ringShift).not.toBeNull()
        expect(merge?.appended).toBeGreaterThan(0)
        expect(merge?.gapDeclared).toBe(false)
      },
    },
    {
      control: 'Two windows with nothing in common',
      press: async (page) => {
        await packLiveBeforeAnyFrame()
        page.controller.answerStoredLogWithRingWindow('earlier', 0, 99)
        await page.telemetry.readDetailLog()
        page.controller.answerStoredLogWithRingWindow('later', 700, 808)
        await page.telemetry.readDetailLog()
      },
      reaches: (page) => expect(page.telemetry.ringIngest.value?.gapDeclared).toBe(true),
    },
    {
      control: 'A run too short to place',
      press: async (page) => {
        await packLiveBeforeAnyFrame()
        page.controller.answerStoredLogWithShortRun()
        await page.telemetry.readDetailLog()
      },
      reaches: (page) => expect(page.telemetry.ringIngest.value?.runsDiscarded).toBe(1),
    },
    {
      control: 'The pack ignores the command',
      press: async (page) => {
        await packLiveBeforeAnyFrame()
        page.controller.answerStoredLogWithSilence()
        await page.telemetry.readDetailLog()
      },
      reaches: (page) => expect(page.telemetry.detailLog.value?.outcome).toBe('no-answer'),
    },
    {
      control: 'A burst that arrived in pieces',
      press: async (page) => {
        await packLiveBeforeAnyFrame()
        page.controller.answerStoredLogWithTornBurst()
        await page.telemetry.readDetailLog()
      },
      reaches: (page) => expect(page.telemetry.detailLog.value?.outcome).toBe('torn-burst'),
    },
    {
      control: 'Frames that are not a stored log',
      press: async (page) => {
        await packLiveBeforeAnyFrame()
        page.controller.answerStoredLogWithForeignFrames()
        await page.telemetry.readDetailLog()
      },
      reaches: (page) => expect(page.telemetry.detailLog.value?.outcome).toBe('other-frames'),
    },
    {
      control: 'The read is refused',
      press: async (page) => {
        await packLiveBeforeAnyFrame()
        page.controller.rejectStoredLogRead(new Error('no link to read over'))
        await page.telemetry.readDetailLog()
      },
      reaches: (page) => expect(page.telemetry.detailLogError.value).toBe('no link to read over'),
    },
    {
      control: 'A slow answer',
      press: async (page) => {
        await packLiveBeforeAnyFrame()
        page.controller.holdStoredLogRead(HELD_ATTEMPT_MS)
        void page.telemetry.readDetailLog()
        await page.play(FIRST_FRAMES_MS)
      },
      reaches: (page) => expect(page.telemetry.detailLogReading.value).toBe(true),
    },
  ])
})

describe("the controller's stored history", () => {
  eachControl([
    {
      control: 'A month of days',
      press: async (page) => {
        await page.telemetry.readSolarHistory()
      },
      reaches: (page) => {
        expect(page.telemetry.solarHistory.value?.outcome).toBe('days-read')
        expect(page.telemetry.solarHistoryIngest.value?.totalDays).toBe(
          page.telemetry.solarHistory.value?.days.length,
        )
      },
    },
    {
      control: "Today's record, further along",
      press: async (page) => {
        // Swept twice on purpose. Filing is a comparison, so the first sweep is what puts the days
        // on the ledger the second one is measured against — armed against an empty ledger this
        // answer files today as a first sighting and revises nothing.
        await page.telemetry.readSolarHistory()
        page.controller.answerSweepWithRevisedToday()
        await page.telemetry.readSolarHistory()
      },
      reaches: (page) => {
        const merge = page.telemetry.solarHistoryIngest.value
        const daysSwept = page.telemetry.solarHistory.value?.days.length ?? 0
        expect(daysSwept).toBeGreaterThan(1)
        // One day the ledger already held and whose figures moved, which is the whole of what the
        // sentence about a record still being written is drawn from. Every completed day behind it
        // answers what it answered before, so nothing else can be mistaken for it.
        expect(merge?.revised).toBe(1)
        expect(merge?.appended).toBe(0)
        expect(merge?.unchanged).toBe(daysSwept - 1)
      },
    },
    {
      control: 'The same history, read on a later date',
      press: async (page) => {
        await page.telemetry.readSolarHistory()
        // Past a whole day, so the date every stored row was filed under is yesterday's.
        page.controller.ageClockByHours(25)
        await page.telemetry.readSolarHistory()
      },
      reaches: (page) => {
        const merge = page.telemetry.solarHistoryIngest.value
        const daysSwept = page.telemetry.solarHistory.value?.days.length ?? 0
        expect(daysSwept).toBeGreaterThan(1)
        // Redating is about the clock the sweep was read on and not about its bytes: the same
        // registers a day later are the same days, dated one further back.
        expect(merge?.redated).toBe(daysSwept)
        expect(merge?.unchanged).toBe(daysSwept)
        expect(merge?.revised).toBe(0)
        expect(merge?.appended).toBe(0)
      },
    },
    {
      control: 'A controller just commissioned',
      press: async (page) => {
        page.controller.answerSweepWithUnwrittenDays()
        await page.telemetry.readSolarHistory()
      },
      reaches: (page) => {
        const sweep = page.telemetry.solarHistory.value
        // Every register answered and not one of them holds a day, which is a read that kept
        // nothing rather than a read that got somewhere. A recorded day of zero yield is a
        // different finding, so the two never collapse into one shape.
        expect(sweep?.outcome).toBe('empty-history')
        expect(sweep?.days.length).toBeGreaterThan(0)
        expect(sweep?.days.every((reading) => !reading.day.recorded)).toBe(true)
      },
    },
    {
      control: 'The totals answer and then silence',
      press: async (page) => {
        page.controller.answerSweepWithTotalsOnly()
        await page.telemetry.readSolarHistory()
      },
      reaches: (page) => expect(page.telemetry.solarHistory.value?.outcome).toBe('stalled'),
    },
    {
      control: 'The controller refuses',
      press: async (page) => {
        page.controller.answerSweepWithRefusal()
        await page.telemetry.readSolarHistory()
      },
      reaches: (page) => expect(page.telemetry.solarHistory.value?.outcome).toBe('refused'),
    },
    {
      control: 'The tunnel opens and nothing answers',
      press: async (page) => {
        page.controller.answerSweepWithSilence()
        await page.telemetry.readSolarHistory()
      },
      reaches: (page) => expect(page.telemetry.solarHistory.value?.outcome).toBe('no-answer'),
    },
    {
      control: 'A stream nothing parsed out of',
      press: async (page) => {
        page.controller.answerSweepWithTornStream()
        await page.telemetry.readSolarHistory()
      },
      reaches: (page) => expect(page.telemetry.solarHistory.value?.outcome).toBe('torn-stream'),
    },
    {
      control: 'The tunnel will not open',
      press: async (page) => {
        page.controller.rejectSolarHistorySweep(new Error('the controller refused the connection'))
        await page.telemetry.readSolarHistory()
      },
      reaches: (page) =>
        expect(page.telemetry.solarHistoryError.value).toBe('the controller refused the connection'),
    },
    {
      control: 'A slow sweep',
      press: async (page) => {
        page.controller.holdSolarHistorySweep(HELD_ATTEMPT_MS)
        void page.telemetry.readSolarHistory()
        await page.play(FIRST_FRAMES_MS)
      },
      reaches: (page) => expect(page.telemetry.solarHistoryReading.value).toBe(true),
    },
  ])
})

describe('what the page is looking at', () => {
  /** Records a session and hands back the closed row, which is what the Log would offer. */
  async function recordOneSession(): Promise<void> {
    await telemetry.connectBms()
    await page.play(15_000)
    await telemetry.disconnectBms()
    await telemetry.drain()
  }

  eachControl([
    {
      control: 'Browse a stored session',
      press: async (page) => {
        await recordOneSession()
        const [listing] = await page.store.listSessions()
        page.telemetry.leaveHistory()
        expect(page.telemetry.browseSession(listing.record)).toBe(true)
      },
      reaches: (page) => expect(page.telemetry.source.value).toBe('history'),
    },
    {
      control: 'Leave the archive',
      press: async (page) => {
        await recordOneSession()
        const [listing] = await page.store.listSessions()
        page.telemetry.leaveHistory()
        page.telemetry.browseSession(listing.record)
        page.telemetry.leaveHistory()
      },
      reaches: (page) => expect(page.telemetry.source.value).toBe('none'),
    },
    {
      control: 'Restore the remembered session',
      press: async (page) => {
        await recordOneSession()
        page.telemetry.leaveHistory()
        expect(page.telemetry.restoreRemembered()).toBe(true)
      },
      reaches: (page) => expect(page.telemetry.source.value).toBe('remembered'),
    },
    {
      control: 'Forget the remembered session',
      press: async (page) => {
        await recordOneSession()
        page.telemetry.forgetRemembered()
      },
      reaches: (page) => {
        expect(page.telemetry.rememberedAt.value).toBeNull()
        expect(page.telemetry.source.value).toBe('none')
      },
    },
    {
      control: 'Age the clock',
      press: async (page) => page.controller.ageClockByHours(-30),
      reaches: (page) => {
        const dayAndAQuarterBack = -30 * 60 * 60 * 1000
        expect(page.controller.clockOffsetMs).toBe(dayAndAQuarterBack)
        expect(page.telemetry.recording.value.sessionId).toBeNull()
      },
    },
    {
      control: 'Age the clock while a radio is up',
      press: async (page) => {
        await packLive()
        page.controller.ageClockByHours(-30)
      },
      reaches: (page) => {
        // Refused rather than obeyed: a recorder running against a clock that has just jumped
        // writes rows into the future and the archive keeps them.
        expect(page.controller.clockOffsetMs).toBe(0)
      },
    },
  ])
})

describe('the archive', () => {
  /** What the last control stopped on, caught the way the panel's own handler catches it. */
  let archiveControlFailure: string | null

  beforeEach(() => {
    archiveControlFailure = null
  })

  /** Runs one control the way the panel's own handler runs it, keeping whatever stopped it. */
  async function runArchiveControl(control: Promise<void>): Promise<void> {
    await control.catch((failure: unknown) => {
      archiveControlFailure = failure instanceof Error ? failure.message : String(failure)
    })
  }

  eachControl([
    {
      control: 'A read filed against a failing archive',
      press: async (page) => {
        await packLiveBeforeAnyFrame()
        page.controller.failEveryArchiveCall(true)
        await page.telemetry.readDetailLog()
      },
      reaches: (page) => expect(page.telemetry.detailLogError.value).not.toBeNull(),
    },
    {
      control: 'Seed the archive',
      press: async (page) => await seedFakeArchive(page.store, page.controller.now()),
      reaches: async (page) => {
        const listings = await page.store.listSessions()
        expect(listings.length).toBeGreaterThan(0)
        expect(listings.some((listing) => listing.record.continues !== null)).toBe(true)
        expect(listings.some((listing) => listing.record.retainedFrom !== null)).toBe(true)
      },
    },
    {
      control: 'Seeding twice leaves one copy',
      press: async (page) => {
        await seedFakeArchive(page.store, page.controller.now())
        await seedFakeArchive(page.store, page.controller.now())
      },
      reaches: async (page) => {
        const listings = await page.store.listSessions()
        const ids = new Set(listings.map((listing) => listing.record.id))
        expect(ids.size).toBe(listings.length)
      },
    },
  ])

  /**
   * The archive levers, read off a screen that was already up when they moved.
   *
   * Nothing below reads the store a lever built, and the order matters as much as the subject. A
   * lever swaps the store the page records and reads through, with the setting read into that store
   * when it is built and never afterwards. A page handed one store and never handed another
   * therefore goes on reading the archive it started with, so a store answering exactly what the
   * lever set is no evidence that any reader saw it: that is the shape of an archive reporting
   * itself gone to a Log still listing its sessions.
   *
   * So each row here puts the screen up first and moves the lever underneath it. Mounting afterwards
   * would paint the right sentence either way and prove nothing.
   */
  describe('the levers, under a screen that is already up', () => {
    /** Two checkpoints, so a refused write has been offered and turned away more than once. */
    const WRITES_REFUSED_MS = 2 * CHECKPOINT_INTERVAL_MS

    let mountedScreen: MountedApp | null = null
    let host: HTMLElement
    let stopWiringArchive: (() => void) | null = null

    /**
     * The shell's own wiring, and the resubscription that is the whole point of it: an archive lever
     * mints a store of its own, and a page learns that the archive changed by being handed one.
     */
    function wireArchive(store: HistoryStore): void {
      provideHistoryEnvironment({ store, downloadJson: () => undefined })
    }

    function putOnScreen(view: Component): void {
      host = document.createElement('div')
      document.body.append(host)
      wireArchive(archive)
      stopWiringArchive = controller.onArchiveChange(wireArchive)
      mountedScreen = createApp(view)
      mountedScreen.mount(host)
    }

    afterEach(() => {
      mountedScreen?.unmount()
      mountedScreen = null
      stopWiringArchive?.()
      stopWiringArchive = null
      host.remove()
    })

    /** What the screen says now, wrapping collapsed so the copy reads as one sentence. */
    async function painted(): Promise<string> {
      await vi.advanceTimersByTimeAsync(0)
      await nextTick()
      return (host.textContent ?? '').replace(/\s+/g, ' ').trim()
    }

    describe('the Log', () => {
      beforeEach(() => putOnScreen(LogView))

      eachControl([
        {
          control: 'The browser keeps no archive',
          press: async (page) => page.controller.failArchiveWith('no-indexeddb'),
          reaches: async () => {
            expect(await painted()).toContain('This browser will not keep a log.')
          },
        },
        {
          control: 'Storage refused to open',
          press: async (page) => page.controller.failArchiveWith('open-denied'),
          reaches: async () => {
            // The same screen as no IndexedDB at all, and deliberately: from here they are one
            // fact, which is that this browser refused to keep anything.
            expect(await painted()).toContain('This browser will not keep a log.')
          },
        },
        {
          control: 'An older tab is holding the log open',
          press: async (page) => page.controller.failArchiveWith('open-blocked'),
          reaches: async () => {
            const shown = await painted()
            expect(shown).toContain('Another tab is running an older version of this page')
            // Nothing about this browser refused anything, so the storage sentence would send the
            // reader to settings that have nothing to do with it.
            expect(shown).not.toContain('will not keep a log')
          },
        },
        {
          control: 'A log a newer version wrote',
          press: async (page) => page.controller.failArchiveWith('version-newer'),
          reaches: async () => {
            expect(await painted()).toContain(
              'This browser holds a log recorded by a newer version of this page',
            )
          },
        },
        {
          control: 'The log is full',
          press: async (page) => page.controller.failArchiveWith('quota-exhausted'),
          reaches: async () => {
            expect(await painted()).toContain('The log is full and the archive is not accepting')
          },
        },
        {
          control: 'The archive comes back',
          press: async (page) => {
            page.controller.failArchiveWith('version-newer')
            expect(await painted()).toContain('recorded by a newer version')
            page.controller.failArchiveWith(null)
          },
          reaches: async () => {
            // Both directions, because a screen that only ever goes wrong is a screen nobody can
            // tell apart from one that was wrong to begin with.
            const shown = await painted()
            expect(shown).not.toContain('newer version')
            expect(shown).not.toContain('will not keep a log')
          },
        },
        {
          control: 'Every archive call fails',
          press: async (page) => page.controller.failEveryArchiveCall(true),
          reaches: async () => {
            // There and failing, which is a different screen from a browser that keeps none — and
            // the only route to it, because the store for a browser that keeps none is honest by
            // design and cannot fail a caller that asked it politely.
            const shown = await painted()
            expect(shown).toContain('The archive is set to fail every call.')
            expect(shown).not.toContain('will not keep a log')
          },
        },
      ])
    })

    /**
     * The plate wired as the bus view wires it: this file's own recorder, and the shared read
     * model's answer about the archive.
     */
    function recordingPlateAsTheBusViewMountsIt(): Component {
      const log = useHistoryBrowser()
      return {
        render: () =>
          h(RecordingPlate, {
            state: telemetry.recording.value,
            availability: log.availability.value,
          }),
      }
    }

    describe('the recording plate', () => {
      beforeEach(() => putOnScreen(recordingPlateAsTheBusViewMountsIt()))

      eachControl([
        {
          control: 'The archive turns every row away',
          press: async (page) => {
            await packLive()
            expect(await painted()).toMatch(/RECORDING · /)
            page.controller.refuseArchiveWrites(true)
            await page.play(WRITES_REFUSED_MS)
          },
          reaches: async (page) => {
            // The only shape the recorder reads a failure of its own out of: a write it was allowed
            // to make, which came back saying it was not stored and why.
            expect(page.telemetry.recording.value.failure).toBe('quota-exhausted')
            expect(await painted()).toContain('NOT RECORDING — the log could not be written to.')
          },
        },
        {
          control: 'Every archive call fails',
          press: async (page) => {
            await packLive()
            page.controller.failEveryArchiveCall(true)
            await page.play(WRITES_REFUSED_MS)
          },
          reaches: async (page) => {
            // Why the lever above had to exist. A rejected commit is caught and retried, so the
            // recorder never learns of a failure of its own and the plate goes on counting rows
            // that are not reaching disk.
            expect(page.telemetry.recording.value.failure).toBeNull()
            expect(await painted()).toMatch(/RECORDING · /)
          },
        },
        {
          control: 'The browser keeps no archive',
          press: async (page) => {
            page.controller.failArchiveWith('open-denied')
            await packLive()
          },
          reaches: async (page) => {
            // A store the recorder may not use is a store it never calls, so it opens no session and
            // has no failure of its own to report. The archive's own answer is the plate's only
            // source for this state, and an answer that cannot move is a plate that cannot report
            // it — a live pack recording nothing, under a plate saying neither.
            expect(page.telemetry.recording.value.sessionId).toBeNull()
            expect(await painted()).toContain('NOT RECORDING — this browser will not keep a log.')
          },
        },
        {
          control: 'An older tab is holding the log open',
          press: async (page) => {
            page.controller.failArchiveWith('open-blocked')
            await packLive()
          },
          reaches: async () => {
            // The one unusable archive the owner can do something about from where they are
            // standing, so it gets its own line rather than the general refusal.
            expect(await painted()).toContain(
              'NOT RECORDING — an older version of this page is open in another tab.',
            )
          },
        },
      ])
    })
  })

  /**
   * What a seeded watch says about its own day, painted one row at a time.
   *
   * The row is the whole of what the Log offers about a watch, and one of its sentences is about the
   * shape of the watch rather than about the archive — so it is read off the row rather than off the
   * record the row was built from.
   */
  describe('the seeded rows in the Log', () => {
    /** Eight hours spread across the day, so nothing here depends on when the suite happens to run. */
    const HOURS_ROUND_THE_CLOCK: readonly number[] = [0, 3, 6, 9, 12, 15, 18, 21]

    /** The row's two clipped-band sentences, which a watch has to be shaped to reach. */
    const CLIPPED_UNDER_A_DAY = 'the band shows the part that fits'
    const CLIPPED_OVER_A_DAY = 'longer than a day'

    /** What the seeding put on screen, per hour the control was pressed at. */
    let seededAtEachHour: { readonly hoursOn: number; readonly shown: readonly string[] }[]

    beforeEach(() => {
      seededAtEachHour = []
    })

    /** Every seeded watch, painted the way the Log paints it, against the clock it was seeded on. */
    async function seededRowsAsPainted(page: FakePage): Promise<readonly string[]> {
      await seedFakeArchive(page.store, page.controller.now())
      const listings = await page.store.listSessions()
      const shown: string[] = []

      for (const listing of listings) {
        const rowHost = document.createElement('div')
        document.body.append(rowHost)
        const row = createApp({
          render: () => h(SessionRow, { listing, now: page.controller.now() }),
        })
        row.mount(rowHost)
        await nextTick()
        shown.push((rowHost.textContent ?? '').replace(/\s+/g, ' ').trim())
        row.unmount()
        rowHost.remove()
      }
      return shown
    }

    eachControl([
      {
        control: 'Seed rows playback cannot reach',
        press: async (page) => {
          for (const hoursOn of HOURS_ROUND_THE_CLOCK) {
            page.controller.ageClockByHours(hoursOn)
            seededAtEachHour.push({ hoursOn, shown: await seededRowsAsPainted(page) })
          }
        },
        reaches: () => {
          // A row draws its watch on one local day anchored at noon and clips whatever reaches
          // outside it, so a watch crossing noon and a watch longer than a day are both clipped and
          // each owes the reader a different sentence. Whether the first of them renders at all is
          // otherwise a fact about the hour the control happened to be pressed at, which is why one
          // seeded watch is anchored to noon and why the same seeding is read here at eight of them.
          const shownAtEachHour = seededAtEachHour.map(({ hoursOn, shown }) => ({
            hoursOn,
            fits: shown.some((row) => row.includes(CLIPPED_UNDER_A_DAY)),
            longer: shown.some((row) => row.includes(CLIPPED_OVER_A_DAY)),
          }))

          expect(shownAtEachHour).toEqual(
            HOURS_ROUND_THE_CLOCK.map((hoursOn) => ({ hoursOn, fits: true, longer: true })),
          )
        },
      },
    ])
  })

  /**
   * The rows about the one session a view is holding, rather than about the archive as a whole.
   *
   * A read model of this file's own, built the way the page builds the shared one every screen and
   * the panel read from. What a session says about itself is drawn from these refs, so a row that
   * moves one has moved what is on screen.
   */
  describe('the session on screen', () => {
    let browser: HistoryBrowser
    /** Which session a row opened, so the notice can be checked against it rather than against null. */
    let openedId: SessionId | null

    beforeEach(() => {
      openedId = null
      browser = createHistoryBrowser({
        store: () => archive,
        now: () => controller.now(),
        download: () => undefined,
      })
    })

    afterEach(() => browser.dispose())

    /** The seeded watch that holds no sample, found by the one thing that makes it that watch. */
    async function silentWatchId(): Promise<SessionId> {
      const listings = await store.listSessions()
      const silent = listings.find(
        (listing) => listing.record.packSamples === 0 && listing.record.solarSamples === 0,
      )
      if (silent === undefined) throw new Error('the seeding left no watch holding no samples')
      return silent.record.id
    }

    /** Whatever the Log would offer first, which is the session a view is likeliest to be holding. */
    async function newestSessionId(): Promise<SessionId> {
      const [newest] = await store.listSessions()
      if (newest === undefined) throw new Error('the seeding left no session to open')
      return newest.record.id
    }

    eachControl([
      {
        control: 'A watch that recorded nothing',
        press: async (page) => {
          await seedFakeArchive(page.store, page.controller.now())
          await browser.loadSession(await silentWatchId())
        },
        reaches: () => {
          const held = browser.loaded.value
          expect(held).not.toBeNull()
          // The session view captions itself off the row's own two counters. The recorder opens no
          // session until a frame lands and deletes one that closes under its floor, so nothing
          // playback records can leave a watch behind with these at zero.
          expect(held?.record.packSamples).toBe(0)
          expect(held?.record.solarSamples).toBe(0)
          expect(held?.pack).toEqual([])
          expect(held?.solar).toEqual([])
        },
      },
      {
        control: 'Drop the session on screen',
        press: async (page) => {
          await seedFakeArchive(page.store, page.controller.now())
          openedId = await newestSessionId()
          await browser.loadSession(openedId)
          await runArchiveControl(dropViewedSession(page.store, browser))
        },
        reaches: () => {
          expect(archiveControlFailure).toBeNull()
          // Pruning is held off whatever a tab is reading, so nothing inside one tab takes a
          // session out from under its own view. Only a read that comes back with nothing gets
          // here, which is what the control asks for once the row is gone — and it has to be the
          // session that was open, not merely some read that failed.
          expect(browser.missing.value).toBe(openedId)
          expect(browser.loaded.value).toBeNull()
        },
      },
      {
        control: 'Drop with nothing on screen',
        press: async (page) => {
          await runArchiveControl(dropViewedSession(page.store, browser))
        },
        reaches: () => {
          // Refused out loud. A control that cannot do what its label says has to reach the panel's
          // failure line rather than look like one that did it.
          expect(archiveControlFailure).not.toBeNull()
          expect(archiveControlFailure).toMatch(/Open a stored session first/)
          expect(browser.missing.value).toBeNull()
        },
      },
    ])
  })

  /**
   * The two controls that reach past the archive's own port, and the only rows in this file that
   * need the browser's real database rather than a store standing in for one: the sample counter,
   * which no port method moves without two million rows behind it, and the wipe, which names a
   * database instead of calling one.
   *
   * Off the fake clock the rest of the file plays the recording on. IndexedDB settles each request
   * as a task of its own, and a fake clock turns only when something turns it, so a write nobody is
   * advancing time for never lands. Nothing here plays, so nothing needs the recording's cadence.
   */
  describe('the controls that go around the port', () => {
    /** A build behind this one, holding the archive at the version it knew. */
    const OLDER_SCHEMA_VERSION = DATABASE_VERSION - 1

    /** Far enough back that a stamp taken on the second press could not read as the first. */
    const HOURS_BETWEEN_PRESSES = -30

    /** How many times a control has sent the page round again. */
    let pageReloads: number
    /** What the archive said its own date was the first time it was asked. */
    let bornAt: number | null

    beforeEach(async () => {
      vi.useRealTimers()
      pageReloads = 0
      bornAt = null
      // The wipe ends by reloading, and jsdom answers a navigation by refusing it out loud. Stubbed
      // so that going round again is a fact a row can read rather than a complaint in the output.
      vi.stubGlobal('location', {
        ...window.location,
        reload: () => {
          pageReloads += 1
        },
      })
      await dropEveryArchive()
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    /** A connection of this file's own, opened and upgraded exactly as the control opens it. */
    function openArchiveDirectly(
      archiveName: string,
      version: number = DATABASE_VERSION,
    ): Promise<IDBDatabase> {
      return new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(archiveName, version)
        request.addEventListener('upgradeneeded', (event) => {
          applySchema(request.result, (event as IDBVersionChangeEvent).oldVersion)
        })
        request.addEventListener('success', () => resolve(request.result), { once: true })
        request.addEventListener('error', () => reject(request.error), { once: true })
      })
    }

    /**
     * The archive's counter, read from the row it lives in.
     *
     * Read that way because opening the archive the way the page opens it recomputes the total
     * from every session row on the way in — which is the invariant the control breaks on purpose,
     * so a read through `openHistoryStore` would report the figure it had just erased.
     */
    async function storedTotals(archiveName: string): Promise<HistoryMeta | undefined> {
      const database = await openArchiveDirectly(archiveName)
      try {
        const meta = database.transaction([META], 'readonly').objectStore(META)
        return await requestAsPromise<HistoryMeta | undefined>(meta.get(TOTALS_KEY))
      } finally {
        database.close()
      }
    }

    async function storedArchiveNames(): Promise<readonly string[]> {
      const stored = await indexedDB.databases()
      return stored.flatMap((archive) => (archive.name === undefined ? [] : [archive.name]))
    }

    /** Every archive on this origin, gone, so no row inherits one from the row before it. */
    async function dropEveryArchive(): Promise<void> {
      for (const archiveName of await storedArchiveNames()) {
        await new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(archiveName)
          request.addEventListener('success', () => resolve(), { once: true })
          request.addEventListener('error', () => resolve(), { once: true })
          // A connection a failing row left open is that row's finding. Waiting on it here would
          // hang the next row instead and report the fault against the wrong one.
          request.addEventListener('blocked', () => resolve(), { once: true })
        })
      }
    }

    eachControl([
      {
        control: 'Fill the sample counter',
        press: async (page) => {
          await runArchiveControl(fillSampleCounterToNearCapacity(page.controller.now()))
        },
        reaches: async () => {
          expect(archiveControlFailure).toBeNull()
          const totals = await storedTotals(FAKE_ARCHIVE_NAME)
          // Past the mark pruning aims for, which is what the storage line reads as near the limit,
          // and under the cap that mark is measured against, so the next sealed chunk does not
          // evict every session in the archive on its way back down.
          expect(totals?.totalSamples).toBeGreaterThan(MAX_TOTAL_SAMPLES * PRUNE_TARGET_RATIO)
          expect(totals?.totalSamples).toBeLessThan(MAX_TOTAL_SAMPLES)
        },
      },
      {
        control: 'Filling twice keeps the first date',
        press: async (page) => {
          await runArchiveControl(fillSampleCounterToNearCapacity(page.controller.now()))
          bornAt = (await storedTotals(FAKE_ARCHIVE_NAME))?.createdAt ?? null
          // A day and a quarter between the two presses, so a stamp taken on the second is a
          // different figure by hours rather than by however long the first write took.
          page.controller.ageClockByHours(HOURS_BETWEEN_PRESSES)
          await runArchiveControl(fillSampleCounterToNearCapacity(page.controller.now()))
        },
        reaches: async () => {
          expect(archiveControlFailure).toBeNull()
          expect(bornAt).not.toBeNull()
          // An archive comes into being once. A control that restamped it every time it moved the
          // counter would leave a log claiming to be younger than the sessions inside it.
          expect((await storedTotals(FAKE_ARCHIVE_NAME))?.createdAt).toBe(bornAt)
        },
      },
      {
        control: 'Filling while an older tab holds it',
        press: async (page) => {
          const olderTab = await openArchiveDirectly(FAKE_ARCHIVE_NAME, OLDER_SCHEMA_VERSION)
          try {
            await runArchiveControl(fillSampleCounterToNearCapacity(page.controller.now()))
          } finally {
            olderTab.close()
          }
        },
        reaches: async () => {
          // Named rather than waited on. An open the browser reports as blocked sends neither of
          // the two events a request promise settles on, and this one carries no ceiling to give up
          // under, so the alternative is a button that never comes back and never says why.
          expect(archiveControlFailure).toMatch(/older schema/)
          // Refused before it wrote, so the archive is as the tab holding it left it.
          expect(await storedTotals(FAKE_ARCHIVE_NAME)).toBeUndefined()
        },
      },
      {
        control: 'Wipe the fake archive',
        press: async (page) => {
          // Opened for real, so the wipe runs against the connection the page records through
          // rather than against a name nothing is holding.
          const playbackArchive = await openHistoryStore(FAKE_ARCHIVE_NAME)
          const boatArchive = await openHistoryStore(DATABASE_NAME)
          await seedFakeArchive(boatArchive, page.controller.now())
          boatArchive.close()

          await runArchiveControl(wipeFakeArchive(playbackArchive))
        },
        reaches: async () => {
          expect(archiveControlFailure).toBeNull()
          const archives = await storedArchiveNames()
          expect(archives).not.toContain(FAKE_ARCHIVE_NAME)
          // The one that has to survive. Both names are on this origin and they differ by a
          // suffix, and what sits under the shipping one is a season of the owner's recordings
          // that nothing brings back.
          expect(archives).toContain(DATABASE_NAME)

          const boatArchive = await openHistoryStore(DATABASE_NAME)
          try {
            // Opened again rather than kept: a deleted archive comes straight back empty under the
            // same name, and would be listed above exactly as it is here.
            expect((await boatArchive.listSessions()).length).toBeGreaterThan(0)
          } finally {
            boatArchive.close()
          }
          expect(pageReloads).toBe(1)
        },
      },
    ])
  })
})
