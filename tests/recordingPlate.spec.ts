// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from 'vue'
import type { App } from 'vue'

import { provideHistoryEnvironment } from '../src/application/history/historyBrowser'
import type { HistoryAvailability } from '../src/application/history/port'
import type { RecorderState } from '../src/application/history/SessionRecorder'
import { useTelemetry } from '../src/application/telemetry'
import BusView from '../src/components/views/BusView.vue'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'

// The plate is the only live recording indicator the page has — the Log's own line is a row in a
// list of sessions that have already happened — so what it says is asserted where a reader meets
// it: mounted in the Bus view, reading the shared telemetry and the shared archive the view reads.

const IDLE: RecorderState = {
  sessionId: null,
  startedAt: null,
  packSamples: 0,
  solarSamples: 0,
  droppedChunks: 0,
  failure: null,
  lease: 'undecided',
}

let host: HTMLElement
let app: App | null = null

/** The archive is usable unless a case says otherwise, which is the ordinary boat. */
function busViewShowing(state: RecorderState, archive: Partial<HistoryAvailability> = {}): string {
  provideHistoryEnvironment({
    store: new MemoryHistoryStore({ availability: archive }),
    downloadJson: () => undefined,
  })
  useTelemetry().recording.value = state
  app = createApp(BusView)
  app.mount(host)
  return host.textContent ?? ''
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  app?.unmount()
  app = null
  host.remove()
  useTelemetry().recording.value = IDLE
})

describe('what the Bus view says about recording', () => {
  it('runs a stopwatch and counts the rows while a session is open', () => {
    const text = busViewShowing({
      ...IDLE,
      sessionId: 'session-1',
      startedAt: Date.now() - 125_000,
      packSamples: 90,
      solarSamples: 35,
      lease: 'held',
    })

    expect(text).toContain('RECORDING')
    expect(text).toContain('00:02:05')
    expect(text).toContain('125 samples')
  })

  it('claims nothing for a session whose lease has not answered yet', () => {
    // The session is built on the observation that opened it and the lease is claimed on the step
    // behind it. Across that one frame the session may still be dropped whole, so a stopwatch here
    // would start at zero and vanish — the plate holds its tongue exactly as it does before a
    // session opens at all.
    const text = busViewShowing({
      ...IDLE,
      sessionId: 'session-2',
      startedAt: Date.now(),
      lease: 'undecided',
    })

    expect(text).not.toContain('RECORDING')
  })

  it('names the other tab when the recording lease is held elsewhere', () => {
    // A session id it cannot write behind, which is what an optimistically opened session that was
    // refused the lease leaves on the state. Saying "recording" here would be the lie that matters.
    const text = busViewShowing({
      ...IDLE,
      sessionId: 'session-3',
      startedAt: Date.now() - 125_000,
      packSamples: 90,
      lease: 'refused',
    })

    expect(text).toContain('NOT RECORDING — another tab of this page is keeping the log.')
    expect(text).not.toContain('samples')
  })

  it('names the older tab holding the database rather than blaming the browser', () => {
    // An archive blocked open is the one unusable archive with a way out of it, and this browser
    // would keep a log perfectly well if the other tab were closed. The generic line would send the
    // owner looking at private browsing settings that have nothing to do with it.
    const text = busViewShowing(IDLE, { usable: false, reason: 'open-blocked' })

    expect(text).toContain('NOT RECORDING — an older version of this page is open in another tab.')
    expect(text).not.toContain('this browser will not keep a log')
  })

  it('says the browser will keep no log when storage is refused outright', () => {
    const text = busViewShowing(IDLE, { usable: false, reason: 'no-indexeddb' })

    expect(text).toContain('NOT RECORDING — this browser will not keep a log.')
  })

  it('names a failed write rather than falling silent', () => {
    // This plate is the only thing in the app that reads a recorder failure, so a branch missing
    // here is not a gap in the copy — it is an archive that stopped accepting writes and said so
    // nowhere. The session id and the sample count survive the failure and must not be read as
    // recording.
    const text = busViewShowing({
      ...IDLE,
      sessionId: 'session-4',
      startedAt: Date.now() - 40_000,
      packSamples: 38,
      failure: 'quota-exhausted',
      lease: 'held',
    })

    expect(text).toContain('NOT RECORDING — the log could not be written to.')
    expect(text).not.toContain('samples')
  })

  it('claims nothing at all when no session is open', () => {
    const text = busViewShowing(IDLE)

    expect(text).not.toContain('RECORDING')
  })
})
