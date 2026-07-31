// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from 'vue'
import type { App } from 'vue'

import type { RecorderState } from '../src/application/history/SessionRecorder'
import { useTelemetry } from '../src/application/telemetry'
import BusView from '../src/components/views/BusView.vue'

// The plate is the only live recording indicator the page has — the Log's own line is a row in a
// list of sessions that have already happened — so what it says is asserted where a reader meets
// it: mounted in the Bus view, reading the shared telemetry the view reads.

const IDLE: RecorderState = {
  sessionId: null,
  startedAt: null,
  packSamples: 0,
  solarSamples: 0,
  droppedChunks: 0,
  failure: null,
  recordingElsewhere: false,
}

let host: HTMLElement
let app: App | null = null

function busViewShowing(state: RecorderState): string {
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
    })

    expect(text).toContain('RECORDING')
    expect(text).toContain('00:02:05')
    expect(text).toContain('125 samples')
  })

  it('names the other tab when the recording lease is held elsewhere', () => {
    // A session id it cannot write behind, which is what an optimistically opened session that was
    // refused the lease leaves on the state. Saying "recording" here would be the lie that matters.
    const text = busViewShowing({
      ...IDLE,
      sessionId: 'session-2',
      startedAt: Date.now() - 125_000,
      packSamples: 90,
      recordingElsewhere: true,
    })

    expect(text).toContain('NOT RECORDING — another tab of this page is keeping the log.')
    expect(text).not.toContain('samples')
  })

  it('names a failed write rather than falling silent', () => {
    // This plate is the only thing in the app that reads a recorder failure, so a branch missing
    // here is not a gap in the copy — it is an archive that stopped accepting writes and said so
    // nowhere. The session id and the sample count survive the failure and must not be read as
    // recording.
    const text = busViewShowing({
      ...IDLE,
      sessionId: 'session-3',
      startedAt: Date.now() - 40_000,
      packSamples: 38,
      failure: 'quota-exhausted',
    })

    expect(text).toContain('NOT RECORDING — the log could not be written to.')
    expect(text).not.toContain('samples')
  })

  it('claims nothing at all when no session is open', () => {
    const text = busViewShowing(IDLE)

    expect(text).not.toContain('RECORDING')
  })
})
