// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import type { App as MountedApp, Component } from 'vue'

import { MOSFET_CRITICAL } from '../src/application/severity'
import { loadAdvertisementKey } from '../src/application/storage'
import { REJOIN_RESUME_WINDOW_MS, createTelemetry } from '../src/application/telemetry'
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
  seedFakeArchive,
  wipeFakeArchive,
} from '../src/components/dev/seedFakeArchive'
import type { SessionId } from '../src/domain/history/types'
import { FakeRadioController } from '../src/infrastructure/ble/fake/FakeRadioController'
import { loadPlaybackFixture } from '../src/infrastructure/ble/fake/fixture/loadPlaybackFixture'
import { FAKE_ARCHIVE_NAME } from '../src/infrastructure/history/fakeArchiveName'
import {
  DATABASE_NAME,
} from '../src/infrastructure/history/IdbHistoryStore'
import { openHistoryStore } from '../src/infrastructure/history/openHistoryStore'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'

const fixture = await loadPlaybackFixture()

const FIRST_FRAMES_MS = 4000

const HELD_ATTEMPT_MS = 8000

const BUS_DISAGREEMENT_V = 0.5

const HOUSE_LOAD_OFFSET_A = 20

const LOOSE_JOINT_MILLIOHMS = 8

const ADDED_JOINT_MILLIOHMS = 4
const MILLIOHMS_PER_OHM = 1000

const BALANCE_FIT_MS = 20_000

const CONTROLLER_MODEL_ID = 0xa060

interface FakePage {
  readonly controller: FakeRadioController
  readonly telemetry: Telemetry

  readonly store: MemoryHistoryStore

  reload(): Promise<void>

  play(forMs: number): Promise<void>
}

interface DevControl {
  readonly control: string

  readonly press: (page: FakePage) => Promise<void>

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
    pageActivity: controller.pageActivity,
    historyStore: () => archive,
    refreshRingLedger: async () => undefined,
    refreshSolarLedger: async () => undefined,
    now: () => controller.now(),
    monotonic: () => controller.now(),
    newId: () => `session-${(sessions += 1)}`,
  }
}

async function load(): Promise<void> {
  controller = new FakeRadioController(loadPlaybackFixture())

  await controller.whenReady()
  archive = controller.archiveFor(store)

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
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true })
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

async function bothLive(): Promise<void> {
  await telemetry.connectBms()
  await telemetry.startSolar(loadAdvertisementKey())
  await page.play(FIRST_FRAMES_MS)
}

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
        expect(page.telemetry.bmsError.value).toMatch(/Lost the BMS/)
        await page.play(REJOIN_RESUME_WINDOW_MS)
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

describe('going back to the pack on its own', () => {
  const answeredFocus = document.hasFocus.bind(document)

  beforeEach(() => {
    document.hasFocus = () => true
  })

  afterEach(() => {
    document.hasFocus = answeredFocus
  })

  async function rememberThePack(page: FakePage): Promise<void> {
    page.controller.seedLastDevice()
    await page.reload()
  }

  eachControl([
    {
      control: 'Reconnect now',
      press: async (page) => {
        await rememberThePack(page)
        await page.telemetry.connectBms()

        await page.telemetry.disconnectBms()
        page.telemetry.startRejoin()
        await page.play(FIRST_FRAMES_MS)
        page.telemetry.rejoinNow()
        await page.play(FIRST_FRAMES_MS)
      },
      reaches: (page) => {
        expect(page.telemetry.rejoinArmed.value).toBe(true)
        expect(page.telemetry.bmsState.value).toBe('live')
      },
    },
    {
      control: 'Disconnect — and stop looking',
      press: async (page) => {
        await rememberThePack(page)
        await page.telemetry.connectBms()
        await page.telemetry.disconnectBms()
        page.telemetry.startRejoin()
        await page.play(FIRST_FRAMES_MS)
      },
      reaches: (page) => {
        expect(page.telemetry.rejoinArmed.value).toBe(false)
        expect(page.telemetry.bmsState.value).toBe('idle')
        expect(page.telemetry.rejoinSearching.value).toBe(false)
      },
    },
    {
      control: 'The pack is out of range',
      press: async (page) => {
        await rememberThePack(page)
        page.controller.setPackInRange(false)
        page.telemetry.startRejoin()
        await page.play(FIRST_FRAMES_MS)
      },
      reaches: (page) => {
        expect(page.telemetry.rejoinSearching.value).toBe(true)
        expect(page.telemetry.bmsState.value).toBe('connecting')
        expect(page.telemetry.bmsError.value).toBeNull()
      },
    },
    {
      control: 'The pack is back in range',
      press: async (page) => {
        await rememberThePack(page)
        page.controller.setPackInRange(false)
        page.telemetry.startRejoin()
        await page.play(FIRST_FRAMES_MS)
        page.controller.setPackInRange(true)
        await page.play(FIRST_FRAMES_MS)
      },
      reaches: (page) => {
        expect(page.telemetry.bmsState.value).toBe('live')
        expect(page.telemetry.rejoinSearching.value).toBe(false)
      },
    },
    {
      control: 'The tab is showing — unticked',
      press: async (page) => {
        await rememberThePack(page)
        page.controller.setPackInRange(false)
        page.telemetry.startRejoin()
        await page.play(FIRST_FRAMES_MS)
        page.controller.showPage(false)
        await page.play(FIRST_FRAMES_MS)
      },
      reaches: (page) => {
        expect(page.telemetry.rejoinSearching.value).toBe(true)
        expect(page.telemetry.bmsState.value).toBe('idle')
      },
    },
    {
      control: 'The window holds focus — unticked',
      press: async (page) => {
        await rememberThePack(page)
        page.controller.setPackInRange(false)
        page.telemetry.startRejoin()
        await page.play(FIRST_FRAMES_MS)
        page.controller.focusPage(false)
        await page.play(FIRST_FRAMES_MS)
      },
      reaches: (page) => {
        expect(page.telemetry.rejoinSearching.value).toBe(true)
        expect(page.telemetry.bmsState.value).toBe('idle')
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
        expect(page.telemetry.solarState.value).toBe('listening')
        expect(page.telemetry.solar.value).toBeNull()
      },
    },
    {
      control: 'A key the controller has reissued',
      press: async (page) => page.controller.emitUnreadable('key-mismatch', 'this-controller'),
      reaches: (page) => {
        expect(page.telemetry.solarRejection.value).toBe('key-mismatch')
        expect(page.telemetry.solarRejectionSource.value).toBe('this-controller')
      },
    },
    {
      control: 'Instant Readout switched off',
      press: async (page) => page.controller.emitUnreadable('not-instant-readout', 'this-controller'),
      reaches: (page) => expect(page.telemetry.solarRejection.value).toBe('not-instant-readout'),
    },
    {
      control: 'Another kind of Victron product',
      press: async (page) => page.controller.emitUnreadable('other-record', 'this-controller'),
      reaches: (page) => expect(page.telemetry.solarRejection.value).toBe('other-record'),
    },
    {
      control: 'The marina is what is being heard',
      press: async (page) => page.controller.emitUnreadable('key-mismatch', 'anything-in-range'),
      reaches: (page) => {
        expect(page.telemetry.solarRejection.value).toBe('key-mismatch')
        expect(page.telemetry.solarRejectionSource.value).toBe('anything-in-range')
      },
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

        await page.reload()
        page.controller.playScenario('discharge')
        page.controller.setCellPathResistanceMilliohms(ADDED_JOINT_MILLIOHMS)
        await page.telemetry.connectBms()
        await page.play(BALANCE_FIT_MS)
        jointSpreadWithTheStep = fittedJointSpread()
      },
      reaches: () => {
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
  async function watchedAcrossADay(page: FakePage): Promise<void> {
    page.telemetry.startRejoin()
    await solarLive()
    await page.play(FIRST_FRAMES_MS)

    page.telemetry.stopSolar()
    await page.telemetry.drain()
    page.controller.ageClockByHours(25)

    await solarLive()
    await page.play(FIRST_FRAMES_MS)
  }

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
        await page.telemetry.readSolarHistory()
        page.controller.answerSweepWithRevisedToday()
        await page.telemetry.readSolarHistory()
      },
      reaches: (page) => {
        const merge = page.telemetry.solarHistoryIngest.value
        const daysSwept = page.telemetry.solarHistory.value?.days.length ?? 0
        expect(daysSwept).toBeGreaterThan(1)

        expect(merge?.revised).toBe(1)
        expect(merge?.appended).toBe(0)
        expect(merge?.unchanged).toBe(daysSwept - 1)
      },
    },
    {
      control: 'The same history, read on a later date',
      press: async (page) => {
        await page.telemetry.readSolarHistory()

        page.controller.ageClockByHours(25)
        await page.telemetry.readSolarHistory()
      },
      reaches: (page) => {
        const merge = page.telemetry.solarHistoryIngest.value
        const daysSwept = page.telemetry.solarHistory.value?.days.length ?? 0
        expect(daysSwept).toBeGreaterThan(1)

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
    {
      control: 'A day since the last sweep, with nobody pressing anything',
      press: async (page) => {
        await watchedAcrossADay(page)
      },
      reaches: (page) => {
        expect(page.controller.lastSolarSweepRoute).toBe('remembered')
        expect(page.controller.lastRememberedSolarController).toBe(
          page.telemetry.lastController.value?.id,
        )

        const merge = page.telemetry.solarHistoryIngest.value
        const daysSwept = page.telemetry.solarHistory.value?.days.length ?? 0
        expect(daysSwept).toBeGreaterThan(1)
        expect(merge?.redated).toBe(daysSwept)
        expect(merge?.appended).toBe(0)

        expect(page.telemetry.solarState.value).toBe('live')
      },
    },
    {
      control: 'This browser has forgotten the controller',
      press: async (page) => {
        page.controller.forgetSolarControllerPermission(true)
        await watchedAcrossADay(page)
      },
      reaches: (page) => {
        expect(page.telemetry.solarHistoryError.value).toMatch(/no longer has permission/)
        expect(page.telemetry.solarHistory.value).toBeNull()
        expect(page.telemetry.solarHistoryIngest.value).toBeNull()
        expect(page.controller.lastSolarSweepRoute).toBeNull()

        expect(page.telemetry.solarState.value).toBe('live')
        expect(page.telemetry.solar.value).not.toBeNull()
      },
    },
  ])
})

describe('what the page is looking at', () => {
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
        expect(page.controller.clockOffsetMs).toBe(0)
      },
    },
  ])
})

describe('the archive', () => {
  let archiveControlFailure: string | null

  beforeEach(() => {
    archiveControlFailure = null
  })

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

  describe('the levers, under a screen that is already up', () => {
    const WRITES_REFUSED_MS = 2 * CHECKPOINT_INTERVAL_MS

    let mountedScreen: MountedApp | null = null
    let host: HTMLElement
    let stopWiringArchive: (() => void) | null = null

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
            expect(await painted()).toContain('This browser will not keep a log.')
          },
        },
        {
          control: 'An older tab is holding the log open',
          press: async (page) => page.controller.failArchiveWith('open-blocked'),
          reaches: async () => {
            const shown = await painted()
            expect(shown).toContain('Another tab is running an older version of this page')

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
            const shown = await painted()
            expect(shown).not.toContain('newer version')
            expect(shown).not.toContain('will not keep a log')
          },
        },
        {
          control: 'Every archive call fails',
          press: async (page) => page.controller.failEveryArchiveCall(true),
          reaches: async () => {
            const shown = await painted()
            expect(shown).toContain('The archive is set to fail every call.')
            expect(shown).not.toContain('will not keep a log')
          },
        },
      ])
    })

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
            expect(await painted()).toContain(
              'NOT RECORDING — an older version of this page is open in another tab.',
            )
          },
        },
      ])
    })
  })

  describe('the seeded rows in the Log', () => {
    const HOURS_ROUND_THE_CLOCK: readonly number[] = [0, 3, 6, 9, 12, 15, 18, 21]

    const CLIPPED_UNDER_A_DAY = 'the band shows the part that fits'
    const CLIPPED_OVER_A_DAY = 'longer than a day'

    let seededAtEachHour: { readonly hoursOn: number; readonly shown: readonly string[] }[]

    beforeEach(() => {
      seededAtEachHour = []
    })

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

  describe('the session on screen', () => {
    let browser: HistoryBrowser

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

    async function silentWatchId(): Promise<SessionId> {
      const listings = await store.listSessions()
      const silent = listings.find(
        (listing) => listing.record.packSamples === 0 && listing.record.solarSamples === 0,
      )
      if (silent === undefined) throw new Error('the seeding left no watch holding no samples')
      return silent.record.id
    }

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
          expect(archiveControlFailure).not.toBeNull()
          expect(archiveControlFailure).toMatch(/Open a stored session first/)
          expect(browser.missing.value).toBeNull()
        },
      },
    ])
  })

  describe('the controls that go around the port', () => {

    let pageReloads: number

    beforeEach(async () => {
      vi.useRealTimers()
      pageReloads = 0

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

    async function storedArchiveNames(): Promise<readonly string[]> {
      const stored = await indexedDB.databases()
      return stored.flatMap((archive) => (archive.name === undefined ? [] : [archive.name]))
    }

    async function dropEveryArchive(): Promise<void> {
      for (const archiveName of await storedArchiveNames()) {
        await new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(archiveName)
          request.addEventListener('success', () => resolve(), { once: true })
          request.addEventListener('error', () => resolve(), { once: true })

          request.addEventListener('blocked', () => resolve(), { once: true })
        })
      }
    }

    eachControl([
      {
        control: 'Wipe the fake archive',
        press: async (page) => {
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

          expect(archives).toContain(DATABASE_NAME)

          const boatArchive = await openHistoryStore(DATABASE_NAME)
          try {
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
