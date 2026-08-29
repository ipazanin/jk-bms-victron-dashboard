// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SESSION_IDLE_TIMEOUT_MS } from '../src/application/history/SessionRecorder'
import {
  PAGE_AWAY_WINDOW_MS,
  REJOIN_RESUME_WINDOW_MS,
  createTelemetry,
} from '../src/application/telemetry'
import type { Telemetry } from '../src/application/telemetry'
import { browserBleEnvironment } from '../src/infrastructure/ble/capabilities'
import { browserThatCanRejoin } from './support/browserThatCanRejoin'
import { manualSchedule } from './support/manualSchedule'
import type { ManualSchedule } from './support/manualSchedule'
import { battery, deviceInfo, solarReading } from './support/samples'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { scriptedPage } from './support/scriptedPage'
import type { ScriptedPage } from './support/scriptedPage'
import { fakeBmsLink, fakeSolarHistoryLink, fakeSolarScan } from './support/fakeRadios'
import type { FakeBmsLink, FakeSolarScan } from './support/fakeRadios'

// The whole application layer with both radios faked and a Map behind the archive, which is the
// only level at which the two streams meeting one timeline can be asserted at all.
//
// Time is the spec's to move, because half of what a session does about a pack that went away is a
// question of how long it has been gone. `timers` is both the clock the app reads and the scheduler
// its waits run on, so advancing it a minute is a minute of boat rather than a minute of suite.

const ADVERTISEMENT_KEY = '0123456789abcdef0123456789abcdef'

/** What the link spends dying before it reports a stall: three strikes of eight seconds. */
const STALL_STRIKES_MS = 24_000

let timers: ManualSchedule
let page: ScriptedPage
let telemetry: Telemetry
let bms: FakeBmsLink
let solar: FakeSolarScan
let store: MemoryHistoryStore
let session = 0

/** Lets the radios and the supervisor finish whatever they queued before the spec looks. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  localStorage.clear()
  timers = manualSchedule(Date.now())
  page = scriptedPage()
  session = 0
  // Named and identified, because a pack this browser could go back to is what makes a drop a gap.
  bms = fakeBmsLink({ deviceId: 'jk-abc', deviceName: 'JK_B2A8S20P' })
  solar = fakeSolarScan()
  store = new MemoryHistoryStore({ now: () => timers.now() })
  telemetry = createTelemetry({
    createBmsLink: bms.create,
    createSolarScan: solar.create,
    createSolarHistoryLink: fakeSolarHistoryLink().create,
    bleEnvironment: browserThatCanRejoin(),
    historyStore: () => store,
    refreshRingLedger: async () => undefined,
    refreshSolarLedger: async () => undefined,
    now: () => timers.now(),
    monotonic: () => timers.now(),
    newId: () => `session-${(session += 1)}`,
    pageActivity: page.activity,
    schedule: timers.schedule,
  })
})

afterEach(async () => {
  telemetry.dispose()
  await telemetry.drain()
  store.close()
  localStorage.clear()
})

describe('two radios feeding one trend', () => {
  it("records the tick's own pv power when the solar reading leads the snapshot", () => {
    // A solar advertisement claims no interval slot of its own — a sample always pairs a pack
    // current with the solar of that same instant — so the snapshot that follows inside the same
    // second is the one that records, carrying THIS tick's PV power rather than a lagging one.
    solar.emitReading(solarReading({ pvPower: 151 }))
    bms.emitSnapshot(battery())

    expect(telemetry.history).toHaveLength(1)
    expect(telemetry.history[0].pvPower).toBe(151)
  })

  it('records house power as a gap when the load is implausible, keeping pv power', () => {
    // The pack is charging at 10 A while the controller delivers only 2 A, so an unmeasured
    // source is on the bus: house = 2 − 10 = −8 A, far past the plausibility floor. The trace is
    // recorded as a hole rather than as a fabricated number, and pvPower stays a real reading.
    solar.emitReading(solarReading({ batteryCurrent: 2, batteryVoltage: 13.6, pvPower: 151 }))
    bms.emitSnapshot(battery({ current: 10, packVoltage: 13.6 }))

    expect(telemetry.history[0].housePower).toBeNull()
    expect(telemetry.history[0].pvPower).toBe(151)
  })
})

describe('what the recorder is told', () => {
  function driveSeconds(count: number, withSolar = false): void {
    for (let index = 0; index < count; index += 1) {
      if (withSolar) solar.emitReading(solarReading())
      bms.emitSnapshot(battery())
      timers.advance(1000)
    }
  }

  it('opens a session on a solar advertisement alone', async () => {
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    solar.emitReading(solarReading())
    await telemetry.drain()

    expect(telemetry.recording.value.sessionId).not.toBeNull()
    expect(telemetry.recording.value.solarSamples).toBe(1)
    expect(await store.listSessions()).toHaveLength(1)
  })

  it('opens nothing when a link goes live and no frame ever arrives', async () => {
    await telemetry.connectBms()
    await telemetry.drain()

    expect(telemetry.bmsState.value).toBe('live')
    expect(telemetry.recording.value.sessionId).toBeNull()
    expect(await store.listSessions()).toHaveLength(0)
  })

  it('records nothing at all while a scan runs with no archive to write to', async () => {
    telemetry.dispose()
    telemetry = createTelemetry({
      createBmsLink: bms.create,
      createSolarScan: solar.create,
      createSolarHistoryLink: fakeSolarHistoryLink().create,
      bleEnvironment: browserBleEnvironment(),
      historyStore: () => null,
      refreshRingLedger: async () => undefined,
      refreshSolarLedger: async () => undefined,
      now: () => timers.now(),
      monotonic: () => timers.now(),
      newId: () => 'session',
      schedule: timers.schedule,
    })

    await telemetry.startSolar(ADVERTISEMENT_KEY)
    solar.emitReading(solarReading())
    await telemetry.drain()

    expect(telemetry.recording.value.sessionId).toBeNull()
  })

  it('keeps one session across a BMS drop while the scan is still up', async () => {
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await telemetry.connectBms()
    driveSeconds(12, true)
    const opened = telemetry.recording.value.sessionId
    expect(opened).not.toBeNull()

    bms.emitDisconnect('dropped')
    solar.emitReading(solarReading())
    timers.advance(1000)
    solar.emitReading(solarReading())
    await telemetry.drain()

    // The pack link went away; the watch did not. Solar rows carry on into the same session.
    expect(telemetry.recording.value.sessionId).toBe(opened)
    expect(await store.listSessions()).toHaveLength(1)
  })

  it('keeps one session when the pack drops with solar idle and comes back inside the window', async () => {
    await telemetry.connectBms()
    driveSeconds(12)
    const opened = telemetry.recording.value.sessionId
    expect(opened).not.toBeNull()

    bms.emitDisconnect('dropped')
    await telemetry.drain()
    // Nothing is up, and the instruments say so — but the recording is being held for the pack.
    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.recording.value.sessionId).toBe(opened)

    timers.advance(30_000)
    await telemetry.connectBms()
    driveSeconds(12)
    await telemetry.disconnectBms()
    await telemetry.drain()

    const sessions = await store.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].record.id).toBe(opened)
    expect(sessions[0].record.endReason).toBe('user-disconnect')
  })

  it('holds the session past the recorder’s own sweep when the pack went quiet', async () => {
    // The two timers over one session count from different instants: the sweep from the last row,
    // the window from the drop. A pack that goes quiet rather than dropping dies for three stall
    // strikes in between, so a rejoin can land inside the window and outside the sweep — and that
    // band is where the supervisor's backoff puts an attempt, not a knife edge.
    await telemetry.connectBms()
    driveSeconds(12)
    const opened = telemetry.recording.value.sessionId

    timers.advance(STALL_STRIKES_MS)
    bms.emitDisconnect('stalled')
    await telemetry.drain()

    // Past the sweep's deadline measured from that last frame, and still inside the window this
    // drop opened.
    timers.advance(SESSION_IDLE_TIMEOUT_MS - 15_000)
    await telemetry.drain()
    expect((await store.listSessions())[0].record.state).toBe('open')

    await telemetry.connectBms()
    driveSeconds(12)
    await telemetry.disconnectBms()
    await telemetry.drain()

    const sessions = await store.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].record.id).toBe(opened)
    expect(sessions[0].record.endReason).toBe('user-disconnect')
  })

  it('closes the held session with what really ended it once the window runs out', async () => {
    await telemetry.connectBms()
    driveSeconds(12)
    bms.emitDisconnect('dropped')
    await telemetry.drain()
    expect((await store.listSessions())[0].record.state).toBe('open')

    timers.advance(REJOIN_RESUME_WINDOW_MS)
    await telemetry.drain()

    const [listing] = await store.listSessions()
    expect(listing.record.state).toBe('closed')
    // Not the 'stalled' the recorder's own idle sweep would have reached for a tick later.
    expect(listing.record.endReason).toBe('link-lost')
  })

  it('ends a held session the moment the owner presses Disconnect during the wait', async () => {
    await telemetry.connectBms()
    driveSeconds(12)
    bms.emitDisconnect('dropped')
    await telemetry.drain()
    expect((await store.listSessions())[0].record.state).toBe('open')

    // Nothing is connected any more, so this is the owner calling off the rejoin rather than
    // hanging up on a link — and the recording ends with it rather than serving out the window.
    await telemetry.disconnectBms()
    await telemetry.drain()

    const [listing] = await store.listSessions()
    expect(listing.record.state).toBe('closed')
    expect(listing.record.endReason).toBe('user-disconnect')
    expect(timers.pending).toBe(0)
  })

  it('leaves the watch standing when Stop solar lands on a pack still being rejoined', async () => {
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await telemetry.connectBms()
    driveSeconds(12, true)
    const opened = telemetry.recording.value.sessionId

    bms.emitDisconnect('dropped')
    solar.emitReading(solarReading())
    timers.advance(20_000)
    await telemetry.drain()

    telemetry.stopSolar()
    await telemetry.drain()

    // The press was about the controller, and it says nothing about the pack the app is still
    // hunting for. Ending the watch here would file the afternoon as two, split at the moment a
    // radio nobody asked about was stopped.
    expect(telemetry.recording.value.sessionId).toBe(opened)
    expect((await store.listSessions())[0].record.state).toBe('open')

    await telemetry.connectBms()
    driveSeconds(12)
    await telemetry.disconnectBms()
    await telemetry.drain()

    const sessions = await store.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].record.id).toBe(opened)
    expect(sessions[0].record.endReason).toBe('user-disconnect')
  })

  it('gives one ending to a pack still being hunted when the page is put away over it', async () => {
    // A window is already standing over this session when the owner looks away, so two causes are
    // counting down on one recording. There is one hold and one ending, and it belongs to whichever
    // cause stopped the last stream that was still feeding it.
    solar.allowResume(true)
    solar.reportsDevice('victron-1', 'SmartSolar HQ22487VZHZ')
    // The pack is out of range for the rest of this watch, so the hunt for it goes on and its
    // window is never closed by a link coming back.
    bms.failEveryReconnectWith(new Error('the pack is out of range'))
    telemetry.startRejoin()
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await telemetry.connectBms()
    driveSeconds(12, true)
    const opened = telemetry.recording.value.sessionId

    bms.emitDisconnect('dropped')
    solar.emitReading(solarReading())
    timers.advance(1000)
    await telemetry.drain()
    expect((await store.listSessions())[0].record.state).toBe('open')

    page.hide()
    await telemetry.drain()
    expect(telemetry.solarState.value).toBe('idle')

    // The pack's own window falls due first and closes nothing: the controller was still writing
    // rows into this session when it ran, and what actually stopped them was the page going away.
    timers.advance(REJOIN_RESUME_WINDOW_MS)
    await telemetry.drain()
    expect((await store.listSessions())[0].record.state).toBe('open')

    timers.advance(PAGE_AWAY_WINDOW_MS)
    await telemetry.drain()

    const sessions = await store.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].record.id).toBe(opened)
    expect(sessions[0].record.endReason).toBe('page-away')
  })

  it('starts a fresh session for a pack that comes back after the window has closed', async () => {
    await telemetry.connectBms()
    driveSeconds(12)
    bms.emitDisconnect('dropped')
    timers.advance(REJOIN_RESUME_WINDOW_MS)
    await telemetry.drain()

    await telemetry.connectBms()
    driveSeconds(12)
    await telemetry.disconnectBms()
    await telemetry.drain()

    expect(await store.listSessions()).toHaveLength(2)
  })

  it('ends the session the moment Disconnect is pressed, with no window to wait out', async () => {
    await telemetry.connectBms()
    driveSeconds(12)

    await telemetry.disconnectBms()
    await telemetry.drain()

    const [listing] = await store.listSessions()
    expect(listing.record.state).toBe('closed')
    expect(listing.record.endReason).toBe('user-disconnect')
    // A deliberate stop is not a gap: nothing is left running that could reopen or re-close it.
    expect(timers.pending).toBe(0)
  })

  it('closes on the drop in a browser that could never rejoin anyway', async () => {
    telemetry.dispose()
    telemetry = createTelemetry({
      createBmsLink: bms.create,
      createSolarScan: solar.create,
      createSolarHistoryLink: fakeSolarHistoryLink().create,
      // No getDevices, so nothing is ever coming back for this pack on its own. Holding the
      // session open would only postpone the same ending by two minutes.
      bleEnvironment: browserBleEnvironment(),
      historyStore: () => store,
      refreshRingLedger: async () => undefined,
      refreshSolarLedger: async () => undefined,
      now: () => timers.now(),
      monotonic: () => timers.now(),
      newId: () => `session-${(session += 1)}`,
      schedule: timers.schedule,
    })

    await telemetry.connectBms()
    driveSeconds(12)
    bms.emitDisconnect('dropped')
    await telemetry.drain()

    const [listing] = await store.listSessions()
    expect(listing.record.state).toBe('closed')
    expect(listing.record.endReason).toBe('link-lost')
  })

  it('checkpoints on a stale controller without ending the session', async () => {
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await telemetry.connectBms()
    driveSeconds(12, true)
    const opened = telemetry.recording.value.sessionId

    solar.emitStale()
    await telemetry.drain()

    expect(telemetry.solarState.value).toBe('listening')
    expect(telemetry.recording.value.sessionId).toBe(opened)
  })

  it('closes with the reason the radios gave', async () => {
    await telemetry.connectBms()
    driveSeconds(12)
    await telemetry.disconnectBms()
    await telemetry.drain()

    const [listing] = await store.listSessions()
    expect(listing.record.state).toBe('closed')
    expect(listing.record.endReason).toBe('user-disconnect')
  })

  it('closes as stalled when the BMS goes quiet rather than dropping', async () => {
    await telemetry.connectBms()
    driveSeconds(12)
    bms.emitDisconnect('stalled')
    // The word the link gave survives the wait the rejoin is given: whichever way the pack went
    // away is what the session is closed with when it does not come back.
    timers.advance(REJOIN_RESUME_WINDOW_MS)
    await telemetry.drain()

    const [listing] = await store.listSessions()
    expect(listing.record.endReason).toBe('stalled')
  })

  it('names the pack from the device-info frame, whenever it arrives', async () => {
    await telemetry.connectBms()
    driveSeconds(12)
    bms.emitDeviceInfo({
      model: 'JK_B2A8S20P',
      hardwareVersion: '19H',
      softwareVersion: '19.10',
      serialNumber: 'DEMO00000000001',
      uptimeSeconds: 4_481_077,
      powerOnCount: 37,
    })
    await telemetry.disconnectBms()
    await telemetry.drain()

    const [listing] = await store.listSessions()
    expect(listing.record.packDeviceKey).toBe('jk:DEMO00000000001')
    expect(listing.label).toBe('JK_B2A8S20P · …0001')
  })
})

describe('what the instruments say while the pack is being hunted', () => {
  it('settles the numbers when Stop solar lands in the middle of the hunt', async () => {
    solar.reportsDevice('victron-1', 'SmartSolar HQ22487VZHZ')
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await telemetry.connectBms()
    for (let index = 0; index < 12; index += 1) {
      solar.emitReading(solarReading())
      bms.emitSnapshot(battery())
      timers.advance(1000)
    }
    telemetry.startRejoin()

    // The pack is out of range for the rest of this watch, so the hunt for it runs on and the
    // window standing over the session is never closed by a link coming back.
    bms.holdReconnectUntilSighted()
    bms.emitDisconnect('dropped')
    await flush()
    expect(telemetry.bmsState.value).toBe('connecting')

    telemetry.stopSolar()

    // Both radios are off the boat: one the owner stopped, one that nothing has found yet. What
    // the archive is holding open is a different question, and the honest answer to this one is
    // the last numbers the pack sent — not a live badge over an empty dashboard.
    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).not.toBeNull()
    expect(telemetry.recording.value.sessionId).not.toBeNull()
  })
})

describe('a chooser that picks a different pack', () => {
  it('leaves the first bank’s session behind rather than folding the second’s rows into it', async () => {
    await telemetry.connectBms()
    bms.emitDeviceInfo(deviceInfo())
    for (let index = 0; index < 12; index += 1) {
      bms.emitSnapshot(battery())
      timers.advance(1000)
    }
    const bankA = telemetry.recording.value.sessionId

    bms.emitDisconnect('dropped')
    await telemetry.drain()
    expect((await store.listSessions())[0].record.state).toBe('open')

    // The owner gives up on the bank that went away and picks the other one out of the chooser.
    timers.advance(5_000)
    bms.becomesAnotherPack('jk-def', 'JK_B2A8S20P')
    await telemetry.connectBms()
    bms.emitSnapshot(battery({ packVoltage: 55.4 }))
    timers.advance(1000)
    bms.emitSnapshot(battery({ packVoltage: 55.4 }))
    // The pack sends its frames in whatever order it likes, so the one that carries the identity
    // is the last thing to notice the swap.
    bms.emitDeviceInfo(deviceInfo({ serialNumber: 'DEMO00000000002' }))
    await telemetry.drain()

    const bankASession = (await store.listSessions()).find((listing) => listing.record.id === bankA)
    expect(bankASession?.record.state).toBe('closed')
    expect(bankASession?.record.endReason).toBe('device-changed')
    // A session is one pack's outing: the rows and the closing figures are the bank that recorded
    // them, and none of the other bank's.
    expect(bankASession?.record.packSamples).toBe(12)
    expect(bankASession?.record.finalBattery?.packVoltage).toBe(battery().packVoltage)
    expect(bankASession?.record.packDeviceKey).toBe('jk:DEMO00000000001')
  })
})
