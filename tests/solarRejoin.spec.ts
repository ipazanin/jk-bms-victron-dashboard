// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SESSION_IDLE_TIMEOUT_MS } from '../src/application/history/SessionRecorder'
import { loadLastController, saveLastController } from '../src/application/lastController'
import { loadRejoinIntent, saveRejoinIntent } from '../src/application/rejoinIntent'
import { saveRememberedSession } from '../src/application/rememberedSession'
import { saveAdvertisementKey } from '../src/application/storage'
import { PAGE_AWAY_WINDOW_MS, createTelemetry } from '../src/application/telemetry'
import type { Telemetry } from '../src/application/telemetry'
import { ReconnectRefusedError } from '../src/infrastructure/ble/ReconnectRefusedError'
import { browserThatCanRejoin } from './support/browserThatCanRejoin'
import { manualSchedule } from './support/manualSchedule'
import type { ManualSchedule } from './support/manualSchedule'
import { rememberedSession, solarReading } from './support/samples'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { scriptedPage } from './support/scriptedPage'
import type { ScriptedPage } from './support/scriptedPage'
import { fakeBmsLink, fakeSolarHistoryLink, fakeSolarScan } from './support/fakeRadios'
import type { FakeSolarScan } from './support/fakeRadios'

// The controller's half of automatic rejoin, at the level where the policy actually lives. The
// radio is faked at the port, so what is under test is the schedule — when a watch is put up, when
// it is handed back, and what the page is allowed to say about a controller that is out of range.
//
// Time and the page are both the spec's, for the same reason they are in reconnect.spec: a real
// window cannot be put behind another one from a test, and nobody should wait out a backoff.

const ADVERTISEMENT_KEY = '0123456789abcdef0123456789abcdef'

let timers: ManualSchedule
let page: ScriptedPage
let telemetry: Telemetry
let solar: FakeSolarScan
let store: MemoryHistoryStore
let session = 0

/**
 * Lets the radio and the supervisor finish whatever they queued before the spec looks.
 *
 * Twice round the queue, because a resume is not over when the watch is up: naming the controller
 * for the archive digests the key, and that is a real crypto call rather than one of this spec's
 * fakes. Until it settles the loop still counts an attempt as in flight and refuses to start
 * another, so one turn is a coin toss on a loaded machine.
 */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 2; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** A browser that has watched this controller before and still holds the key it decodes with. */
function rememberController(): void {
  saveAdvertisementKey(ADVERTISEMENT_KEY)
  saveLastController('victron-1', 'SmartSolar HQ22487VZHZ', 1_700_000_000_000)
}

function spawn(options: { adapterNeverReports?: boolean } = {}): void {
  timers = manualSchedule(Date.now())
  page = scriptedPage()
  session = 0
  solar = fakeSolarScan()
  solar.allowResume(true)
  solar.reportsDevice('victron-1', 'SmartSolar HQ22487VZHZ')
  store = new MemoryHistoryStore({ now: () => timers.now() })
  const browser = browserThatCanRejoin()
  telemetry = createTelemetry({
    createBmsLink: fakeBmsLink({ deviceId: 'jk-abc', deviceName: 'JK_B2A8S20P' }).create,
    createSolarScan: solar.create,
    createSolarHistoryLink: fakeSolarHistoryLink().create,
    // A browser with no `navigator.bluetooth` never reports an adapter at all, which is where the
    // bridge is used — so the tri-state stays unknown rather than turning into a no.
    bleEnvironment: options.adapterNeverReports
      ? { capabilities: browser.capabilities, watchAdapter: () => () => undefined }
      : browser,
    historyStore: () => store,
    refreshRingLedger: async () => undefined,
    refreshSolarLedger: async () => undefined,
    now: () => timers.now(),
    monotonic: () => timers.now(),
    newId: () => `session-${(session += 1)}`,
    pageActivity: page.activity,
    schedule: timers.schedule,
  })
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(async () => {
  telemetry.dispose()
  await telemetry.drain()
  store.close()
  localStorage.clear()
})

describe('putting the controller back on the air without a tap', () => {
  it('resumes the remembered controller on load, raising no chooser', async () => {
    rememberController()
    spawn()

    telemetry.startRejoin()
    await flush()

    expect(solar.resumeCalls).toEqual(['victron-1'])
    expect(telemetry.solarState.value).toBe('listening')
    expect(telemetry.solarRejoinBlocker.value).toBeNull()
  })

  it('holds the remembered numbers on screen until the controller actually speaks', async () => {
    rememberController()
    spawn()
    saveRememberedSession(rememberedSession({ capturedAt: timers.now() }))
    telemetry.restoreRemembered()

    telemetry.startRejoin()
    await flush()

    // The watch is up and the page is still showing what it had. An armed watch says nothing about
    // the controller being in range, and blanking the instruments for it would spend a real reading
    // on a maybe.
    expect(telemetry.solarState.value).toBe('listening')
    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).not.toBeNull()

    solar.emitReading(solarReading())

    expect(telemetry.source.value).toBe('live')
    expect(telemetry.solarState.value).toBe('live')
    expect(telemetry.solar.value?.pvPower).toBe(solarReading().pvPower)
  })

  it('stays put on a browser whose route cannot come up without a press', async () => {
    rememberController()
    spawn()
    solar.allowResume(false)

    telemetry.startRejoin()
    await flush()

    expect(solar.resumeCalls).toEqual([])
    expect(telemetry.solarRejoinBlocker.value).toBe('browser-cannot-rejoin')
    expect(telemetry.solarState.value).toBe('idle')
  })

  it('says so on a browser whose scan can never come back, before it has watched anything', async () => {
    saveAdvertisementKey(ADVERTISEMENT_KEY)
    spawn()
    // The browser's own scan needs its prompt answered on every start and names no device, so this
    // browser will never remember a controller and will never put one back by itself.
    solar.allowResume(false)
    solar.reportsDevice(null)

    telemetry.startRejoin()
    await flush()

    // Gated on the remembered controller first, this browser stood down without a word — leaving
    // the owner with a page that looks like it is waiting for a controller it can never reach.
    expect(solar.resumeCalls).toEqual([])
    expect(telemetry.solarRejoinBlocker.value).toBe('browser-cannot-rejoin')
  })

  it('says nothing on a browser that could come back once it has been shown a controller', async () => {
    saveAdvertisementKey(ADVERTISEMENT_KEY)
    spawn()

    telemetry.startRejoin()
    await flush()

    // Nothing remembered on a route that can resume is a page that has never listened, or an owner
    // who has just pressed Stop solar. Both are standing down on purpose and neither is a fault.
    expect(solar.resumeCalls).toEqual([])
    expect(telemetry.solarRejoinBlocker.value).toBeNull()
  })

  it('says nothing on a route that needs no controller at all, however little is remembered', async () => {
    saveAdvertisementKey(ADVERTISEMENT_KEY)
    spawn()
    // The bridge is a WebSocket: it names no device and needs no permission, so it answers yes to
    // a way back where a browser route would want a controller shown to it first. Nothing here is
    // remembered and no device is reported, which on any other route is the banner's own case.
    solar.allowResume(false)
    solar.resumesWithNoHandle()
    solar.reportsDevice(null)

    telemetry.startRejoin()
    await flush()

    expect(telemetry.solarRejoinBlocker.value).toBeNull()
  })

  it('puts the watch back up on a browser that never says whether the radio is on', async () => {
    rememberController()
    spawn({ adapterNeverReports: true })

    telemetry.startRejoin()
    await flush()

    // Only a plain no is a reason to wait. The bridge runs on a browser that reports no adapter at
    // all, and a gate on a definite yes would leave it silent forever with nothing on screen to say
    // what it was waiting for.
    expect(telemetry.adapterOn.value).toBeNull()
    expect(solar.resumeCalls).toEqual(['victron-1'])
    expect(telemetry.solarState.value).toBe('listening')
  })

  it('stays put with no key stored, and complains about nothing', async () => {
    saveLastController('victron-1', 'SmartSolar HQ22487VZHZ', 1_700_000_000_000)
    spawn()

    telemetry.startRejoin()
    await flush()

    // A browser that has never been given a key has nothing to decode with and nothing to be told.
    expect(solar.resumeCalls).toEqual([])
    expect(telemetry.solarRejoinBlocker.value).toBeNull()
  })

  it('stays put once the owner has said this browser should stop going back to the boat', async () => {
    rememberController()
    saveRejoinIntent(false)
    spawn()

    telemetry.startRejoin()
    await flush()

    expect(solar.resumeCalls).toEqual([])
    expect(telemetry.solarRejoinBlocker.value).toBeNull()
  })
})

describe('what the page being in front has to do with it', () => {
  it('waits for a page that is behind another window, then goes at once when it comes forward', async () => {
    rememberController()
    spawn()
    page.blur()

    telemetry.startRejoin()
    await flush()
    expect(solar.resumeCalls).toEqual([])

    page.focus()
    await flush()

    expect(solar.resumeCalls).toEqual(['victron-1'])
  })

  it('hands the radio back when the page goes away, and puts the watch up again when it returns', async () => {
    rememberController()
    spawn()
    telemetry.startRejoin()
    await flush()
    expect(telemetry.solarState.value).toBe('listening')

    page.hide()

    // Chromium tears the watch down behind a hidden tab whatever we do, and a re-arm loop running
    // into a dead watch is a radio burning for nothing.
    expect(telemetry.solarState.value).toBe('idle')

    page.show()
    await flush()

    // The floor between attempts is what a page raised across two monitors runs into: visibility
    // and focus arrive within a millisecond of each other and the loop paces itself rather than
    // starting a watch for each.
    expect(solar.resumeCalls).toHaveLength(1)
    timers.advance(1_000)
    await flush()

    expect(solar.resumeCalls).toEqual(['victron-1', 'victron-1'])
    expect(telemetry.solarState.value).toBe('listening')
  })

  it('hands back a watch the chooser put up too, which the platform kills either way', async () => {
    saveAdvertisementKey(ADVERTISEMENT_KEY)
    spawn()
    telemetry.startRejoin()
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await flush()

    page.blur()
    expect(telemetry.solarState.value).toBe('idle')

    page.focus()
    timers.advance(1_000)
    await flush()

    expect(solar.resumeCalls).toEqual(['victron-1'])
    expect(telemetry.solarState.value).toBe('listening')
  })

  it('leaves the watch up behind the page once the owner has said stop going back', async () => {
    rememberController()
    spawn()
    telemetry.startRejoin()
    await flush()
    await telemetry.disconnectBms()

    page.blur()

    // Taking it down here would leave a dead solar link and nothing on screen saying why, because
    // nothing would put it back. A watch left standing behind a window is at worst a fiction the
    // platform has already made true.
    expect(telemetry.solarState.value).toBe('listening')
  })

  it('leaves a scan it could not put back running, whatever the page does', async () => {
    saveAdvertisementKey(ADVERTISEMENT_KEY)
    spawn()
    // The browser's own scan needs its permission prompt however many times it has been answered,
    // so taking it down behind another window would cost the owner a press to get it back.
    solar.allowResume(false)
    telemetry.startRejoin()
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await flush()

    page.blur()

    expect(telemetry.solarState.value).toBe('listening')
    expect(solar.resumeCalls).toEqual([])
  })
})

describe('what the recording does while the page is away', () => {
  /** Enough advertisements, a second apart, for the archive to keep the session they open. */
  function driveSolarSeconds(count: number): void {
    for (let index = 0; index < count; index += 1) {
      solar.emitReading(solarReading())
      timers.advance(1_000)
    }
  }

  it('keeps one recording across a page put away and brought back inside the wait', async () => {
    rememberController()
    spawn()
    telemetry.startRejoin()
    await flush()
    driveSolarSeconds(12)
    const opened = telemetry.recording.value.sessionId
    expect(opened).not.toBeNull()

    page.hide()
    expect(telemetry.solarState.value).toBe('idle')

    // Past the recorder's own idle sweep, which is the whole of the defect: the sweep is measured
    // from the last row and would close this one while the owner is still coming back.
    timers.advance(SESSION_IDLE_TIMEOUT_MS + 10_000)
    await telemetry.drain()
    expect((await store.listSessions())[0].record.state).toBe('open')

    page.show()
    await flush()
    driveSolarSeconds(3)
    await telemetry.drain()

    // One afternoon, one watch: the owner looked away and looked back, and the boat never moved.
    const sessions = await store.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].record.id).toBe(opened)
    expect(telemetry.recording.value.sessionId).toBe(opened)
  })

  it('ends the recording in the page’s own words once the wait runs out', async () => {
    rememberController()
    spawn()
    telemetry.startRejoin()
    await flush()
    driveSolarSeconds(12)

    page.hide()
    timers.advance(PAGE_AWAY_WINDOW_MS)
    await telemetry.drain()

    const [listing] = await store.listSessions()
    expect(listing.record.state).toBe('closed')
    // Not 'stalled'. The controller did not go quiet — the app handed its radio back, because the
    // owner was looking at something else.
    expect(listing.record.endReason).toBe('page-away')
    expect(listing.record.entries.at(-1)?.text).toBe('Session ends — the page was put away')
  })

  it('claims no live instruments over a radio it has handed back', async () => {
    rememberController()
    spawn()
    telemetry.startRejoin()
    await flush()
    driveSolarSeconds(12)
    expect(telemetry.source.value).toBe('live')

    page.hide()

    // The recording stands open and the view does not: what the archive is holding and what the
    // numbers on screen are are different questions, and no radio is up to answer the second.
    expect(telemetry.source.value).not.toBe('live')
    expect(telemetry.recording.value.sessionId).not.toBeNull()
  })

  it('ends the wait five minutes after the owner first looked away, however often they click back', async () => {
    rememberController()
    spawn()
    telemetry.startRejoin()
    await flush()
    driveSolarSeconds(12)

    // Blur and focus rather than hide and show: Chromium tears every advertisement watch down when
    // the window merely loses focus, so clicking into another window and back is the ordinary desk
    // case. The controller is asleep, so not a single row arrives through the watches this puts
    // back up, and the recording is exactly as empty as the gap.
    for (let click = 0; click < 8; click += 1) {
      page.blur()
      timers.advance(15_000)
      page.focus()
      await flush()
      timers.advance(15_000)
    }
    page.blur()
    timers.advance(70_000)
    await telemetry.drain()

    // Five minutes measured from the first blur and not from the latest one. A window put back up
    // from zero on every click is one the owner holds open for ever with nothing being written,
    // and the row underneath goes stale enough for another tab to close it 'abandoned' underneath
    // the tab still holding it.
    const [listing] = await store.listSessions()
    expect(listing.record.state).toBe('closed')
    expect(listing.record.endReason).toBe('page-away')
  })
})

describe('what a watch that tore itself down leaves behind', () => {
  it('stops calling a frozen reading live, and lets the loop put the watch back', async () => {
    rememberController()
    spawn()
    telemetry.startRejoin()
    await flush()
    solar.emitReading(solarReading())
    expect(telemetry.solarState.value).toBe('live')

    // A re-arm the radio refused. The transport takes the whole scan down with it — the staleness
    // clock that would otherwise demote this reading goes too — and has nothing but onError to say
    // so.
    solar.reportsWatchTornDown(new Error('the radio would not re-arm'))
    await flush()

    expect(telemetry.solarState.value).toBe('idle')
    expect(telemetry.solar.value).toBeNull()
    expect(telemetry.solarError.value).toBe('the radio would not re-arm')

    // And the loop is free again: while the page claimed a watch was up, it read the radio as
    // somebody else's and would have gone on saying so all afternoon.
    timers.advance(1_000)
    await flush()

    expect(solar.resumeCalls).toEqual(['victron-1', 'victron-1'])
    expect(telemetry.solarState.value).toBe('listening')
    // The banner told the owner to press Connect solar. The loop has just done that for them, so
    // leaving it standing would have the page asking for a fix it has already made.
    expect(telemetry.solarError.value).toBeNull()
  })

  it('leaves a scan that is still up alone, whatever it complains about', async () => {
    rememberController()
    spawn()
    telemetry.startRejoin()
    await flush()
    solar.emitReading(solarReading())

    solar.emitError(new Error('an advertisement would not decode'))
    await flush()

    // An advertisement that would not decode is not a radio that has gone. The watch is still up,
    // and the staleness clock is still the thing that decides when this reading stops being true.
    expect(telemetry.solarState.value).toBe('live')
    expect(telemetry.solar.value).not.toBeNull()
    expect(telemetry.solarError.value).toBe('an advertisement would not decode')
  })
})

describe('what a resume that fails costs', () => {
  it('keeps trying on a lengthening wait, and says nothing about it', async () => {
    rememberController()
    spawn()
    solar.failResumeWith(new Error('the radio would not start'))

    telemetry.startRejoin()
    await flush()
    timers.advance(1_000)
    await flush()
    timers.advance(2_000)
    await flush()

    expect(solar.resumeCalls).toEqual(['victron-1', 'victron-1', 'victron-1'])
    expect(timers.delaysAsked).toEqual([1_000, 2_000, 4_000])
    // A controller behind a bulkhead or asleep at sunset is the ordinary case on a boat, and the
    // answer to it is to keep listening rather than to interrupt the owner.
    expect(telemetry.solarError.value).toBeNull()
    expect(telemetry.solarRejoinBlocker.value).toBeNull()
    expect(telemetry.solarRejoinSearching.value).toBe(true)
  })

  it('goes back to the first wait when the page comes forward, rather than serving out a long one', async () => {
    rememberController()
    spawn()
    solar.failResumeWith(new Error('the radio would not start'))

    telemetry.startRejoin()
    await flush()
    timers.advance(1_000)
    await flush()
    timers.advance(2_000)
    await flush()
    expect(timers.delaysAsked).toEqual([1_000, 2_000, 4_000])

    // The owner goes away and comes back. Chromium killed every watch on the way out and puts
    // none of them back, so the eight-second wait the ladder had climbed to is about a world that
    // no longer exists — and it is the owner who is looking at the page now.
    page.blur()
    page.focus()
    await flush()

    // The floor between attempts, which is this loop pacing a burst of platform events rather than
    // a backoff it has any reason to still be serving.
    expect(timers.delaysAsked.at(-1)).toBe(1_000)

    solar.failResumeWith(null)
    timers.advance(1_000)
    await flush()

    expect(solar.resumeCalls).toHaveLength(4)
    expect(telemetry.solarState.value).toBe('listening')
  })

  it('claims no watch when Stop solar landed while the radio was still coming up', async () => {
    rememberController()
    spawn()
    const settleResume = solar.parkNextResume()

    telemetry.startRejoin()
    await flush()
    expect(telemetry.solarState.value).toBe('connecting')

    telemetry.stopSolar()
    settleResume()
    await flush()

    // The press already put the state back and the transport already unwound the watch under it.
    // A resume resolving afterwards is about a watch nobody has.
    expect(telemetry.solarState.value).toBe('idle')
  })

  it('goes back to listening on its own after a press that the radio refused', async () => {
    rememberController()
    spawn()
    solar.failResumeWith(new Error('the radio would not start'))

    telemetry.startRejoin()
    await flush()
    expect(solar.resumeCalls).toEqual(['victron-1'])

    // The owner presses Connect solar while the loop is waiting out that failure, and the retry
    // falls due with the press still in the middle of raising its prompt.
    solar.failStartWith(new Error('the radio would not start'))
    const pressing = telemetry.startSolar(ADVERTISEMENT_KEY)
    timers.advance(1_000)
    await pressing
    expect(telemetry.solarState.value).toBe('idle')
    expect(solar.resumeCalls).toEqual(['victron-1'])

    // The press is over and the radio is free again. Nothing tells the loop so, because nothing
    // owes it that — a loop that parked on the busy watch would be done for the rest of the
    // session, on a page the owner never leaves.
    solar.failResumeWith(null)
    timers.advance(1_000)
    await flush()

    expect(solar.resumeCalls).toEqual(['victron-1', 'victron-1'])
    expect(telemetry.solarState.value).toBe('listening')
  })

  it('stops for good on a permission the owner has to answer, and reports it as state', async () => {
    rememberController()
    spawn()
    solar.failResumeWith(
      new ReconnectRefusedError('permission-gone', 'This browser no longer has permission.'),
    )

    telemetry.startRejoin()
    await flush()
    timers.advance(60_000)
    await flush()

    // One attempt and no ladder: waiting cannot put a revoked grant back, and only a chooser tap can.
    expect(solar.resumeCalls).toEqual(['victron-1'])
    expect(telemetry.solarRejoinBlocker.value).toBe('permission-gone')
    expect(telemetry.solarRejoinSearching.value).toBe(false)
    expect(telemetry.solarError.value).toBeNull()
  })
})

describe('what the page claims while a controller is being heard', () => {
  it('stops saying the permission is gone once Connect solar has answered it', async () => {
    rememberController()
    spawn()
    solar.failResumeWith(
      new ReconnectRefusedError('permission-gone', 'This browser no longer has permission.'),
    )

    telemetry.startRejoin()
    await flush()
    expect(telemetry.solarRejoinBlocker.value).toBe('permission-gone')

    // The owner does the one thing the refusal asked for. Only an attempt ever takes this claim
    // back, and a press runs none — so the page would go on saying the controller cannot be
    // reached while its readings were arriving.
    solar.failResumeWith(null)
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await flush()

    expect(telemetry.solarState.value).toBe('listening')
    expect(telemetry.solarRejoinBlocker.value).toBeNull()
  })
})

describe('what the two solar buttons mean', () => {
  it('remembers the controller the chooser handed back', async () => {
    saveAdvertisementKey(ADVERTISEMENT_KEY)
    spawn()

    await telemetry.startSolar(ADVERTISEMENT_KEY)

    expect(telemetry.lastController.value).toEqual({
      id: 'victron-1',
      name: 'SmartSolar HQ22487VZHZ',
      at: timers.now(),
    })
    expect(loadLastController()?.id).toBe('victron-1')
    expect(telemetry.rejoinControllerName.value).toBe('SmartSolar HQ22487VZHZ')
  })

  it('forgets the controller on Stop solar, so the press is not undone a second later', async () => {
    saveAdvertisementKey(ADVERTISEMENT_KEY)
    spawn()
    telemetry.startRejoin()
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await flush()

    telemetry.stopSolar()
    timers.advance(60_000)
    await flush()

    expect(telemetry.lastController.value).toBeNull()
    expect(loadLastController()).toBeNull()
    expect(solar.resumeCalls).toEqual([])
    expect(telemetry.solarState.value).toBe('idle')
  })

  it('honours Stop solar on a route that needs no controller to come back', async () => {
    saveAdvertisementKey(ADVERTISEMENT_KEY)
    spawn()
    // The bridge is a plain WebSocket: it can come up again with no gesture and no permission, and
    // it names no controller for the page to remember. Nothing to forget must not read as nothing
    // standing in the way — otherwise Stop solar is undone within a second of being pressed.
    solar.resumesWithNoHandle()
    solar.reportsDevice(null)
    telemetry.startRejoin()
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await flush()

    telemetry.stopSolar()
    timers.advance(60_000)
    await flush()

    expect(solar.resumeCalls).toEqual([])
    expect(telemetry.solarState.value).toBe('idle')
  })

  it('turns going back to the boat on again, which is what the panel promises it does', async () => {
    rememberController()
    spawn()
    telemetry.startRejoin()
    await flush()
    await telemetry.disconnectBms()
    expect(telemetry.rejoinArmed.value).toBe(false)

    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await flush()

    // One intent covers both radios, so Connect solar is the undo for Disconnect exactly as
    // Connect and Reconnect are — and the page says as much next to this very button.
    expect(telemetry.rejoinArmed.value).toBe(true)
    expect(loadRejoinIntent()).toBe(true)

    // Which has to mean something: the watch this press put up is one the page takes down when the
    // owner looks away and puts back when they return.
    page.blur()
    expect(telemetry.solarState.value).toBe('idle')

    page.focus()
    timers.advance(1_000)
    await flush()

    expect(telemetry.solarState.value).toBe('listening')
  })

  it('goes back to the controller again once Connect solar has been pressed afresh', async () => {
    saveAdvertisementKey(ADVERTISEMENT_KEY)
    spawn()
    telemetry.startRejoin()
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    telemetry.stopSolar()

    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await flush()
    page.hide()
    page.show()
    timers.advance(1_000)
    await flush()

    expect(telemetry.lastController.value?.id).toBe('victron-1')
    expect(solar.resumeCalls).toEqual(['victron-1'])
  })
})
