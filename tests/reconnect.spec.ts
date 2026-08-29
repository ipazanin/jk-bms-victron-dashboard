// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadLastDevice, saveLastDevice } from '../src/application/lastDevice'
import { loadRejoinIntent, saveRejoinIntent } from '../src/application/rejoinIntent'
import { saveRememberedSession } from '../src/application/rememberedSession'
import { createTelemetry } from '../src/application/telemetry'
import type { Telemetry } from '../src/application/telemetry'
import { ReconnectRefusedError } from '../src/infrastructure/ble/ReconnectRefusedError'
import { browserThatCanRejoin } from './support/browserThatCanRejoin'
import { battery, rememberedSession } from './support/samples'
import { manualSchedule } from './support/manualSchedule'
import type { ManualSchedule } from './support/manualSchedule'
import { scriptedPage } from './support/scriptedPage'
import type { ScriptedPage } from './support/scriptedPage'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { fakeBmsLink, fakeSolarHistoryLink, fakeSolarScan } from './support/fakeRadios'
import type { FakeBmsLink } from './support/fakeRadios'

let clock = 0
let ids = 0
const cleanups: Array<() => Promise<void>> = []

/** Lets everything the radios and the supervisor have queued run before the spec looks. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function spawn(options: { deviceId?: string | null; deviceName?: string | null } = {}): {
  telemetry: Telemetry
  bms: FakeBmsLink
  timers: ManualSchedule
  store: MemoryHistoryStore
  page: ScriptedPage
} {
  const bms = fakeBmsLink({ deviceId: options.deviceId ?? 'jk-abc', deviceName: options.deviceName ?? 'JK_B2A8S20P' })
  const solar = fakeSolarScan()
  const store = new MemoryHistoryStore({ now: () => clock })
  // Started at the wall clock the rest of the spec asserts against, and moved only by a spec that
  // means to move it: the supervisor paces itself against the same clock its timers run on, so the
  // two cannot be allowed to disagree.
  const timers = manualSchedule(clock)
  const page = scriptedPage()
  const telemetry = createTelemetry({
    createBmsLink: bms.create,
    createSolarScan: solar.create,
    createSolarHistoryLink: fakeSolarHistoryLink().create,
    bleEnvironment: browserThatCanRejoin(),
    historyStore: () => store,
    refreshRingLedger: async () => undefined,
    refreshSolarLedger: async () => undefined,
    now: () => timers.now(),
    monotonic: () => timers.now(),
    newId: () => `session-${(ids += 1)}`,
    // The page is in front and the clock is the spec's, so an automatic rejoin runs exactly when
    // it is told to rather than whenever the machine running the suite gets round to it — and a
    // spec that needs the owner working elsewhere puts the window behind something by hand.
    pageActivity: page.activity,
    schedule: timers.schedule,
  })
  cleanups.push(async () => {
    telemetry.dispose()
    await telemetry.drain()
    store.close()
  })
  return { telemetry, bms, timers, store, page }
}

beforeEach(() => {
  localStorage.clear()
  clock = Date.now()
  ids = 0
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  localStorage.clear()
})

describe('remembering the pack', () => {
  it('persists the pack id and name on a successful connect', async () => {
    const { telemetry } = spawn()
    expect(telemetry.lastDevice.value).toBeNull()

    await telemetry.connectBms()

    expect(telemetry.lastDevice.value).toEqual({ id: 'jk-abc', name: 'JK_B2A8S20P', at: clock })
    expect(loadLastDevice()).toEqual({ id: 'jk-abc', name: 'JK_B2A8S20P', at: clock })
  })

  it('offers the remembered pack to a freshly constructed telemetry', () => {
    saveLastDevice('jk-xyz', 'JK-Pack', clock)
    const { telemetry } = spawn()
    expect(telemetry.lastDevice.value).toEqual({ id: 'jk-xyz', name: 'JK-Pack', at: clock })
  })
})

describe('reconnecting without the chooser', () => {
  it('rejoins the remembered pack by its id', async () => {
    const { telemetry, bms } = spawn()
    await telemetry.connectBms()
    await telemetry.disconnectBms()
    await telemetry.drain()
    expect(telemetry.bmsState.value).toBe('idle')

    await telemetry.reconnectBms()

    expect(bms.lastReconnectId).toBe('jk-abc')
    expect(telemetry.bmsState.value).toBe('live')
    expect(telemetry.source.value).toBe('live')
  })

  it('does nothing when no pack has ever been connected', async () => {
    const { telemetry, bms } = spawn()
    await telemetry.reconnectBms()
    expect(bms.lastReconnectId).toBeNull()
    expect(telemetry.bmsState.value).toBe('idle')
  })

  it('stays on the attempt while the pack has not been heard from, and comes live when it is', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms } = spawn()
    // The link waits for a sighting rather than failing, which is what the real client does now: a
    // pack that has been quiet for three minutes has to be heard from before it can be attached to.
    bms.holdReconnectUntilSighted()

    const rejoining = telemetry.reconnectBms()
    await telemetry.drain()

    expect(bms.reconnectsAwaitingSighting).toBe(1)
    expect(telemetry.bmsState.value).toBe('connecting')

    bms.sightPack()
    await rejoining

    expect(telemetry.bmsState.value).toBe('live')
    expect(bms.reconnectsAwaitingSighting).toBe(0)
  })

  it('gives up on a press the pack never answers, rather than waiting on it for ever', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms, timers } = spawn()
    // The pack has not been heard from, so the link parks on the watch — which settles on a
    // sighting and on nothing else at all.
    bms.holdReconnectUntilSighted()

    void telemetry.reconnectBms()
    await flush()
    expect(telemetry.bmsState.value).toBe('connecting')

    // Ten minutes of a pack that is not there. An attempt under no deadline holds 'connecting' for
    // as long as the tab is open, and that state hides every control that would end it.
    timers.advance(600_000)
    await flush()

    expect(telemetry.bmsState.value).toBe('idle')
    expect(bms.reconnectsAwaitingSighting).toBe(0)
  })

  it('surfaces the failure when the pack is out of range', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms } = spawn()
    bms.failNextReconnectWith(new Error('Reconnect timed out. Use Connect BMS.'))

    await telemetry.reconnectBms()

    expect(telemetry.bmsState.value).toBe('idle')
    expect(telemetry.bmsError.value).toContain('Reconnect timed out')
  })

  // Silence is owed to the loop's own attempts and to nothing else. A press is the owner asking a
  // question, and a question deserves its answer even when the answer is that the pack refused.
  it('explains a reconnect the owner pressed and the pack refused', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms } = spawn()
    bms.failEveryReconnectWith(new Error('out of range'))

    await telemetry.reconnectBms()

    expect(telemetry.bmsState.value).toBe('idle')
    expect(telemetry.bmsError.value).not.toBeNull()
  })
})

describe('which banners a running search is allowed to silence', () => {
  it('keeps the drop to itself while it is going back for the pack', async () => {
    const { telemetry, bms } = spawn()
    telemetry.startRejoin()
    await telemetry.connectBms()
    bms.holdReconnectUntilSighted()

    bms.emitDisconnect()
    await telemetry.drain()

    // The page has the problem in hand and says so on the search line; the banner would only be
    // arguing with that.
    expect(telemetry.bmsError.value).toContain('Lost the BMS')
    expect(telemetry.bmsBanner.value).toBeNull()
  })

  it('answers a press even mid-search, so a connect the owner asked for never fails in silence', async () => {
    const { telemetry, bms } = spawn()
    telemetry.startRejoin()
    await telemetry.connectBms()
    bms.holdReconnectUntilSighted()
    bms.emitDisconnect()
    await telemetry.drain()
    expect(telemetry.rejoinSearching.value).toBe(true)

    // The owner reaches for the chooser mid-search and the pack refuses — the one sentence telling
    // them why must survive the silence the search is keeping.
    bms.reportDuringNextConnect(() => undefined, new Error('NetworkError'))
    await telemetry.connectBms()

    expect(telemetry.bmsBanner.value).not.toBeNull()
  })
})

describe("the owner's standing answer about rejoining", () => {
  it('rejoins on its own for a browser that has never been told otherwise', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms } = spawn()
    expect(telemetry.rejoinArmed.value).toBe(true)

    telemetry.startRejoin()
    await flush()

    expect(bms.lastReconnectId).toBe('jk-abc')
    expect(telemetry.bmsState.value).toBe('live')
    expect(telemetry.rejoinPackName.value).toBe('JK_B2A8S20P')
  })

  it('stops rejoining when the owner presses Disconnect, and a reload does not undo that', async () => {
    const first = spawn()
    await first.telemetry.connectBms()
    await first.telemetry.disconnectBms()
    await first.telemetry.drain()
    expect(first.telemetry.rejoinArmed.value).toBe(false)
    expect(loadRejoinIntent()).toBe(false)

    // The page is reloaded: a second telemetry over the same browser storage, which is all a
    // reload leaves behind. It must open having forgotten nothing about what the owner asked for.
    const reloaded = spawn()
    expect(reloaded.telemetry.rejoinArmed.value).toBe(false)

    reloaded.telemetry.startRejoin()
    reloaded.timers.advance(60_000)
    await flush()

    expect(reloaded.bms.lastReconnectId).toBeNull()
    expect(reloaded.telemetry.bmsState.value).toBe('idle')
    expect(reloaded.telemetry.rejoinSearching.value).toBe(false)
  })

  it('arms again on a connect the owner asked for, and that survives the reload too', async () => {
    saveRejoinIntent(false)
    const first = spawn()
    expect(first.telemetry.rejoinArmed.value).toBe(false)

    await first.telemetry.connectBms()

    expect(first.telemetry.rejoinArmed.value).toBe(true)
    const reloaded = spawn()
    reloaded.telemetry.startRejoin()
    await flush()
    expect(reloaded.bms.lastReconnectId).toBe('jk-abc')
  })

  it('arms again on a reconnect the owner asked for', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    saveRejoinIntent(false)
    const { telemetry } = spawn()

    await telemetry.reconnectBms()

    expect(telemetry.rejoinArmed.value).toBe(true)
    expect(loadRejoinIntent()).toBe(true)
  })

  it('stands the attempt in flight down the moment Disconnect is pressed', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms } = spawn()
    bms.holdReconnectUntilSighted()

    telemetry.startRejoin()
    await flush()
    expect(bms.reconnectsAwaitingSighting).toBe(1)

    await telemetry.disconnectBms()
    await flush()

    expect(bms.reconnectsAwaitingSighting).toBe(0)
    expect(telemetry.rejoinArmed.value).toBe(false)
    expect(telemetry.bmsError.value).toBeNull()
  })
})

describe('trying again on its own', () => {
  it('says nothing at all while a pack that is merely out of range refuses to answer', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms, timers } = spawn()
    bms.failEveryReconnectWith(new Error('Reconnect timed out. Use Connect BMS.'))

    telemetry.startRejoin()
    await flush()
    for (const waited of [1_000, 2_000, 4_000]) {
      timers.advance(waited)
      await flush()
    }

    expect(telemetry.bmsError.value).toBeNull()
    expect(telemetry.bmsState.value).toBe('idle')
    expect(telemetry.rejoinSearching.value).toBe(true)
    expect(telemetry.rejoinBlocker.value).toBeNull()
  })

  it('comes live by itself when the pack returns, with nothing pressed', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms, timers } = spawn()
    bms.failEveryReconnectWith(new Error('out of range'))

    telemetry.startRejoin()
    await flush()
    expect(telemetry.bmsState.value).toBe('idle')

    bms.failEveryReconnectWith(null)
    timers.advance(1_000)
    await flush()

    expect(telemetry.bmsState.value).toBe('live')
    expect(telemetry.source.value).toBe('live')
    expect(telemetry.bmsError.value).toBeNull()
    expect(telemetry.rejoinSearching.value).toBe(false)
  })

  it('goes looking again the moment the link drops', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms, timers } = spawn()
    telemetry.startRejoin()
    await flush()
    expect(telemetry.bmsState.value).toBe('live')

    bms.holdReconnectUntilSighted()
    bms.emitDisconnect()
    await telemetry.drain()
    expect(telemetry.rejoinSearching.value).toBe(true)

    timers.advance(1_000)
    await flush()

    expect(bms.reconnectsAwaitingSighting).toBe(1)
  })
})

describe('going back for the pack while the owner works in another application', () => {
  it('comes live behind another window, on the half of a rejoin that needs no focus', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms, page } = spawn()
    // The laptop is open on the chart table and the owner is in another application. The pack is
    // still in the adapter map, which is what the minutes after a drop look like.
    page.blur()

    telemetry.startRejoin()
    await flush()

    expect(telemetry.bmsState.value).toBe('live')
    expect(bms.lastReconnectPatience).toBe('straight-in-only')
  })

  it('arms no watch until there is a window to hold one, then waits to be heard', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms, timers, page } = spawn()
    // Quiet long enough that the adapter map has dropped the pack, so only a sighting can bring it
    // back — and a sighting is the one thing the page behind another window cannot wait for.
    bms.holdReconnectUntilSighted()
    page.blur()

    telemetry.startRejoin()
    await flush()

    expect(bms.reconnectsAwaitingSighting).toBe(0)
    expect(telemetry.bmsState.value).toBe('idle')
    expect(telemetry.rejoinSearching.value).toBe(true)

    // The owner comes back to the page, and the half that needs a window is available again.
    page.focus()
    timers.advance(1_000)
    await flush()

    expect(bms.reconnectsAwaitingSighting).toBe(1)

    bms.sightPack()
    await flush()

    expect(telemetry.bmsState.value).toBe('live')
  })
})

describe('what the page claims while a pack is streaming', () => {
  it('stops saying the permission is gone once the chooser has answered it', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms } = spawn()
    bms.failEveryReconnectWith(
      new ReconnectRefusedError('permission-gone', 'This browser no longer has permission.'),
    )

    telemetry.startRejoin()
    await flush()
    expect(telemetry.rejoinBlocker.value).toBe('permission-gone')

    // The owner does the one thing the refusal asked for. Only an attempt ever takes this claim
    // back, and a chooser connect runs none — so the page would go on printing "no longer has
    // permission for JK_B2A8S20P" over that pack's own live numbers.
    bms.failEveryReconnectWith(null)
    await telemetry.connectBms()

    expect(telemetry.bmsState.value).toBe('live')
    expect(telemetry.rejoinBlocker.value).toBeNull()
  })
})

describe('what the Log makes of a gap the supervisor closes', () => {
  /** Enough seconds of pack for the archive to keep the session rather than delete it as a stub. */
  function driveSeconds(bms: FakeBmsLink, timers: ManualSchedule, count: number): void {
    for (let second = 0; second < count; second += 1) {
      bms.emitSnapshot(battery())
      timers.advance(1_000)
    }
  }

  it('carries one session through a drop it rejoined from, with the gap written down', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms, timers, store } = spawn()
    telemetry.startRejoin()
    await flush()
    // A link going live opens no session; the first row does.
    driveSeconds(bms, timers, 8)
    await telemetry.drain()
    const opened = telemetry.recording.value.sessionId
    expect(opened).not.toBeNull()

    // The pack has to be heard from before it can be attached to, so the gap is a real one.
    bms.holdReconnectUntilSighted()
    bms.emitDisconnect()
    await telemetry.drain()
    // No radio is up, so the instruments fall back — while the archive goes on holding the session.
    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.recording.value.sessionId).toBe(opened)

    timers.advance(10_000)
    bms.sightPack()
    await flush()
    expect(telemetry.bmsState.value).toBe('live')
    driveSeconds(bms, timers, 8)
    await telemetry.drain()

    expect(telemetry.recording.value.sessionId).toBe(opened)

    // Closed by hand, because the entries only reach the disk with the row that seals them.
    await telemetry.disconnectBms()
    await telemetry.drain()

    const sessions = await store.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].record.id).toBe(opened)
    const gaps = sessions[0].record.entries.filter((entry) => entry.kind === 'gap')
    expect(gaps).toHaveLength(1)
    expect(gaps[0].text).toMatch(/the BMS dropped/)
  })
})

describe('the banner after an attempt that failed mid-handshake', () => {
  // Chrome rejects a request that was in flight when the link went away with a NetworkError, whose
  // guidance — close the JK app on your phone, the pack accepts one connection at a time — is true
  // of a refused connection and wrong about a pack that has simply left range.
  function linkGone(): DOMException {
    return new DOMException('GATT Server is disconnected.', 'NetworkError')
  }

  it('keeps the drop banner when the pack goes away inside a chooser connect', async () => {
    const { telemetry, bms } = spawn()
    bms.reportDuringNextConnect(() => bms.emitDisconnect(), linkGone())

    await telemetry.connectBms()

    expect(telemetry.bmsState.value).toBe('idle')
    expect(telemetry.bmsError.value).toMatch(/Lost the BMS/)
  })

  it('answers a failed connect with its own guidance, not the frame the pack could not be read from', async () => {
    const { telemetry, bms } = spawn()
    // A device-info frame that runs short makes the decoder read past its end, and the client
    // reports that over onError while the handshake is still running. It describes one bad frame,
    // not why the connection then failed, so the connect guidance has to win the slot.
    bms.reportDuringNextConnect(
      () => bms.emitError(new RangeError('Offset is outside the bounds of the DataView')),
      linkGone(),
    )

    await telemetry.connectBms()

    expect(telemetry.bmsError.value).toMatch(/JK app/)
    expect(telemetry.bmsError.value).not.toMatch(/DataView/)
  })

  it('keeps the drop banner when a superseded reconnect unwinds', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms } = spawn()
    // What the handshake throws at its next checkpoint once its own drop handler has superseded it.
    bms.reportDuringNextReconnect(() => bms.emitDisconnect(), new DOMException('Reconnect superseded', 'AbortError'))

    await telemetry.reconnectBms()

    expect(telemetry.bmsState.value).toBe('idle')
    expect(telemetry.bmsError.value).toMatch(/Lost the BMS/)
  })

  it('keeps the drop banner when a write in flight rejects as the pack goes away', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms } = spawn()
    bms.reportDuringNextReconnect(() => bms.emitDisconnect(), linkGone())

    await telemetry.reconnectBms()

    expect(telemetry.bmsState.value).toBe('idle')
    expect(telemetry.bmsError.value).toMatch(/Lost the BMS/)
  })
})

describe('holding the remembered view through the attempt', () => {
  it('replaces the remembered numbers only once the link is live', async () => {
    saveRememberedSession(rememberedSession({ capturedAt: clock }))
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry } = spawn()
    telemetry.restoreRemembered()
    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).not.toBeNull()

    await telemetry.reconnectBms()

    expect(telemetry.source.value).toBe('live')
    expect(telemetry.rememberedAt.value).toBeNull()
  })

  it('leaves the remembered view untouched when the reconnect fails', async () => {
    saveRememberedSession(rememberedSession({ capturedAt: clock }))
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms } = spawn()
    telemetry.restoreRemembered()
    bms.failNextReconnectWith(new Error('out of range'))

    await telemetry.reconnectBms()

    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).not.toBeNull()
    expect(telemetry.bmsState.value).toBe('idle')
  })
})
