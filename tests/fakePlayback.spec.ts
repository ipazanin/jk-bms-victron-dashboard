// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'

import { createTelemetry } from '../src/application/telemetry'
import type { Source, Telemetry, TelemetryDeps } from '../src/application/telemetry'
import { FakeRadioController } from '../src/infrastructure/ble/fake/FakeRadioController'
import { loadPlaybackFixture } from '../src/infrastructure/ble/fake/fixture/loadPlaybackFixture'
import type { PlaybackScenario } from '../src/infrastructure/ble/fake/fixture/PlaybackScenario'
import type { ScenarioName } from '../src/infrastructure/ble/fake/fixture/ScenarioName'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'

// The recording played into a real telemetry, at the seam where the two meet.
//
// Every case here is about ordering rather than about numbers. The app flips to live in the
// continuation of the connect it is awaiting, and gates recording, the warning journal and the
// automatic stored-log read on that flip — so a fake that handed a frame over half a step early
// would paint an instrument and file nothing, which is the shape of failure that reads as working
// software. The clock is faked, so the fixture's own gaps are the only thing deciding when a frame
// lands and a three-minute walk costs no wall time.
//
// Each case builds its own controller and its own archive. Playback keeps its place, its lap
// carry and its levers, so a shared one would hand the next case a walk already half-way through.

const fixture = await loadPlaybackFixture()

function scenario(name: ScenarioName): PlaybackScenario {
  const found = fixture.scenarios.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`the fixture holds no scenario named ${name}`)
  return found
}

const FLOAT = scenario('float')
const DISCHARGE = scenario('discharge')

/** Longer than the walk takes to reach its first pack frame, so a held attempt outlasts one. */
const HELD_ATTEMPT_MS = 5000

let controller: FakeRadioController
let telemetry: Telemetry
let store: MemoryHistoryStore
let sessions = 0

/**
 * The radio half spelled out rather than taken from `fakeRadioDeps()`, which reaches for the one
 * controller the page shares. A case needs its own.
 */
function playbackDeps(): TelemetryDeps {
  return {
    createBmsLink: (handlers) => controller.createBmsLink(handlers),
    createSolarScan: (handlers) => controller.createSolarScan(handlers),
    createSolarHistoryLink: (handlers) => controller.createSolarHistoryLink(handlers),
    bleEnvironment: controller.bleEnvironment,
    historyStore: () => store,
    refreshRingLedger: async () => undefined,
    refreshSolarLedger: async () => undefined,
    now: () => controller.now(),
    monotonic: () => controller.now(),
    newId: () => `session-${(sessions += 1)}`,
  }
}

beforeEach(async () => {
  localStorage.clear()
  vi.useFakeTimers()
  sessions = 0
  controller = new FakeRadioController(loadPlaybackFixture())
  // The recording is fetched, so a case that asserts on the first frame has to know it is loaded.
  await controller.whenReady()
  store = new MemoryHistoryStore({ now: () => controller.now() })
  telemetry = createTelemetry(playbackDeps())
})

afterEach(async () => {
  telemetry.dispose()
  await telemetry.drain()
  store.close()
  // Drops the armed playback timer with the rest of the fake clock's queue.
  vi.useRealTimers()
  localStorage.clear()
})

/** Uptime as each snapshot carried it, in the order the app was given them. */
function uptimeAsPainted(): { readonly seconds: number[]; readonly stop: () => void } {
  const seconds: number[] = []
  const stop = watch(
    telemetry.battery,
    (snapshot) => {
      if (snapshot !== null) seconds.push(snapshot.uptimeSeconds)
    },
    { flush: 'sync' },
  )
  return { seconds, stop }
}

describe('what a connection is worth before it resolves', () => {
  it('holds the page on nothing for as long as the attempt is outstanding', async () => {
    controller.holdPackAttemptFor(HELD_ATTEMPT_MS)
    const attempt = telemetry.connectBms()

    await vi.advanceTimersByTimeAsync(HELD_ATTEMPT_MS - 1)

    // Well past the instant the recording's first pack frame sits at, and still nothing: the walk
    // follows the link, and the link is not up until the attempt settles.
    expect(HELD_ATTEMPT_MS - 1).toBeGreaterThan(FLOAT.pack[0].atMs)
    expect(telemetry.bmsState.value).toBe('connecting')
    expect(telemetry.source.value).toBe('none')
    expect(telemetry.battery.value).toBeNull()

    await vi.advanceTimersByTimeAsync(1)
    await attempt

    expect(telemetry.source.value).toBe('live')
    expect(telemetry.battery.value).toBeNull()
  })

  it('is already live by the time the first frame is painted', async () => {
    const sourceWhenPainted: Source[] = []
    const stop = watch(
      telemetry.battery,
      () => sourceWhenPainted.push(telemetry.source.value),
      { flush: 'sync' },
    )

    await telemetry.connectBms()
    await vi.advanceTimersByTimeAsync(FLOAT.pack[0].atMs)
    stop()

    // A snapshot painted while the source still said 'none' would be one the recorder, the warning
    // journal and the stale-ring check all skipped.
    expect(sourceWhenPainted).toEqual(['live'])
  })
})

describe('the pace of the recording', () => {
  it('hands each frame over at the gap the pack recorded it at', async () => {
    await telemetry.connectBms()

    await vi.advanceTimersByTimeAsync(FLOAT.pack[0].atMs - 1)
    expect(telemetry.battery.value).toBeNull()

    await vi.advanceTimersByTimeAsync(1)
    // The fixture's own object, not a copy of it: nothing rewrites a frame on its way out.
    expect(telemetry.battery.value).toBe(FLOAT.pack[0].battery)

    await vi.advanceTimersByTimeAsync(FLOAT.pack[1].atMs - FLOAT.pack[0].atMs - 1)
    expect(telemetry.battery.value).toBe(FLOAT.pack[0].battery)

    await vi.advanceTimersByTimeAsync(1)
    expect(telemetry.battery.value).toBe(FLOAT.pack[1].battery)
  })

  it('opens one session and climbs its sample count as the walk goes on', async () => {
    await telemetry.connectBms()
    await vi.advanceTimersByTimeAsync(10_000)
    await telemetry.drain()

    const opened = telemetry.recording.value
    expect(opened.sessionId).not.toBeNull()
    expect(opened.packSamples).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(10_000)
    await telemetry.drain()

    expect(telemetry.recording.value.sessionId).toBe(opened.sessionId)
    expect(telemetry.recording.value.packSamples).toBeGreaterThan(opened.packSamples)
    expect(await store.listSessions()).toHaveLength(1)
  })

  it('carries uptime forward when the scenario starts again', async () => {
    controller.playScenario('discharge')
    const painted = uptimeAsPainted()

    await telemetry.connectBms()
    // A frame or two past the wrap rather than exactly on it. The scenario's last frame and its
    // first are a whole span apart, which is no gap at all, and a fake clock pushes a zero-delay
    // timer out by a millisecond to keep a tick from looping forever.
    await vi.advanceTimersByTimeAsync(DISCHARGE.spanMs + DISCHARGE.pack[1].atMs)
    painted.stop()

    // The wrap comes only once both streams are exhausted, so the lap starts on the frame after
    // the last one the scenario holds.
    expect(controller.state.laps).toBe(1)
    expect(painted.seconds.length).toBeGreaterThan(DISCHARGE.pack.length)

    const lastOfTheLap = painted.seconds[DISCHARGE.pack.length - 1]
    const firstOfTheNext = painted.seconds[DISCHARGE.pack.length]
    expect(firstOfTheNext).toBeGreaterThan(lastOfTheLap)
    // The whole walk, not only the seam: the logbook is dated against this number, so one step
    // backwards anywhere would re-date every event the pack has ever recorded.
    expect(painted.seconds.every((seconds, at) => at === 0 || seconds >= painted.seconds[at - 1])).toBe(
      true,
    )
  })

  it('swaps what is playing without letting go of the link', async () => {
    await telemetry.connectBms()
    await vi.advanceTimersByTimeAsync(FLOAT.pack[0].atMs)
    expect(telemetry.battery.value).toBe(FLOAT.pack[0].battery)

    controller.playScenario('discharge')
    await vi.advanceTimersByTimeAsync(DISCHARGE.pack[0].atMs)

    expect(telemetry.battery.value).toBe(DISCHARGE.pack[0].battery)
    expect(telemetry.source.value).toBe('live')
    expect(telemetry.bmsState.value).toBe('live')
  })
})

describe('the pack going away underneath the walk', () => {
  it('paints the lost-BMS banner and settles into the remembered view', async () => {
    await telemetry.connectBms()
    await vi.advanceTimersByTimeAsync(FLOAT.pack[1].atMs)
    expect(telemetry.battery.value).not.toBeNull()

    controller.dropPack()
    await telemetry.drain()

    expect(telemetry.bmsError.value).toMatch(/Lost the BMS/)
    expect(telemetry.bmsState.value).toBe('idle')
    expect(telemetry.source.value).toBe('remembered')
    // Both radios are down, so the walk stops rather than playing into nothing.
    expect(controller.state.running).toBe(false)
  })

  it('keeps its place, so reconnecting carries the walk on rather than starting it again', async () => {
    await telemetry.connectBms()
    await vi.advanceTimersByTimeAsync(FLOAT.pack[1].atMs)

    controller.dropPack()
    await telemetry.drain()
    const stoppedAfter = controller.state.delivered

    await telemetry.connectBms()
    await vi.advanceTimersByTimeAsync(FLOAT.pack[2].atMs - FLOAT.pack[1].atMs)

    expect(controller.state.delivered).toBeGreaterThan(stoppedAfter)
    expect(telemetry.battery.value).toBe(FLOAT.pack[2].battery)
  })
})
