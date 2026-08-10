/**
 * The one place the playback JSON is read.
 *
 * Everything else takes a `PlaybackFixture`, which keeps two things true at once: the generated
 * file has exactly one importer to repoint if it ever moves, and the fake stays behind a single
 * module boundary that a production build drops on the floor whole.
 *
 * Fetched on the first ask rather than imported, and then kept. The flag that decides whether any
 * of this plays folds when a build is made, and a development server makes no build — it compiles
 * what it serves, so a static import here would put half a megabyte of recording on the first paint
 * of the real page as well as the fake one, which is the page that is opened over a phone tether.
 *
 * The conversion is not ceremony. TypeScript types a string in a JSON file as `string`, so the two
 * fields that are unions on the production types — a scenario's name and a reading's charge state —
 * arrive too wide, and asserting the whole file into shape would hand the rest of the fake a
 * `ChargeState` the fixture never contained. They are checked instead, once, on the way in.
 * Nothing else is converted: the snapshots are numbers and booleans and go through by reference, so
 * a scenario's eight hundred frames are not copied to satisfy the type checker.
 *
 * A throw here means the committed file was edited by hand rather than regenerated. The generator
 * refuses to write anything that could reach one.
 */

import { CHARGE_STATES } from '../../../../domain/solar/types'
import type { ChargeState } from '../../../../domain/solar/types'
import type { PlaybackFixture } from './PlaybackFixture'
import type { PlaybackScenario } from './PlaybackScenario'
import type { ScenarioName } from './ScenarioName'
import type { SolarFrame } from './SolarFrame'

async function capturedFixture() {
  const recording = await import('./playbackFixture.json')
  return recording.default
}

type CapturedFixture = Awaited<ReturnType<typeof capturedFixture>>
type CapturedScenario = CapturedFixture['scenarios'][number]
type CapturedSolarFrame = CapturedScenario['solar'][number]

/** The fetch, kept, so a second caller reads the recording already in memory. */
let recording: Promise<PlaybackFixture> | null = null

const scenarioNames: readonly ScenarioName[] = ['float', 'discharge']

/** The coded states the advertisement carries, plus the one its decoder falls back to. */
const chargeStates: readonly ChargeState[] = [...Object.values(CHARGE_STATES), 'unknown']

function scenarioNameOf(name: string): ScenarioName {
  if (!scenarioNames.includes(name as ScenarioName)) {
    throw new Error(`the playback fixture names a scenario nothing can play: ${name}`)
  }
  return name as ScenarioName
}

function chargeStateOf(state: string): ChargeState {
  if (!chargeStates.includes(state as ChargeState)) {
    throw new Error(`the playback fixture carries a charge state no controller reports: ${state}`)
  }
  return state as ChargeState
}

function solarFrameOf(frame: CapturedSolarFrame): SolarFrame {
  return {
    atMs: frame.atMs,
    rssi: frame.rssi,
    reading: { ...frame.reading, chargeState: chargeStateOf(frame.reading.chargeState) },
  }
}

function scenarioOf(scenario: CapturedScenario): PlaybackScenario {
  return {
    name: scenarioNameOf(scenario.name),
    title: scenario.title,
    note: scenario.note,
    spanMs: scenario.spanMs,
    pack: scenario.pack,
    solar: scenario.solar.map(solarFrameOf),
  }
}

export function loadPlaybackFixture(): Promise<PlaybackFixture> {
  recording ??= capturedFixture().then((fixture) => ({
    note: fixture.note,
    marker: fixture.marker,
    device: fixture.device,
    settings: fixture.settings,
    logbook: fixture.logbook,
    scenarios: fixture.scenarios.map(scenarioOf),
  }))
  return recording
}
