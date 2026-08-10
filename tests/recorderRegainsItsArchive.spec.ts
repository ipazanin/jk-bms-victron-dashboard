// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import type { App as MountedApp } from 'vue'

import { provideHistoryEnvironment } from '../src/application/history/historyBrowser'
import { unavailableHistoryStore } from '../src/application/history/port'
import type { HistoryStore } from '../src/application/history/port'
import { SessionRecorder } from '../src/application/history/SessionRecorder'
import type { RecorderClock } from '../src/application/history/SessionRecorder'
import { useTelemetry } from '../src/application/telemetry'
import SessionRow from '../src/components/history/SessionRow.vue'
import BusView from '../src/components/views/BusView.vue'
import { MIN_SESSION_SAMPLES } from '../src/domain/history/budget'
import { SAMPLE_INTERVAL_MS } from '../src/domain/history/types'
import type { SessionRecord } from '../src/domain/history/types'
import { openHistoryStore } from '../src/infrastructure/history/openHistoryStore'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { textOf, unmountComponent } from './support/mountComponent'
import { battery } from './support/samples'

/**
 * An archive that goes away under an open session and then comes back, read off the screen and off
 * the disk rather than off the recorder.
 *
 * A wounded session that is never sealed is worse than one that stops. The Log prints 'Recording'
 * for as long as a row stays open, and the tail re-commits go on stamping that row with a fresh
 * heartbeat while its sample count stands still. Pruning protects it too, though not for that
 * reason: `isProtected` returns on `state === 'open'` before it ever compares a heartbeat, so an
 * open row is covered however stale its stamp. Either way a row nothing writes to reads as live.
 *
 * The route here is the one that reaches it: the dev panel's Archive selector hands the page a
 * store of its own for each setting, so 'unavailable' is a different object that answers no and
 * 'open and working' is the real archive back, with everything it held untouched.
 */

const ARCHIVE = 'shunt.log.recorderregains'
const SAMPLES_BEFORE = MIN_SESSION_SAMPLES + 2
const SAMPLES_AFTER = 20

let real: HistoryStore
let shown: HistoryStore
let recorder: SessionRecorder
let mounted: MountedApp | null = null
let host: HTMLElement

let wall = Date.now()
let monotonic = 0
const clock: RecorderClock = { now: () => wall, monotonic: () => monotonic }

/** What the plate says now, wrapping collapsed so the copy reads as one line. */
function painted(): string {
  const text = (host.textContent ?? '').replace(/\s+/g, ' ')
  return /(NOT )?RECORDING[^A-Z]*/.exec(text)?.[0].trim() ?? '(the plate says nothing)'
}

/** Feeds snapshots at the rate the recorder's own gate admits, as the pack does. */
function drivePack(count: number): void {
  for (let index = 0; index < count; index += 1) {
    recorder.notePack(battery())
    wall += SAMPLE_INTERVAL_MS
    monotonic += SAMPLE_INTERVAL_MS
  }
}

/** What the Archive selector does: one store per setting, handed to both halves of the page. */
function selectArchive(store: HistoryStore): void {
  shown = store
  provideHistoryEnvironment({ store, downloadJson: () => undefined })
}

async function rowsNewestFirst(): Promise<SessionRecord[]> {
  return (await real.listSessions()).map((listing) => listing.record)
}

/** What the Log's row for one session says, wrapping collapsed. */
async function loggedAs(index: number): Promise<string> {
  const listing = (await real.listSessions())[index]
  return textOf(SessionRow, { listing, now: wall }).replace(/\s+/g, ' ').trim()
}

beforeAll(async () => {
  real = await openHistoryStore(ARCHIVE)
  recorder = new SessionRecorder({
    store: () => shown,
    clock,
    // The same bridge telemetry uses: the recorder publishes, the shared ref carries it to the view.
    onStateChange: (state) => (useTelemetry().recording.value = state),
  })

  host = document.createElement('div')
  document.body.append(host)
  selectArchive(real)
  mounted = createApp(BusView)
  mounted.mount(host)
})

afterAll(() => {
  mounted?.unmount()
  mounted = null
  host.remove()
  recorder.dispose()
  real.close()
})

describe('a session whose archive comes back', () => {
  it('is sealed through the archive that returned, and the watch goes on in a clean one', async () => {
    drivePack(SAMPLES_BEFORE)
    recorder.checkpoint()
    await recorder.drain()
    await vi.waitFor(() => expect(painted()).toContain(`${SAMPLES_BEFORE} samples`))

    const wounded = recorder.state.sessionId
    expect(painted()).toMatch(
      new RegExp(`^RECORDING · \\d\\d:\\d\\d:\\d\\d · ${SAMPLES_BEFORE} samples$`),
    )

    selectArchive(unavailableHistoryStore('quota-exhausted'))
    drivePack(1)
    await recorder.drain()
    await vi.waitFor(() =>
      expect(painted()).toBe('NOT RECORDING — this browser will not keep a log.'),
    )

    // Back to 'open and working'. Every row the wounded session got onto disk is still there: the
    // selector never touched the real archive, it only stood in front of it.
    selectArchive(real)
    drivePack(SAMPLES_AFTER)
    recorder.checkpoint()
    await recorder.drain()

    await vi.waitFor(() => expect(painted()).toContain(`${SAMPLES_AFTER} samples`))
    // A count back at the beginning, because this is a new session rather than the old one resumed
    // — the archive can be sealed through, not rewound.
    expect(painted()).toMatch(
      new RegExp(`^RECORDING · \\d\\d:\\d\\d:\\d\\d · ${SAMPLES_AFTER} samples$`),
    )
    expect(recorder.state.sessionId).not.toBe(wounded)
    expect(recorder.state.failure).toBeNull()

    // And what a reader of the Log meets: two rows, the wounded one closed and saying why, the new
    // one open and taking rows. Nothing left open with a heartbeat and a frozen sample count.
    const rows = await rowsNewestFirst()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ state: 'open', packSamples: SAMPLES_AFTER, endReason: null })
    expect(rows[1]).toMatchObject({
      id: wounded,
      state: 'closed',
      packSamples: SAMPLES_BEFORE,
      endReason: 'archive-lost',
    })
    expect(rows[1].entries[rows[1].entries.length - 1].text).toBe(
      'Session ends — the log could not be written to',
    )

    // The reason the row has to close rather than sit there marked: the Log reads an open row as a
    // watch still being written to, and a wounded one heartbeats on with its count frozen. The
    // label proves the row rendered, so the absence below is an absence and not an empty mount.
    const sealed = await loggedAs(1)
    expect(sealed).toContain('Length')
    expect(sealed).not.toContain('Recording')
    expect(await loggedAs(0)).toContain('Recording')
    unmountComponent()
  })
})

describe('a session whose archive refused a write but never stopped being one', () => {
  it('is kept, because there is nothing here that came back', async () => {
    const store = new MemoryHistoryStore()
    let refusedWall = Date.now()
    let refusedMonotonic = 0
    const refused = new SessionRecorder({
      store: () => store,
      clock: { now: () => refusedWall, monotonic: () => refusedMonotonic },
    })
    const drive = (count: number): void => {
      for (let index = 0; index < count; index += 1) {
        refused.notePack(battery())
        refusedWall += SAMPLE_INTERVAL_MS
        refusedMonotonic += SAMPLE_INTERVAL_MS
      }
    }

    drive(4)
    await refused.drain()
    const open = refused.state.sessionId

    store.failNextCommitWith(new DOMException('no room', 'QuotaExceededError'))
    drive(1)
    refused.checkpoint()
    await refused.drain()
    expect(refused.state.failure).toBe('quota-exhausted')

    // The store said no to a row and went on reporting itself usable, which is a different fact
    // from an archive that stopped being one. Read the first as the second and every observation
    // from here is a recovery: the open session is sealed and a fresh one takes its place, on every
    // refused chunk, for as long as the disk stays full.
    expect(store.availability.usable).toBe(true)
    drive(30)
    refused.checkpoint()
    await refused.drain()

    expect(refused.state.sessionId).toBe(open)
    expect(refused.state.failure).toBe('quota-exhausted')
    expect((await store.listSessions()).map((listing) => listing.record.state)).toEqual(['open'])
    refused.dispose()
  })
})
