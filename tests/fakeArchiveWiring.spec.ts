// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import type { App as MountedApp } from 'vue'

import { SessionRecorder } from '../src/application/history/SessionRecorder'
import type { RecorderClock, RecorderState } from '../src/application/history/SessionRecorder'
import RecordingPlate from '../src/components/RecordingPlate.vue'
import type { RingSnapshot } from '../src/domain/history/RingSnapshot'
import { SAMPLE_INTERVAL_MS } from '../src/domain/history/types'
import type { HistoryStore } from '../src/application/history/port'
import { battery } from './support/samples'

// The shell mounted the way the page mounts it, to see which archive its two halves are given.
//
// The levers that make the archive fail are the only ones that cannot be checked by calling a
// method and reading a ref: they are inert unless the store the shell opens goes through the
// controller on its way to the recorder and to the views. A spec that wrapped a store of its own
// would pass over a shell that hands the raw one to both, which is the failure this file exists to
// catch — every archive control dead in the browser and every one of them green here.
//
// Both halves must be given the same object. The recorder writes through the store telemetry was
// handed and the views read through the one the browser model was handed, so two different stores
// would leave a lever working on one half of the page.
//
// And they must be given it again every time a lever moves. A lever is read into the store it
// builds and never afterwards, so a shell that wired the first store and kept it goes on reading
// and writing the setting that store was built with. What that costs is the archive controls
// changing nothing a reader can see; what it looks like from here is a lever that changes no object.

vi.stubEnv('VITE_FAKE_BLE', 'true')

vi.mock('../src/application/telemetry', async (importOriginal) => {
  const telemetry = await importOriginal<typeof import('../src/application/telemetry')>()
  return { ...telemetry, attachHistoryStore: vi.fn(telemetry.attachHistoryStore) }
})

vi.mock('../src/application/history/historyBrowser', async (importOriginal) => {
  const browser =
    await importOriginal<typeof import('../src/application/history/historyBrowser')>()
  return { ...browser, provideHistoryEnvironment: vi.fn(browser.provideHistoryEnvironment) }
})

// Imported after the flag is stubbed, because the shell reads it as it wires the store up.
const { default: App } = await import('../src/App.vue')
const { attachHistoryStore } = await import('../src/application/telemetry')
const { provideHistoryEnvironment, useHistoryBrowser } = await import(
  '../src/application/history/historyBrowser'
)
const { fakeRadioController } = await import('../src/infrastructure/ble/fake/fakeDeps')

let app: MountedApp | null = null
let host: HTMLElement

/** The store the recorder holds now, which the archive probe settles well after the mount and
 *  every archive lever replaces. */
function storeGivenToTheRecorder(): HistoryStore {
  const handed = vi.mocked(attachHistoryStore).mock.calls.at(-1)
  if (handed === undefined) throw new Error('the shell wired no archive')
  return handed[0]
}

function storeGivenToTheViews(): HistoryStore {
  const handed = vi.mocked(provideHistoryEnvironment).mock.calls.at(-1)
  if (handed === undefined) throw new Error('the shell wired no archive')
  return handed[0].store
}

beforeAll(async () => {
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(App)
  app.mount(host)
  await vi.waitFor(() => expect(attachHistoryStore).toHaveBeenCalled())
})

afterAll(() => {
  app?.unmount()
  app = null
  host.remove()
  fakeRadioController().archive?.close()
  vi.unstubAllEnvs()
})

describe('the archive a playback build hands its two halves', () => {
  it('gives the recorder and the views one store, and it is not the one the browser opened', () => {
    const real = fakeRadioController().archive

    expect(real).not.toBeNull()
    expect(storeGivenToTheRecorder()).toBe(storeGivenToTheViews())
    // The real archive is kept for the seeding and the wipe, which have to reach past every lever.
    expect(storeGivenToTheRecorder()).not.toBe(real)
  })

  it('lets the archive be taken away from both halves at once', async () => {
    const controller = fakeRadioController()
    const wired = storeGivenToTheViews()
    controller.failArchiveWith('quota-exhausted')

    try {
      // A different object, because the one the page held has the old lever setting read into it.
      expect(storeGivenToTheViews()).not.toBe(wired)
      expect(storeGivenToTheRecorder()).toBe(storeGivenToTheViews())
      expect(storeGivenToTheRecorder().availability.reason).toBe('quota-exhausted')
      // Honest rather than broken, which is what makes this a different screen from a failure.
      expect(await storeGivenToTheViews().listSessions()).toEqual([])
    } finally {
      controller.failArchiveWith(null)
    }

    expect(storeGivenToTheRecorder().availability.usable).toBe(true)
  })

  it('lets every call through both halves be made to fail', async () => {
    const controller = fakeRadioController()
    controller.failEveryArchiveCall(true)

    try {
      await expect(storeGivenToTheRecorder().listSessions()).rejects.toThrow()
      await expect(storeGivenToTheViews().listSessions()).rejects.toThrow()
    } finally {
      controller.failEveryArchiveCall(false)
    }

    expect(await storeGivenToTheViews().listSessions()).toEqual([])
  })

  it('lets the archive take a write and turn it down, with reading left working', async () => {
    const controller = fakeRadioController()
    controller.refuseArchiveWrites(true)

    try {
      const refusing = storeGivenToTheRecorder()
      expect(refusing).toBe(storeGivenToTheViews())
      // The archive is there. That is what separates this screen from the one above it, and it is
      // the only shape the recorder reads a failure of its own out of.
      expect(refusing.availability.usable).toBe(true)
      expect(await storeGivenToTheViews().listSessions()).toEqual([])
      await expect(refusing.appendRingSnapshot(unansweredRead())).resolves.toMatchObject({
        stored: false,
        failure: 'quota-exhausted',
      })
    } finally {
      controller.refuseArchiveWrites(false)
    }

    await expect(
      storeGivenToTheRecorder().appendRingSnapshot(unansweredRead()),
    ).resolves.toMatchObject({ stored: true })
  })

  it('takes the plate off recording when the archive is taken away mid-watch', async () => {
    // The lever is the clickable route to a session whose archive goes away underneath it: it hands
    // both halves a store of its own, and a recorder that resolved its store once would keep
    // printing a stopwatch over an archive the page no longer has. Driven through a recorder wired
    // exactly as the shell wires telemetry's — the store resolved on each use, never held.
    const controller = fakeRadioController()
    let wall = Date.now()
    let monotonic = 0
    const clock: RecorderClock = { now: () => wall, monotonic: () => monotonic }
    const state = shallowRef<RecorderState>({
      sessionId: null,
      startedAt: null,
      packSamples: 0,
      solarSamples: 0,
      droppedChunks: 0,
      failure: null,
      lease: 'undecided',
    })
    const recorder = new SessionRecorder({
      store: storeGivenToTheRecorder,
      clock,
      onStateChange: (published) => (state.value = published),
    })

    /** One playback frame, which under the panel arrives about four times a second. */
    const playAFrame = (): void => {
      recorder.notePack(battery())
      wall += SAMPLE_INTERVAL_MS
      monotonic += SAMPLE_INTERVAL_MS
    }

    // Rendered through a root of its own so both inputs stay reactive, which is how the shell feeds
    // it: the recorder publishes into a ref and the browser model keeps availability in another.
    const availability = useHistoryBrowser().availability
    const plate = createApp({
      setup: () => () => h(RecordingPlate, { state: state.value, availability: availability.value }),
    })
    const plateHost = document.createElement('div')
    document.body.append(plateHost)
    plate.mount(plateHost)
    const painted = (): string => (plateHost.textContent ?? '').replace(/\s+/g, ' ').trim()

    try {
      for (let frame = 0; frame < 6; frame += 1) playAFrame()
      recorder.checkpoint()
      await recorder.drain()
      await nextTick()
      expect(painted()).toMatch(/^■RECORDING · \d\d:\d\d:\d\d · 6 samples$/)

      // Two signals, two jobs: the recorder's failure is what stops the plate reading a live
      // session as recording, and the archive's own reason is what picks the sentence that replaces
      // it. Both reasons are checked because they land on different lines.
      const said: Record<string, string> = {}
      for (const reason of ['no-indexeddb', 'open-blocked'] as const) {
        controller.failArchiveWith(reason)
        playAFrame()
        await vi.waitFor(() => expect(availability.value?.reason).toBe(reason))
        await nextTick()
        said[reason] = painted()
      }

      expect(said).toEqual({
        'no-indexeddb': 'NOT RECORDING — this browser will not keep a log.',
        'open-blocked': 'NOT RECORDING — an older version of this page is open in another tab.',
      })
    } finally {
      controller.failArchiveWith(null)
      plate.unmount()
      plateHost.remove()
      recorder.dispose()
    }
  })
})

/** A read the pack never answered, which is the smallest thing the ledger will take. */
function unansweredRead(): RingSnapshot {
  return {
    deviceKey: 'probe-pack',
    observedAt: 0,
    outcome: 'no-answer',
    runs: [],
    transport: {
      notificationBytes: 0,
      notificationCount: 0,
      assembledFrameCount: 0,
      logFrameCount: 0,
      elapsedMs: 0,
    },
  }
}
