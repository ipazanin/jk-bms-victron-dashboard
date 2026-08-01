// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from 'vue'
import type { App } from 'vue'

import { provideHistoryEnvironment } from '../src/application/history/historyBrowser'
import type { RecorderState } from '../src/application/history/SessionRecorder'
import { useTelemetry } from '../src/application/telemetry'
import BusView from '../src/components/views/BusView.vue'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { battery, solarReading } from './support/samples'

// Which cards the Bus view puts on the page, and which it withholds, as each radio starts
// delivering. The claim under test is the one the whole stack turns on: the ammeter is the chassis
// and renders whatever is connected, while the four pack instruments are pack interior detail and
// stay away until a cell frame has actually arrived.
//
// `bmsState`, `solarState` and `source` leave telemetry through `readonly()`, so this file can only
// reach the phases nullability alone produces — 'absent' and 'reading'. The pending phases, and
// anything keyed on a live `source`, are exercised against the components directly in
// `instrumentPhases.spec.ts`.

const AMMETER = 'DC bus reconciliation'
const FLOW = 'Energy flow'
const SOLAR_PANEL = 'Solar — Victron SmartSolar'
const LANDING = 'Read your DC bus.'
const TREND = 'Collecting samples…'
const PACK_INSTRUMENTS = ['State of charge', 'Cell balance', 'Temperatures', 'MOSFET breakers']

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

function busView(): string {
  provideHistoryEnvironment({
    store: new MemoryHistoryStore(),
    downloadJson: () => undefined,
  })
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
  // The telemetry singleton outlives this file, so every ref a case wrote is put back.
  const telemetry = useTelemetry()
  telemetry.battery.value = null
  telemetry.solar.value = null
  telemetry.recording.value = IDLE
})

describe('what the Bus view puts on the page as the radios arrive', () => {
  it('renders the instrument and the landing card with nothing connected', () => {
    const text = busView()

    expect(text).toContain(AMMETER)
    expect(text).toContain('This is the instrument. It fills in when you connect.')
    expect(text).toContain(LANDING)
    // A fully ghosted schematic and a ghosted solar panel would teach the cold page three times
    // over; the ammeter alone carries it.
    expect(text).not.toContain(FLOW)
    expect(text).not.toContain(SOLAR_PANEL)
  })

  it('renders the instrument stack from a solar reading alone', () => {
    useTelemetry().solar.value = solarReading()

    const text = busView()

    expect(text).toContain(AMMETER)
    expect(text).toContain(FLOW)
    expect(text).toContain(SOLAR_PANEL)
    expect(text).toContain('Connect the battery to see charge and cells')
    expect(text).toContain('needs the pack')
  })

  it('drops the landing card as soon as a radio reports', () => {
    useTelemetry().solar.value = solarReading()

    expect(busView()).not.toContain(LANDING)
  })

  it('withholds the pack instruments while no pack snapshot exists', () => {
    useTelemetry().solar.value = solarReading()

    const text = busView()

    for (const instrument of PACK_INSTRUMENTS) expect(text).not.toContain(instrument)
  })

  it('renders every instrument once a pack snapshot arrives', () => {
    const telemetry = useTelemetry()
    telemetry.battery.value = battery()
    telemetry.solar.value = solarReading()

    const text = busView()

    expect(text).toContain(AMMETER)
    expect(text).toContain(FLOW)
    expect(text).toContain(SOLAR_PANEL)
    for (const instrument of PACK_INSTRUMENTS) expect(text).toContain(instrument)
  })

  it('withholds the trend during a solar-only session', () => {
    // `recordSample` returns early without a pack snapshot, so a solar-only session keeps an empty
    // history for as long as it runs. Three strips saying "collecting" forever is the fabrication.
    useTelemetry().solar.value = solarReading()

    expect(busView()).not.toContain(TREND)
  })

  it('renders the full stack from a snapshot alone, which is how a remembered session arrives', () => {
    // Both radios idle and a battery in hand: `linkPhase` reads the snapshot, not the link state,
    // so the page is as complete as a live pack's — minus the solar the snapshot never held.
    useTelemetry().battery.value = battery()

    const text = busView()

    expect(text).toContain(AMMETER)
    expect(text).toContain(FLOW)
    for (const instrument of PACK_INSTRUMENTS) expect(text).toContain(instrument)
    expect(text).not.toContain(LANDING)
    expect(text).toContain('needs the solar controller')
  })
})
