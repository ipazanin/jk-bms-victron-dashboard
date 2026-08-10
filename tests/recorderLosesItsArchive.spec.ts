// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import type { App as MountedApp } from 'vue'

import { provideHistoryEnvironment } from '../src/application/history/historyBrowser'
import type { HistoryStore } from '../src/application/history/port'
import { SessionRecorder } from '../src/application/history/SessionRecorder'
import type { RecorderClock } from '../src/application/history/SessionRecorder'
import { useTelemetry } from '../src/application/telemetry'
import BusView from '../src/components/views/BusView.vue'
import { SAMPLE_INTERVAL_MS } from '../src/domain/history/types'
import type { SessionRecord } from '../src/domain/history/types'
import { DATABASE_VERSION } from '../src/infrastructure/history/IdbHistoryStore'
import { openHistoryStore } from '../src/infrastructure/history/openHistoryStore'
import { battery } from './support/samples'

/**
 * A watch whose archive goes away underneath it, read off the screen rather than off the recorder.
 *
 * The recorder opens a session on the first observation and then never looks at the store again on
 * that path: the writes resolve it on the chain, where a store that has stopped being usable is a
 * silent early return. So a connection that stood aside for another tab's upgrade used to leave the
 * bus view printing a stopwatch and a climbing sample count over an archive that was already shut,
 * with the Log and the storage line on the same page saying the opposite.
 *
 * Which is why this file drives a real database under a real Bus view and asserts on the words on
 * screen. The same defect passed a full review green against specs that asked the recorder what it
 * thought of itself — every one of those objects was correct, and the page still lied.
 */

const ARCHIVE = 'shunt.log.recorderloses'
const SAMPLES_BEFORE = 6
const SAMPLES_AFTER = 4

let store: HistoryStore
let recorder: SessionRecorder
let mounted: MountedApp | null = null
let host: HTMLElement
/** The connection that forces the upgrade, kept so the run does not end holding a database open. */
let newerBuild: IDBDatabase | null = null

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

/** Another tab of a newer build, opening the same archive one version up. */
function openTheArchiveOneVersionHigher(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(ARCHIVE, DATABASE_VERSION + 1)
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error ?? new Error('open failed')))
    request.addEventListener('blocked', () =>
      reject(new Error('the open tab never let go of the archive')),
    )
  })
}

/** The session rows as they were left on disk, read through the connection that took over. */
function rowsLeftOnDisk(database: IDBDatabase): Promise<SessionRecord[]> {
  return new Promise<SessionRecord[]>((resolve, reject) => {
    const request = database.transaction(['sessions'], 'readonly').objectStore('sessions').getAll()
    request.addEventListener('success', () => resolve(request.result as SessionRecord[]))
    request.addEventListener('error', () => reject(request.error ?? new Error('read failed')))
  })
}

beforeAll(async () => {
  store = await openHistoryStore(ARCHIVE)
  recorder = new SessionRecorder({
    store: () => store,
    clock,
    // The same bridge telemetry uses: the recorder publishes, the shared ref carries it to the view.
    onStateChange: (state) => (useTelemetry().recording.value = state),
  })

  host = document.createElement('div')
  document.body.append(host)
  provideHistoryEnvironment({ store, downloadJson: () => undefined })
  mounted = createApp(BusView)
  mounted.mount(host)
})

afterAll(() => {
  mounted?.unmount()
  mounted = null
  host.remove()
  recorder.dispose()
  newerBuild?.close()
  store.close()
})

describe('a session whose archive stands down mid-watch', () => {
  it('stops claiming to record, and stops counting rows nothing is taking', async () => {
    drivePack(SAMPLES_BEFORE)
    recorder.checkpoint()
    await recorder.drain()
    await vi.waitFor(() => expect(painted()).toContain(`${SAMPLES_BEFORE} samples`))

    const before = painted()
    expect(before).toMatch(/^RECORDING · \d\d:\d\d:\d\d · 6 samples$/)
    // The rows are on disk, which is what makes the claim above true at this instant.
    expect(store.availability.usable).toBe(true)

    newerBuild = await openTheArchiveOneVersionHigher()

    await vi.waitFor(() =>
      expect(painted()).toBe('NOT RECORDING — this browser will not keep a log.'),
    )
    const after = painted()

    // The pack has no idea any of this happened and keeps sending. Every one of these used to move
    // the counter on screen with nothing behind it.
    drivePack(SAMPLES_AFTER)
    recorder.checkpoint()
    await recorder.drain()
    expect(painted()).toBe(after)
    expect(after).not.toContain('samples')

    // Not the assertion — the evidence that the screen above changed for the real reason.
    expect(store.availability).toMatchObject({ usable: false, reason: 'version-newer' })
    expect(recorder.state.failure).toBe('version-newer')
    expect(recorder.state.sessionId).not.toBeNull()

    // And what a reader of that session meets later: the row as the last commit left it, still open
    // for the recovery sweep to close, holding the rows that were accepted and none that were not.
    const rows = await rowsLeftOnDisk(newerBuild)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'open', packSamples: SAMPLES_BEFORE, endReason: null })
  })
})
