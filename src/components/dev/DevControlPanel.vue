<script setup lang="ts">
/**
 * The clickable half of the fake: one control for every state of this dashboard that otherwise
 * needs a boat, a pack refusing a connection, or a radio switched off at the right moment.
 *
 * It holds no behaviour of its own. Every control calls a method on the playback controller or on
 * telemetry, because each of these states also has to be reachable from a spec with no DOM to click
 * on — a lever written into a click handler is a lever a spec cannot pull.
 *
 * It mounts as an application of its own, above every layer of the dashboard rather than inside it.
 * The shell marks its workspace inert while the mobile drawer is open and locks the document's
 * scroll behind it, so a panel living in that tree would go dead, and stay unscrollable, exactly
 * when it is most wanted.
 *
 * The rejections these controls arm are built when a control is used, never where they are
 * declared. An Error captures its stack at construction, and a panel whose failures all trace back
 * to this file's own top level says nothing about which lever produced one.
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'

import DevControlGroup from './DevControlGroup.vue'
import {
  dropViewedSession,
  fillSampleCounterToNearCapacity,
  seedFakeArchive,
  wipeFakeArchive,
} from './seedFakeArchive'
import { useHistoryBrowser } from '../../application/history/historyBrowser'
import type { HistoryStore, HistoryUnavailableReason } from '../../application/history/port'
import { loadAdvertisementKey } from '../../application/storage'
import { useTelemetry } from '../../application/telemetry'
import type { ChargeState } from '../../domain/solar/types'
import type { BleCapabilities } from '../../infrastructure/ble/capabilities'
import { fakeRadioController } from '../../infrastructure/ble/fake/fakeDeps'

/** One position of a lever. Null is the lever off, with the recording's own figure showing. */
interface LeverStep {
  readonly label: string
  readonly value: number | null
}

/** A switch. Null leaves whatever the recording says about it alone. */
interface SwitchStep {
  readonly label: string
  readonly value: boolean | null
}

interface CapabilityRow {
  readonly name: keyof BleCapabilities
  readonly label: string
  /** Why a fake radio decides this by itself, so a later reader does not add a second control. */
  readonly inert?: string
}

/** How the next attempt settles. Null is the one that succeeds. */
interface AttemptOutcome {
  readonly label: string
  readonly reject: (() => Error) | null
}

/** One armed answer, named for the sentence the app ends up printing about it. */
interface ArmedAnswer {
  readonly label: string
  readonly arm: () => void
}

const CAPABILITY_ROWS: readonly CapabilityRow[] = [
  { name: 'hasBluetooth', label: 'hasBluetooth' },
  { name: 'secureContext', label: 'secureContext' },
  { name: 'canConnect', label: 'canConnect' },
  { name: 'canReconnect', label: 'canReconnect' },
  { name: 'canScan', label: 'canScan', inert: 'playback bypasses the transport choice' },
  {
    name: 'canWatchAdvertisements',
    label: 'canWatchAdvertisements',
    inert: 'playback bypasses the transport choice',
  },
  { name: 'scanKnownSilent', label: 'scanKnownSilent', inert: 'nothing on the fake path reads it' },
  { name: 'canListenSolar', label: 'canListenSolar' },
  { name: 'hasSubtleCrypto', label: 'hasSubtleCrypto' },
]

const ADAPTER_STATES: readonly SwitchStep[] = [
  { label: 'on', value: true },
  { label: 'off', value: false },
  { label: 'unknown', value: null },
]

const PLAYBACK_SPEEDS: readonly number[] = [0.5, 1, 4]

const CELL_SPREAD_STEPS: readonly LeverStep[] = [
  { label: 'as recorded', value: null },
  { label: '12 mV — over the pack’s own balance trigger', value: 12 },
  { label: '60 mV — serious', value: 60 },
]

/**
 * What the lever puts on one cell's path, which is not what the fit reads back: the figure lands on
 * top of whatever path resistance the recording underneath already carries.
 *
 * Measured over the committed recording with the lever off, read out of the app's own fault list:
 * the float afternoon fits 0.0 mΩ and raises nothing, while the discharge fits between 2.9 and
 * 3.6 mΩ depending on how far into it the fit is read — straddling the three the alarm calls a loose
 * joint, before this lever is touched at all. So a step says what it adds and claims only the verdict
 * both recordings agreed on: 4 measured a warning over float and either a warning or serious over
 * discharge, and 8 measured serious over both.
 */
const PATH_RESISTANCE_STEPS: readonly LeverStep[] = [
  { label: 'as recorded', value: null },
  { label: '+4 mΩ — a warning at the least', value: 4 },
  { label: '+8 mΩ — serious', value: 8 },
]

const MOSFET_TEMPERATURE_STEPS: readonly LeverStep[] = [
  { label: 'as recorded', value: null },
  { label: '60 °C — warm', value: 60 },
  { label: '75 °C — hot', value: 75 },
  { label: '85 °C — over temperature', value: 85 },
]

const CELL_TEMPERATURE_STEPS: readonly LeverStep[] = [
  { label: 'as recorded', value: null },
  { label: '48 °C — cells warm', value: 48 },
]

const MOSFET_STATES: readonly SwitchStep[] = [
  { label: 'as recorded', value: null },
  { label: 'on', value: true },
  { label: 'off', value: false },
]

const STATE_OF_CHARGE_STEPS: readonly LeverStep[] = [
  { label: 'as recorded', value: null },
  { label: '100 %', value: 100 },
  { label: '60 %', value: 60 },
  { label: '20 % — the low mark', value: 20 },
  { label: '5 %', value: 5 },
]

const CHARGER_ERROR_STEPS: readonly LeverStep[] = [
  { label: 'none, as recorded', value: null },
  { label: '2 — battery voltage too high', value: 2 },
  { label: '17 — controller too hot', value: 17 },
  { label: '33 — input voltage too high', value: 33 },
]

/** Four of these are outside the stepper's own list, which draws them in a branch of its own. */
const CHARGE_STATE_NAMES: readonly ChargeState[] = [
  'off',
  'fault',
  'bulk',
  'absorption',
  'float',
  'equalize',
  'starting',
  'unknown',
]

const LOAD_CURRENT_STEPS: readonly LeverStep[] = [
  { label: 'none, as recorded', value: null },
  { label: '3.5 A on the load output', value: 3.5 },
]

const BUS_VOLTAGE_STEPS: readonly LeverStep[] = [
  { label: 'agrees, as recorded', value: null },
  { label: '+0.5 V — past the agreement tolerance', value: 0.5 },
  { label: '−0.5 V', value: -0.5 },
]

const HOUSE_LOAD_STEPS: readonly LeverStep[] = [
  { label: 'as recorded', value: null },
  { label: '20 A off the controller — an implausible house load', value: 20 },
]

const SIGNAL_STEPS: readonly LeverStep[] = [
  { label: 'as recorded', value: null },
  { label: '0 dBm — no signal line at all', value: 0 },
]

const ATTEMPT_DWELLS: readonly LeverStep[] = [
  { label: 'settles at once', value: 0 },
  { label: 'holds for 5 s', value: 5000 },
]

const STORED_LOG_DWELLS: readonly LeverStep[] = [
  { label: 'answers at once', value: 0 },
  { label: 'answers after 8 s', value: 8000 },
]

const SWEEP_DWELLS: readonly LeverStep[] = [
  { label: 'answers at once', value: 0 },
  { label: 'answers after 20 s', value: 20_000 },
]

const CLOCK_STEPS: readonly LeverStep[] = [
  { label: 'the real wall clock', value: 0 },
  { label: '+25 hours — every stored ring goes stale', value: 25 },
  { label: '−25 hours', value: -25 },
]

const ARCHIVE_FAILURES: readonly HistoryUnavailableReason[] = [
  'no-indexeddb',
  'open-denied',
  'open-blocked',
  'version-newer',
  'quota-exhausted',
]

/** The app prints a model id back as hex and reads nothing else out of it, so any id will do. */
const DEMO_SOLAR_MODEL_ID = 0xa060

const controller = fakeRadioController()
const telemetry = useTelemetry()
const log = useHistoryBrowser()

const panelOpen = ref(false)

/**
 * Playback and the overrides both live outside Vue, so they are mirrored here off the controller's
 * own announcement. It announces on a control and on a lap and deliberately not on a frame, which
 * is what keeps this panel off the render path of the instruments it exists to watch.
 */
const playback = shallowRef(controller.state)
const nextLoadCapabilities = shallowRef(mergedCapabilities())

function mergedCapabilities(): BleCapabilities {
  return { ...controller.bleEnvironment.capabilities, ...controller.capabilityOverrides }
}

const stopWatchingController = controller.onChange(() => {
  playback.value = controller.state
  nextLoadCapabilities.value = mergedCapabilities()
})
onBeforeUnmount(stopWatchingController)

/** Nothing is handed over while both radios are down, so a transport control has to say so. */
const playbackWord = computed(() => {
  if (!playback.value.running) return 'stopped — no radio is up'
  return playback.value.paused ? 'paused' : 'running'
})

function overrideCapability(name: keyof BleCapabilities, event: Event): void {
  controller.overrideCapabilities({ [name]: (event.target as HTMLInputElement).checked })
}

function reload(): void {
  window.location.reload()
}

// ── the pack's link ──────────────────────────────────────────────────────────

const packAttempts: readonly AttemptOutcome[] = [
  { label: 'succeeds', reject: null },
  {
    label: 'NotFoundError — nothing offered',
    reject: () => new DOMException('No device chosen', 'NotFoundError'),
  },
  {
    label: 'NetworkError — refused or dropped',
    reject: () => new DOMException('Connection failed', 'NetworkError'),
  },
  {
    label: 'SecurityError — blocked by the browser',
    reject: () => new DOMException('Blocked by the browser', 'SecurityError'),
  },
  {
    label: 'NotSupportedError — no Web Bluetooth here',
    reject: () => new DOMException('Unsupported', 'NotSupportedError'),
  },
  {
    label: 'AbortError — silent, no banner at all',
    reject: () => new DOMException('Aborted', 'AbortError'),
  },
  {
    label: 'plain Error — its own message reaches the banner',
    reject: () => new Error('The pack stopped answering during the handshake.'),
  },
]

const packAttempt = shallowRef<AttemptOutcome>(packAttempts[0])
watch(packAttempt, (outcome) => controller.failPackConnectWith(outcome.reject?.() ?? null))

const packReattempt = shallowRef<AttemptOutcome>(packAttempts[0])
watch(packReattempt, (outcome) => controller.failPackReconnectWith(outcome.reject?.() ?? null))

const packAttemptDwellMs = ref(0)
watch(packAttemptDwellMs, (dwellMs) => controller.holdPackAttemptFor(dwellMs))

const holdAtFirstFrame = ref(false)
watch(holdAtFirstFrame, (hold) => controller.holdAtFirstFrame(hold))

const packIdentity = ref<'named' | 'anonymous'>('named')
watch(packIdentity, (identity) => controller.usePackIdentity(identity))

function reportPackFrameError(): void {
  controller.reportPackFrameError(new Error('A frame from the pack would not decode.'))
}

// ── the controller's link ────────────────────────────────────────────────────

const solarStarts: readonly AttemptOutcome[] = [
  { label: 'succeeds', reject: null },
  {
    label: 'NotAllowedError — the scan was declined',
    reject: () => new DOMException('Scan declined', 'NotAllowedError'),
  },
  {
    label: 'AbortError — silent, no banner at all',
    reject: () => new DOMException('Aborted', 'AbortError'),
  },
  {
    label: 'plain Error — its own message reaches the banner',
    reject: () => new Error('The radio would not start a scan.'),
  },
]

const solarStart = shallowRef<AttemptOutcome>(solarStarts[0])
watch(solarStart, (outcome) => controller.failSolarStartWith(outcome.reject?.() ?? null))

const solarStartDwellMs = ref(0)
watch(solarStartDwellMs, (dwellMs) => controller.holdSolarStartFor(dwellMs))

function startSolar(): void {
  void telemetry.startSolar(loadAdvertisementKey())
}

function reportSolarError(): void {
  controller.reportSolarError(new Error('The advertisement would not decrypt.'))
}

// ── what the radios report ───────────────────────────────────────────────────

const cellSpreadMv = ref<number | null>(null)
watch(cellSpreadMv, (millivolts) => controller.setCellSpreadMv(millivolts))

const pathResistanceMilliohms = ref<number | null>(null)
watch(pathResistanceMilliohms, (milliohms) => controller.setCellPathResistanceMilliohms(milliohms))

const mosfetTemperature = ref<number | null>(null)
watch(mosfetTemperature, (celsius) => controller.setMosfetTemperature(celsius))

const cellTemperature = ref<number | null>(null)
watch(cellTemperature, (celsius) => controller.setCellTemperature(celsius))

const chargeMosfetOn = ref<boolean | null>(null)
watch(chargeMosfetOn, (on) => controller.setChargeMosfet(on))

const dischargeMosfetOn = ref<boolean | null>(null)
watch(dischargeMosfetOn, (on) => controller.setDischargeMosfet(on))

const stateOfCharge = ref<number | null>(null)
watch(stateOfCharge, (percent) => controller.setStateOfCharge(percent))

const chargerError = ref<number | null>(null)
watch(chargerError, (code) => controller.setChargerError(code))

const chargeState = ref<ChargeState | null>(null)
watch(chargeState, (state) => controller.setChargeState(state))

const loadCurrent = ref<number | null>(null)
watch(loadCurrent, (amps) => controller.setLoadCurrent(amps))

const measurementsBlanked = ref(false)
watch(measurementsBlanked, (blank) => controller.blankSolarMeasurements(blank))

const busVoltageOffset = ref<number | null>(null)
watch(busVoltageOffset, (volts) => controller.setBusVoltageOffset(volts))

const houseLoadOffset = ref<number | null>(null)
watch(houseLoadOffset, (amps) => controller.setHouseLoadOffsetAmps(amps))

const solarRssi = ref<number | null>(null)
watch(solarRssi, (rssi) => controller.setSolarRssi(rssi))

// ── what the radios answer a read with ───────────────────────────────────────

const storedLogAnswers: readonly ArmedAnswer[] = [
  {
    label: 'the whole earlier read — 836 records',
    arm: () => controller.answerStoredLogWithWholeRing('earlier'),
  },
  {
    label: 'the whole later read — overlaps the earlier one and shifts the ring',
    arm: () => controller.answerStoredLogWithWholeRing('later'),
  },
  {
    label: 'the oldest of the earlier read — ring 0–99',
    arm: () => controller.answerStoredLogWithRingWindow('earlier', 0, 99),
  },
  {
    label: 'the newest of the later read — ring 700–808, which declares a gap',
    arm: () => controller.answerStoredLogWithRingWindow('later', 700, 808),
  },
  { label: 'a run too short to place', arm: () => controller.answerStoredLogWithShortRun() },
  { label: 'silence', arm: () => controller.answerStoredLogWithSilence() },
  { label: 'a torn burst', arm: () => controller.answerStoredLogWithTornBurst() },
  {
    label: 'frames that are not a stored log',
    arm: () => controller.answerStoredLogWithForeignFrames(),
  },
  {
    label: 'a rejection — no link to read over',
    arm: () => controller.rejectStoredLogRead(new Error('The pack is not connected.')),
  },
]

const storedLogAnswer = shallowRef<ArmedAnswer>(storedLogAnswers[0])
watch(storedLogAnswer, (answer) => answer.arm())

const storedLogDwellMs = ref(0)
watch(storedLogDwellMs, (dwellMs) => controller.holdStoredLogRead(dwellMs))

const sweepAnswers: readonly ArmedAnswer[] = [
  {
    label: 'the whole history — the totals and 31 days',
    arm: () => controller.answerSweepWithWholeHistory(),
  },
  {
    label: 'the same afternoon, further along — sweep the whole history first',
    arm: () => controller.answerSweepWithRevisedToday(),
  },
  { label: 'days that were never written', arm: () => controller.answerSweepWithUnwrittenDays() },
  { label: 'the totals, then nothing', arm: () => controller.answerSweepWithTotalsOnly() },
  { label: 'a refusal on the first register', arm: () => controller.answerSweepWithRefusal() },
  { label: 'silence', arm: () => controller.answerSweepWithSilence() },
  { label: 'a torn stream', arm: () => controller.answerSweepWithTornStream() },
  {
    label: 'a rejection — the tunnel would not open',
    arm: () => controller.rejectSolarHistorySweep(new Error('The controller refused the connection.')),
  },
]

const sweepAnswer = shallowRef<ArmedAnswer>(sweepAnswers[0])
watch(sweepAnswer, (answer) => answer.arm())

const sweepDwellMs = ref(0)
watch(sweepDwellMs, (dwellMs) => controller.holdSolarHistorySweep(dwellMs))

// ── source, clock and archive ────────────────────────────────────────────────

function browseNewestSession(): void {
  const newest = log.sessions.value[0]
  if (newest !== undefined) telemetry.browseSession(newest.record)
}

const clockOffsetHours = ref(0)
watch(clockOffsetHours, (hours) => controller.ageClockByHours(hours))

const archiveFailure = ref<HistoryUnavailableReason | null>(null)
watch(archiveFailure, (reason) => controller.failArchiveWith(reason))

const archiveCallsFail = ref(false)
watch(archiveCallsFail, (failing) => controller.failEveryArchiveCall(failing))

/**
 * The archive being here and turning rows away, which is a different page from the archive being
 * gone: reads keep working, so nothing is blocked, and the recorder is left holding a session it
 * cannot write to. A rejected write is swallowed and retried, so only this one reaches the plate's
 * line about the log not being writable.
 */
const archiveRefusesWrites = ref(false)
watch(archiveRefusesWrites, (refusing) => controller.refuseArchiveWrites(refusing))

/**
 * What the last archive control stopped on, and null while none has.
 *
 * Each of these three reaches disk, and each can be refused there: a fixture chunk that will not
 * fetch, a database another tab is holding, a browser out of room halfway through a seeding. A
 * click handler that hands its promise back to the framework hands the rejection to nobody, so
 * without this a seeding that wrote two sessions and stopped leaves the button looking exactly like
 * a seeding that finished.
 */
const archiveControlFailure = ref<string | null>(null)

/** Runs one archive control, keeping whatever stopped it where the panel can print it. */
function runArchiveControl(control: () => Promise<void>): void {
  archiveControlFailure.value = null
  void control().catch((failure: unknown) => {
    archiveControlFailure.value = failure instanceof Error ? failure.message : String(failure)
  })
}

/**
 * The real archive, never whichever store a failure lever has switched in front of it: seeding
 * through a store that answers every write with a reason would report success and write nothing.
 * Null only until the storage probe answers, which settles long before anyone opens this.
 */
function openedArchive(): HistoryStore {
  const archive = controller.archive
  if (archive === null) throw new Error('The archive has not opened yet.')
  return archive
}

function seedArchive(): void {
  runArchiveControl(async () => {
    await seedFakeArchive(openedArchive(), controller.now())
  })
}

/**
 * Deletes whichever stored session is open, while the view is still holding it.
 *
 * Pressed with nothing open it fails, and that is the whole of its input validation: the failure
 * line above says so, which is a better answer than a button that quietly does nothing.
 */
function dropSessionOnScreen(): void {
  runArchiveControl(() => dropViewedSession(openedArchive(), log))
}

function fillSampleCounter(): void {
  runArchiveControl(() => fillSampleCounterToNearCapacity(controller.now()))
}

function wipeArchive(): void {
  runArchiveControl(async () => {
    await wipeFakeArchive(openedArchive())
  })
}
</script>

<template>
  <div class="dev-root">
    <button
      v-if="!panelOpen"
      type="button"
      class="tab"
      aria-label="Open the fake radio controls"
      @click="panelOpen = true"
    >
      Fake
    </button>

    <section v-else class="panel" aria-label="Fake radio controls">
      <header class="bar">
        <h1 class="plate title">Fake radios</h1>
        <button type="button" class="ghost" @click="panelOpen = false">Hide</button>
      </header>

      <div class="playback">
        <div class="actions">
          <button
            v-for="scenario in controller.scenarios"
            :key="scenario.name"
            type="button"
            :class="{ on: playback.scenario === scenario.name }"
            :title="scenario.note"
            @click="controller.playScenario(scenario.name)"
          >
            {{ scenario.title }}
          </button>
        </div>

        <div class="actions">
          <button
            type="button"
            :disabled="!playback.running"
            @click="playback.paused ? controller.resumePlayback() : controller.pausePlayback()"
          >
            {{ playback.paused ? 'Resume' : 'Pause' }}
          </button>
          <button type="button" :disabled="!playback.running" @click="controller.stepPlayback()">
            Step
          </button>
          <button
            v-for="multiplier in PLAYBACK_SPEEDS"
            :key="multiplier"
            type="button"
            :class="{ on: playback.speed === multiplier }"
            @click="controller.setSpeed(multiplier)"
          >
            {{ multiplier }}×
          </button>
        </div>

        <p class="readout state">
          {{ playback.delivered }} / {{ playback.total }} · lap {{ playback.laps + 1 }} ·
          {{ playbackWord }}
        </p>

        <!--
          A recording that never arrived reads exactly like a fake nobody has connected yet: no
          frames, no scenario, the same stopped line above. So it is said here rather than left to
          the console, where it scrolls away behind whatever the page logged next.
        -->
        <p v-if="playback.recordingFailure" class="readout silent">
          No recording to play — {{ playback.recordingFailure }}
        </p>

        <!--
          Up here beside it rather than down in the archive group, which is a fold that starts
          closed. A seeding that stopped halfway leaves a log that looks seeded, and nobody opens a
          group to find out that it is not.
        -->
        <p v-if="archiveControlFailure" class="readout silent">
          The archive control failed — {{ archiveControlFailure }}
        </p>
      </div>

      <div class="groups">
        <DevControlGroup
          title="Capabilities"
          note="Reload to apply — the app reads these once and paints them. The adapter below is live, as it is on real hardware."
        >
          <label v-for="row in CAPABILITY_ROWS" :key="row.name" class="toggle">
            <input
              type="checkbox"
              :checked="nextLoadCapabilities[row.name]"
              @change="overrideCapability(row.name, $event)"
            />
            <span>
              {{ row.label }}
              <em v-if="row.inert" class="inert">inert — {{ row.inert }}</em>
            </span>
          </label>

          <div class="actions">
            <button type="button" @click="controller.clearCapabilityOverrides()">
              Clear overrides
            </button>
            <button type="button" @click="reload()">Reload</button>
          </div>

          <div class="row">
            <span class="label">Adapter — live</span>
            <div class="actions">
              <button
                v-for="state in ADAPTER_STATES"
                :key="String(state.value)"
                type="button"
                :class="{ on: telemetry.adapterOn.value === state.value }"
                @click="controller.pushAdapter(state.value)"
              >
                {{ state.label }}
              </button>
            </div>
          </div>

          <div class="actions">
            <button type="button" @click="controller.seedLastDevice()">Remember a last pack</button>
            <button type="button" @click="controller.clearLastDevice()">Forget it</button>
          </div>
        </DevControlGroup>

        <DevControlGroup title="Pack link">
          <label class="row">
            <span class="label">The next connection</span>
            <select v-model="packAttempt">
              <option v-for="outcome in packAttempts" :key="outcome.label" :value="outcome">
                {{ outcome.label }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">The next silent reconnect</span>
            <select v-model="packReattempt">
              <option v-for="outcome in packAttempts" :key="outcome.label" :value="outcome">
                {{ outcome.label }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">The attempt</span>
            <select v-model="packAttemptDwellMs">
              <option v-for="step in ATTEMPT_DWELLS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>

          <label class="toggle">
            <input v-model="holdAtFirstFrame" type="checkbox" />
            <span>Hold at the first frame — connected, nothing said yet</span>
          </label>

          <div class="actions">
            <button type="button" @click="telemetry.connectBms()">Connect</button>
            <button type="button" @click="telemetry.reconnectBms()">Reconnect</button>
            <button type="button" @click="telemetry.disconnectBms()">Disconnect</button>
          </div>

          <div class="actions">
            <button type="button" @click="controller.dropPack()">Drop the link</button>
            <button type="button" @click="controller.stallPack()">Stall it</button>
            <button type="button" @click="controller.dropDuringNextAttempt()">
              Drop inside the next attempt
            </button>
            <button type="button" @click="reportPackFrameError()">A frame that will not decode</button>
          </div>

          <label class="row">
            <span class="label">What the pack calls itself</span>
            <select v-model="packIdentity">
              <option value="named">named — a serial and a device name</option>
              <option value="anonymous">anonymous — nothing to file it under</option>
            </select>
          </label>

          <div class="actions">
            <button type="button" @click="controller.emitPackSettings()">Send its settings</button>
            <button type="button" @click="controller.emitPackLogbook()">Send its event log</button>
          </div>
        </DevControlGroup>

        <DevControlGroup title="Solar link">
          <label class="row">
            <span class="label">The next start</span>
            <select v-model="solarStart">
              <option v-for="outcome in solarStarts" :key="outcome.label" :value="outcome">
                {{ outcome.label }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">The start</span>
            <select v-model="solarStartDwellMs">
              <option v-for="step in ATTEMPT_DWELLS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>

          <div class="actions">
            <button type="button" @click="startSolar()">Start listening</button>
            <button type="button" @click="telemetry.stopSolar()">Stop</button>
          </div>

          <div class="actions">
            <button type="button" @click="controller.emitSolarStale()">Advertisements stop</button>
            <button type="button" @click="controller.emitForeignDevice()">
              Another Victron device answers
            </button>
            <button type="button" @click="controller.emitSolarIdentity(DEMO_SOLAR_MODEL_ID)">
              Announce its model id
            </button>
            <button type="button" @click="reportSolarError()">A reading that will not decrypt</button>
          </div>

          <div class="actions">
            <button type="button" @click="controller.seedAdvertisementKey()">Seed a key</button>
            <button type="button" @click="controller.clearAdvertisementKey()">Clear the key</button>
          </div>
        </DevControlGroup>

        <DevControlGroup
          title="Pack values"
          note="Each lever is a pure function over the frame on its way out; the recording itself is never edited."
        >
          <label class="row">
            <span class="label">Cell spread</span>
            <select v-model="cellSpreadMv">
              <option v-for="step in CELL_SPREAD_STEPS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">Path resistance on one cell — added to what the recording carries</span>
            <select v-model="pathResistanceMilliohms">
              <option v-for="step in PATH_RESISTANCE_STEPS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">MOSFET temperature</span>
            <select v-model="mosfetTemperature">
              <option v-for="step in MOSFET_TEMPERATURE_STEPS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">Cell temperature</span>
            <select v-model="cellTemperature">
              <option v-for="step in CELL_TEMPERATURE_STEPS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">Charge MOSFET</span>
            <select v-model="chargeMosfetOn">
              <option v-for="state in MOSFET_STATES" :key="state.label" :value="state.value">
                {{ state.label }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">Discharge MOSFET</span>
            <select v-model="dischargeMosfetOn">
              <option v-for="state in MOSFET_STATES" :key="state.label" :value="state.value">
                {{ state.label }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">State of charge</span>
            <select v-model="stateOfCharge">
              <option v-for="step in STATE_OF_CHARGE_STEPS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>
        </DevControlGroup>

        <DevControlGroup title="Solar values">
          <label class="row">
            <span class="label">Charger error</span>
            <select v-model="chargerError">
              <option v-for="step in CHARGER_ERROR_STEPS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">Charge stage</span>
            <select v-model="chargeState">
              <option :value="null">as recorded</option>
              <option v-for="state in CHARGE_STATE_NAMES" :key="state" :value="state">
                {{ state }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">Load output</span>
            <select v-model="loadCurrent">
              <option v-for="step in LOAD_CURRENT_STEPS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>

          <label class="toggle">
            <input v-model="measurementsBlanked" type="checkbox" />
            <span>Blank the measurements — no bus view, no house load</span>
          </label>

          <label class="row">
            <span class="label">Bus voltage against the pack’s</span>
            <select v-model="busVoltageOffset">
              <option v-for="step in BUS_VOLTAGE_STEPS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">House load</span>
            <select v-model="houseLoadOffset">
              <option v-for="step in HOUSE_LOAD_STEPS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">Signal</span>
            <select v-model="solarRssi">
              <option v-for="step in SIGNAL_STEPS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>
        </DevControlGroup>

        <DevControlGroup
          title="Stored log"
          note="The whole earlier read is armed from the start, so the automatic read on the first connection files 836 records without anyone asking. File the earlier read and then the later one for an overlap; file the two windows in turn for a gap."
        >
          <label class="row">
            <span class="label">The pack answers with</span>
            <select v-model="storedLogAnswer">
              <option v-for="answer in storedLogAnswers" :key="answer.label" :value="answer">
                {{ answer.label }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">It</span>
            <select v-model="storedLogDwellMs">
              <option v-for="step in STORED_LOG_DWELLS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>

          <div class="actions">
            <button type="button" @click="telemetry.readDetailLog()">Read the log</button>
          </div>
        </DevControlGroup>

        <DevControlGroup
          title="Stored solar history"
          note="Filing is a comparison, so what a sweep does depends on what is already filed: sweep the whole history once, then arm another answer and sweep again. Further along is what revises today. The whole history again, after the clock below has moved a day, redates every day held."
        >
          <label class="row">
            <span class="label">The controller answers with</span>
            <select v-model="sweepAnswer">
              <option v-for="answer in sweepAnswers" :key="answer.label" :value="answer">
                {{ answer.label }}
              </option>
            </select>
          </label>

          <label class="row">
            <span class="label">It</span>
            <select v-model="sweepDwellMs">
              <option v-for="step in SWEEP_DWELLS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>

          <div class="actions">
            <button type="button" @click="telemetry.readSolarHistory()">Sweep the history</button>
          </div>
        </DevControlGroup>

        <DevControlGroup
          title="Source and view"
          note="The clock moves only while both radios are down: a recorder running against a clock that has just jumped writes rows into the future, and the archive keeps them."
        >
          <div class="actions">
            <button
              type="button"
              :disabled="log.sessions.value.length === 0"
              @click="browseNewestSession()"
            >
              Review the newest stored session
            </button>
            <button type="button" @click="telemetry.leaveHistory()">Leave it</button>
          </div>

          <div class="actions">
            <button type="button" @click="telemetry.restoreRemembered()">Restore remembered</button>
            <button type="button" @click="telemetry.forgetRemembered()">Forget remembered</button>
          </div>

          <label class="row">
            <span class="label">The clock reads</span>
            <select v-model="clockOffsetHours" :disabled="!playback.linksIdle">
              <option v-for="step in CLOCK_STEPS" :key="step.label" :value="step.value">
                {{ step.label }}
              </option>
            </select>
          </label>
        </DevControlGroup>

        <DevControlGroup
          title="Archive"
          note="Everything playback records goes into an archive of its own, so wiping it takes nothing real with it. The seeding leaves six watches three minutes of frames cannot: one six weeks back that runs across noon and holds a chunk in a layout this build does not read, one a killed tab left open, one continuing it, one whose head pruning took, one longer than the widest window the page draws, and one that recorded no sample at all. Dropping needs a stored session open on screen — it takes that one away underneath the view. One state has no control here and cannot have one: the recording lease is a real Web Lock, so open a second playback tab to see the plate report that another tab is keeping the log. It has to be a playback tab — the lease carries the same suffix everything else playback writes does, so the real page never contends with this one for it."
        >
          <label class="row">
            <span class="label">The archive is</span>
            <select v-model="archiveFailure">
              <option :value="null">open and working</option>
              <option v-for="reason in ARCHIVE_FAILURES" :key="reason" :value="reason">
                unavailable — {{ reason }}
              </option>
            </select>
          </label>

          <label class="toggle">
            <input v-model="archiveCallsFail" type="checkbox" />
            <span>Every read and write rejects — moot while it is unavailable above</span>
          </label>

          <label class="toggle">
            <input v-model="archiveRefusesWrites" type="checkbox" />
            <span>Here and reading, and turning every row away — moot while either of those is set</span>
          </label>

          <div class="actions">
            <button type="button" @click="seedArchive()">Seed rows playback cannot reach</button>
            <button type="button" @click="dropSessionOnScreen()">Drop the session on screen</button>
            <button type="button" @click="fillSampleCounter()">
              Near the limit — written around the port
            </button>
            <button type="button" @click="wipeArchive()">Wipe it</button>
          </div>
        </DevControlGroup>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* Not styling: the build greps dist/ for this string, and a custom property survives minification
   where a comment would not. `tests/devPanelMarker.spec.ts` holds the literal to the spelling
   `scripts/support/fakeMarker.mjs` declares. */
.dev-root {
  --fake-marker: 'FAKE-BLE-ONLY-DO-NOT-SHIP';

  position: fixed;
  right: 1rem;
  bottom: 1rem;
  /* Above the header at 50, the drawer's scrim at 55 and the drawer itself at 60. */
  z-index: 70;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-family: var(--font-body);
  color: var(--ink);
}

.tab {
  min-width: var(--tap);
  min-height: var(--tap);
  padding: 0 0.9rem;
  background: var(--raised);
  border: 1px solid var(--card-border);
  border-radius: var(--r-pill);
  box-shadow: var(--shadow-2);
  color: var(--ink-secondary);
  font-family: var(--font-label);
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.panel {
  display: flex;
  flex-direction: column;
  width: min(26rem, calc(100vw - 2rem));
  /* Its own height, so the panel never depends on the page scrolling — the shell locks the
     document behind the mobile drawer, which is one of the states this panel has to reach. */
  max-height: min(34rem, calc(100vh - 2rem));
  background: var(--surface);
  border: 1px solid var(--card-border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
  overflow: hidden;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--gridline);
}

.title {
  margin: 0;
  font-size: 0.8125rem;
}

.playback {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.6rem;
  border-bottom: 1px solid var(--gridline);
}

.state {
  margin: 0;
  font-size: 0.75rem;
  color: var(--ink-muted);
}

.silent {
  margin: 0;
  font-size: 0.75rem;
  color: var(--status-critical-ink);
}

.groups {
  /* The one scrolling box on the panel. */
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 0.6rem 0.6rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

button {
  min-height: var(--tap);
  padding: 0 0.7rem;
  background: transparent;
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  color: var(--ink);
  font-family: var(--font-label);
  font-size: 0.75rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  font-weight: 600;
}

button:hover:not(:disabled) {
  border-color: var(--ink-secondary);
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

button.on {
  background: var(--raised);
  border-color: var(--ink-secondary);
  color: var(--ink);
}

button.ghost {
  min-height: auto;
  padding: 0.35rem 0.6rem;
  color: var(--ink-secondary);
}

.row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.label {
  font-family: var(--font-label);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
}

select {
  width: 100%;
  min-height: var(--tap);
  padding: 0 0.5rem;
  background: var(--raised);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 0.8125rem;
}

select:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

select:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}

.toggle {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  min-height: var(--tap);
  font-size: 0.8125rem;
  color: var(--ink-secondary);
}

.toggle input {
  margin-top: 0.85rem;
}

.inert {
  display: block;
  font-style: normal;
  font-size: 0.6875rem;
  color: var(--ink-muted);
}

/* A phone: the panel takes the bottom of the screen, and collapsed it is one tap target and
   nothing else. */
@media (max-width: 480px) {
  .dev-root {
    right: 0;
    bottom: 0;
    left: 0;
    align-items: flex-end;
    padding: 0.75rem;
  }

  .panel {
    width: 100%;
    max-height: 75vh;
  }
}
</style>
