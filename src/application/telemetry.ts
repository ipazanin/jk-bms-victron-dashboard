/**
 * The one place the two radios, the alarm engine, the remembered snapshot and the archive meet.
 *
 * It is a factory rather than a module of loose refs so that a spec can hold a whole telemetry —
 * fresh reactive state, fake radios, a Map-backed archive — and throw it away afterwards. The
 * browser gets exactly one, built from the real adapters at the bottom of this file.
 *
 * Two orderings here are load-bearing and easy to undo by accident.
 *
 * Nothing on the connect path may await before `requestDevice`: awaiting spends the click's
 * transient activation and the browser refuses the chooser. That is why `leaveRemembered`,
 * `leaveHistory` and `stopSolarLink` are synchronous, and why every recorder method returns void
 * and queues its own writes.
 *
 * And what reaches the archive is raw. `observe()` runs first so the instruments read a window,
 * but `recordSample()`, `TrendPoint` and `persistRememberedNow()` take their numbers from the
 * snapshot the radio handed over and from nowhere else. A damped, corrected or latched figure that
 * found its way into a `TrendPoint` would be indistinguishable from a measurement forever after.
 */

import { computed, reactive, readonly, ref, shallowRef, watch } from 'vue'

import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../domain/bms/types'
import { JOINT_SERIOUS, JOINT_WARNING } from '../domain/cellBalance'
import { reconcile } from '../domain/dcBus'
import { solarDeviceKeyFor } from '../domain/history/identity'
import type { DeviceKey, SessionEndReason, SessionRecord } from '../domain/history/types'
import { SNAPSHOT_SCHEMA_VERSION } from '../domain/schemaVersion'
import type { SolarReading } from '../domain/solar/types'
import { adapterAvailable, detectCapabilities, watchAdapter } from '../infrastructure/ble/capabilities'
import { JkBmsClient } from '../infrastructure/ble/JkBmsClient'
import type { BmsLink, JkBmsHandlers } from '../infrastructure/ble/JkBmsClient'
import { VictronScanner } from '../infrastructure/ble/VictronScanner'
import type { SolarScan, VictronHandlers } from '../infrastructure/ble/VictronScanner'
import { describeConnectError, describeScanError } from './errors'
import { amps } from './format'
import type { HistoryStore } from './history/port'
import { SessionRecorder } from './history/SessionRecorder'
import type { PackStreamEndReason, RecorderState } from './history/SessionRecorder'
import { createObservations } from './observations'
import {
  REMEMBERED_SCHEMA_VERSION,
  forgetRememberedSession,
  loadRememberedSession,
  saveRememberedSession,
} from './rememberedSession'
import type { RememberedStatus } from './rememberedSession'
import { worstOf, type FaultLevel } from './severity'
import { saveAdvertisementKey } from './storage'

export type LinkState = 'idle' | 'connecting' | 'listening' | 'live' | 'error'

/**
 * What the numbers on the instruments *are*, which is not the same question as what the user is
 * looking at. Every write guard in this file keys off it, so a browsed session cannot overwrite
 * the remembered snapshot and cannot be recorded as if it were happening now.
 */
export type Source = 'none' | 'live' | 'remembered' | 'history'
export type { FaultLevel }

export interface Fault {
  readonly level: FaultLevel
  readonly title: string
  readonly detail: string
}

export interface TrendPoint {
  readonly at: number
  readonly packCurrent: number
  readonly pvPower: number | null
  readonly housePower: number | null
}

export interface TelemetryDeps {
  /** Factories, not instances: the handlers have to be bound before the radio exists. */
  readonly createBmsLink: (handlers: JkBmsHandlers) => BmsLink
  readonly createSolarScan: (handlers: VictronHandlers) => SolarScan
  /** Lazy: the archive is probed asynchronously and may answer that it cannot be had. */
  readonly historyStore: () => HistoryStore | null
  readonly now: () => number
  readonly monotonic: () => number
  readonly newId: () => string
}

const HISTORY_SECONDS = 600
const SAMPLE_INTERVAL_MS = 1000

/** Volts of cell spread, and only a default: the BMS's own balance trigger wins when it reports one. */
const SPREAD_WARNING = 0.01
const SPREAD_SERIOUS = 0.05
const MOSFET_WARNING = 55
const MOSFET_SERIOUS = 70
const MOSFET_CRITICAL = 80
const CELL_TEMPERATURE_WARNING = 45
const LOW_STATE_OF_CHARGE = 20

/** At most one write every fifteen samples; snapshots arrive roughly once a second. */
const WRITE_THROTTLE_MS = 15_000

export function createTelemetry(deps: TelemetryDeps) {
  const now = deps.now
  const capabilities = detectCapabilities()

  /** null until the browser answers, and again if it refuses to. */
  const adapterOn = ref<boolean | null>(null)
  let stopWatchingAdapter: (() => void) | null = null
  if (capabilities.hasBluetooth) {
    void adapterAvailable()
      .then((value) => (adapterOn.value = value))
      .catch(() => undefined)
    stopWatchingAdapter = watchAdapter((value) => (adapterOn.value = value))
  }

  const source = ref<Source>('none')
  const bmsState = ref<LinkState>('idle')
  const solarState = ref<LinkState>('idle')
  const bmsError = ref<string | null>(null)
  const solarError = ref<string | null>(null)
  const foreignDeviceSeen = ref(false)

  const device = shallowRef<DeviceInfo | null>(null)
  const settings = shallowRef<BmsSettings | null>(null)
  const battery = shallowRef<BatterySnapshot | null>(null)
  const solar = shallowRef<SolarReading | null>(null)
  const solarRssi = ref(0)

  const history = reactive<TrendPoint[]>([])
  let lastSampleAt = 0

  /** Populated only in 'remembered' mode, from the persisted session. */
  const rememberedAt = ref<number | null>(null)
  const rememberedStatus = ref<RememberedStatus | null>(null)

  let lastWriteAt = 0
  /** Observation time of the latest battery snapshot — the honest age of remembered data. */
  let lastSnapshotAt = 0

  /** The controller's identity, learned across two events that arrive in either order. */
  let solarDeviceKey: DeviceKey | null = null
  let solarModelId: number | null = null

  const observations = createObservations()
  const faults = shallowRef<Fault[]>([])

  const bus = computed(() =>
    battery.value && solar.value ? reconcile(battery.value, solar.value) : null,
  )
  const worstFault = computed<FaultLevel>(() => worstOf(faults.value.map((fault) => fault.level)))

  const recorder = new SessionRecorder({
    store: deps.historyStore,
    clock: { now: deps.now, monotonic: deps.monotonic },
    newId: deps.newId,
    onStateChange: (state) => (recording.value = state),
  })
  const recording = shallowRef<RecorderState>(recorder.state)

  /**
   * The alarm list, rebuilt from scratch on every observation and then latched.
   *
   * It is a function and not a computed because latching, hysteresis and the off-delay are state:
   * inside a lazy cached computed the alarm would become a function of how many times Vue chose to
   * evaluate it, which varies with what is mounted. Everything time-dependent takes `at` from the
   * caller for the same reason — a clock read inside a computed is not a reactive dependency, so a
   * dwell started there could never expire.
   */
  function evaluateFaults(at: number): void {
    const found: Fault[] = []
    const snapshot = battery.value

    if (snapshot) {
      const verdict = observations.balance.value
      const triggerMv = (settings.value?.balanceTriggerDelta ?? SPREAD_WARNING) * 1000
      const spreadMv =
        verdict === null
          ? snapshot.cellDelta * 1000
          : verdict.kind === 'fitted'
            ? verdict.balanceSpreadMv
            : verdict.rawSpreadMv
      // Called once per evaluation whatever the outcome, because it advances the assert/clear latch.
      const spreadAsserted = observations.imbalanceAsserted(spreadMv, triggerMv)

      if (snapshot.cellDelta >= SPREAD_SERIOUS) {
        // Ungated and on the raw reading: fifty millivolts needs about ten milliohms of mismatch to
        // be load alone, and ten milliohms is itself worth interrupting for whatever its cause.
        found.push({
          level: 'serious',
          title: 'Cell imbalance',
          detail: `Spread ${Math.round(snapshot.cellDelta * 1000)} mV at ${amps(snapshot.current)}, cell ${snapshot.lowestCell} low. Check the balance leads.`,
        })
      } else if (spreadAsserted && verdict?.kind === 'fitted') {
        found.push({
          level: 'warning',
          title: 'Cell imbalance',
          detail: `Spread ${Math.round(verdict.balanceSpreadMv)} mV of charge divergence, cell ${verdict.lowestOffsetCell} low. The balancer should be working.`,
        })
      } else if (spreadAsserted) {
        found.push({
          level: 'warning',
          title: 'Cell imbalance',
          detail: `Spread ${Math.round(spreadMv)} mV at ${amps(snapshot.current)}, uncorrected — the load has not varied enough to separate charge divergence from path resistance.`,
        })
      }

      if (verdict?.kind === 'fitted' && verdict.jointSpread >= JOINT_WARNING) {
        // A balancer cannot touch this one: it is the wiring, not the charge.
        found.push({
          level: verdict.jointSpread >= JOINT_SERIOUS ? 'serious' : 'warning',
          title: 'Cell path resistance',
          detail: `Cell ${verdict.worstJointCell} sits ${(verdict.jointSpread * 1000).toFixed(1)} mΩ above the pack, measured across a ${observations.balanceSwingA.value.toFixed(1)} A load swing. Check its terminal and busbar.`,
        })
      }

      const mosfet = snapshot.mosfetTemperature
      if (mosfet >= MOSFET_CRITICAL) {
        found.push({ level: 'critical', title: 'MOSFET over temperature', detail: `${mosfet.toFixed(1)} °C, over limit. Reduce load or charge current.` })
      } else if (mosfet >= MOSFET_SERIOUS) {
        found.push({ level: 'serious', title: 'MOSFET hot', detail: `${mosfet.toFixed(1)} °C. Reduce load or improve ventilation.` })
      } else if (mosfet >= MOSFET_WARNING) {
        found.push({ level: 'warning', title: 'MOSFET warm', detail: `${mosfet.toFixed(1)} °C. Watch it under sustained load.` })
      }

      const hottestCell = Math.max(snapshot.temperatureSensor1, snapshot.temperatureSensor2)
      if (hottestCell >= CELL_TEMPERATURE_WARNING) {
        found.push({ level: 'warning', title: 'Cells warm', detail: `${hottestCell.toFixed(1)} °C. Ventilate the battery compartment.` })
      }

      if (!snapshot.chargingEnabled) {
        found.push({ level: 'warning', title: 'Charge MOSFET off', detail: 'Turn it on to charge the pack.' })
      }
      if (!snapshot.dischargingEnabled) {
        found.push({ level: 'warning', title: 'Discharge MOSFET off', detail: 'Turn it on to draw from the pack.' })
      }
      if (snapshot.stateOfCharge <= LOW_STATE_OF_CHARGE) {
        found.push({ level: 'warning', title: 'Low charge', detail: `${snapshot.stateOfCharge}% remaining. Charge the bank.` })
      }
    }

    const reading = solar.value
    if (reading && reading.chargerError !== 0) {
      found.push({ level: 'critical', title: 'Charger error', detail: `Error ${reading.chargerError}. Charging may be paused.` })
    }

    const reconciliation = bus.value
    if (reconciliation && !reconciliation.voltagesAgree) {
      found.push({
        level: 'warning',
        title: 'Devices disagree on bus voltage',
        detail: `${Math.abs(reconciliation.voltageDelta).toFixed(2)} V apart. Check the sense wiring before trusting the house load.`,
      })
    }

    faults.value = observations.latchFaults(found, at)
  }

  /** A claim about the fault list, which is what this computes — never a clean bill of health. */
  function currentStatus(): RememberedStatus {
    return { worst: worstFault.value, headline: faults.value[0]?.title ?? 'No active faults' }
  }

  /**
   * The single guarded write. Only genuinely live data with a battery present is ever persisted,
   * so a solar-only session and a browsed archive session both no-op here — the exclusion is
   * structural rather than a special case, and it is what stops browsing a stored session from
   * overwriting the remembered snapshot with the session being browsed. Throttled unless forced
   * on session end.
   */
  function persistRememberedNow(force = false): void {
    if (source.value !== 'live') return
    const snapshot = battery.value
    if (!snapshot) return
    const at = now()
    if (!force && at - lastWriteAt < WRITE_THROTTLE_MS) return
    lastWriteAt = at
    saveRememberedSession({
      version: REMEMBERED_SCHEMA_VERSION,
      capturedAt: lastSnapshotAt || at,
      battery: snapshot,
      solar: solar.value,
      device: device.value,
      settings: settings.value,
      solarRssi: solarRssi.value,
      status: currentStatus(),
    })
  }

  function recordSample(): void {
    const at = now()
    if (at - lastSampleAt < SAMPLE_INTERVAL_MS) return

    const snapshot = battery.value
    // A sample always pairs a pack current with the solar of that same instant, so it can only
    // be taken when a battery snapshot exists. A solar-only tick claims no interval slot.
    if (!snapshot) return
    lastSampleAt = at

    history.push({
      at,
      packCurrent: snapshot.current,
      pvPower: solar.value?.pvPower ?? null,
      // A house load that another source has poisoned is recorded as a gap, not a fabricated
      // trace, so TrendStrips shows the break rather than a line dipping below zero.
      housePower: bus.value?.houseLoadPlausible ? bus.value.housePower : null,
    })

    const cutoff = at - HISTORY_SECONDS * 1000
    while (history.length > 0 && history[0].at < cutoff) history.shift()
  }

  function applySnapshot(snapshot: BatterySnapshot): void {
    const at = now()
    battery.value = snapshot
    lastSnapshotAt = at
    observations.observe(snapshot, solar.value, at)
    evaluateFaults(at)
    recordSample()
    persistRememberedNow()
    if (source.value === 'live') recorder.notePack(snapshot)
  }

  const bmsLink = deps.createBmsLink({
    onSnapshot: applySnapshot,
    onDeviceInfo: (info) => {
      device.value = info
      recorder.identify(info, bmsLink.deviceName)
    },
    onSettings: (parsed) => {
      settings.value = parsed
      recorder.noteSettings(parsed)
    },
    onDisconnect: (reason) => {
      bmsState.value = 'idle'
      bmsError.value = 'Lost the BMS. Move closer to the boat’s panel and reconnect.'
      // One word for both vocabularies: it ends the session when nothing else is up, and only the
      // pack stream when the scan is.
      const ended = reason === 'stalled' ? 'stalled' : 'link-lost'
      settleAfterLive(ended)
      if (solarState.value !== 'idle') clearBmsView(ended)
    },
    onError: (error) => (bmsError.value = error.message),
  })

  const solarScan = deps.createSolarScan({
    onReading: (reading, rssi) => {
      const at = now()
      solar.value = reading
      solarRssi.value = rssi
      solarState.value = 'live'
      evaluateFaults(at)
      // Sample here too: a run of solar advertisements between BMS frames must still feed the
      // trend, and the SAMPLE_INTERVAL_MS gate keeps it to one point a second across both radios.
      recordSample()
      if (source.value === 'live') recorder.noteSolar(reading, rssi)
    },
    onForeignDevice: () => (foreignDeviceSeen.value = true),
    onStale: () => {
      // Advertisements have stopped: the controller slept or drifted out of range. Drop the
      // frozen reading so the derived house load disappears rather than lying, and fall back
      // to 'listening' — the scan is still up and the controller may return.
      if (solarState.value !== 'live') return
      solar.value = null
      solarState.value = 'listening'
      evaluateFaults(now())
      // Not a session end. Without it the recorder would stamp the last reading into every row
      // all night, and compute a house load against a frozen charge current.
      recorder.endSolarStream()
      recorder.checkpoint()
    },
    onIdentity: (modelId) => {
      solarModelId = modelId
      if (solarDeviceKey !== null) recorder.identifySolar(solarDeviceKey, modelId)
    },
    onError: (error) => (solarError.value = error.message),
  })

  function resetReadings(): void {
    battery.value = null
    solar.value = null
    device.value = null
    settings.value = null
    history.splice(0, history.length)
    lastSampleAt = 0
    observations.clear()
    faults.value = []
  }

  /**
   * Clears the BMS-side view while a solar scan is still live. settleAfterLive early-returns in
   * that case (solarState is not idle) so source stays 'live' — without this, a frozen battery
   * would sit under a live solar badge. The freshest frame was just force-flushed to disk, so it
   * returns as the remembered view once solar ends too: settleAfterLive's no-battery branch
   * restores it from disk. The solar refs are left untouched — that link is still reporting.
   *
   * The recorder is told before the snapshot is dropped, so the session keeps the last state it
   * saw and its coverage across the gap reads pack-less rather than pack-frozen.
   */
  function clearBmsView(reason: PackStreamEndReason): void {
    recorder.endPackStream(battery.value, reason)
    battery.value = null
    device.value = null
    settings.value = null
    history.splice(0, history.length)
    observations.clear()
    faults.value = []
  }

  /**
   * Stops a running Victron scan and clears the solar view. Synchronous, so it is safe on the
   * boundaries that must not yield before requestDevice: leaving a browsed session and leaving the
   * remembered view both happen on the click that is about to open the chooser.
   */
  function stopSolarLink(): void {
    solarScan.stop()
    recorder.endSolarStream()
    solar.value = null
    solarState.value = 'idle'
    foreignDeviceSeen.value = false
    solarDeviceKey = null
    solarModelId = null
  }

  /**
   * Closes out a live session. Force-flushes the freshest state, then — only if both links
   * have gone idle and a battery was seen — settles into 'remembered' so disconnecting leaves
   * the last numbers on screen instead of blanking. A session that saw no battery (solar-only,
   * or a BMS that dropped before its first cell frame) sets 'none' and then falls back to any
   * valid on-disk session, rather than stranding the user on the blank landing while a
   * remembered view sits ready. If the other link is still live, its source is left untouched.
   */
  function settleAfterLive(reason: SessionEndReason): void {
    persistRememberedNow(true)
    recorder.checkpoint()
    if (source.value !== 'live') return
    if (bmsState.value !== 'idle' || solarState.value !== 'idle') return

    // While device.value and battery.value are still populated: the closing row carries them.
    recorder.finish(reason)

    if (battery.value) {
      rememberedAt.value = lastSnapshotAt || now()
      rememberedStatus.value = currentStatus()
      source.value = 'remembered'
      // The windows described a pack that is no longer reporting; nothing may still stand as a
      // claim about the last thirty seconds.
      observations.clear()
    } else {
      source.value = 'none'
      restoreRemembered()
    }
  }

  /**
   * Leaves remembered mode without yielding to the microtask queue, mirroring leaveHistory:
   * awaiting anything before requestDevice would spend the click's transient activation. The
   * on-disk session is left intact — only the in-memory view is cleared.
   */
  function leaveRemembered(): void {
    resetReadings()
    rememberedAt.value = null
    rememberedStatus.value = null
    source.value = 'none'
  }

  /** Puts the instruments back to nothing after browsing the archive. Synchronous, as above. */
  function leaveHistory(): void {
    resetReadings()
    source.value = 'none'
  }

  /**
   * Loads a stored session's final state into the live instruments.
   *
   * It refuses while either radio is up, because the instruments would then be showing one pack's
   * history under another's badges, and `source` would no longer say what the numbers are. A row
   * written under a snapshot shape this build does not know is listed and plotted everywhere else,
   * but its final snapshot is not fed to the grid: the fields may not mean what they used to.
   *
   * The alarm engine is not run over it. The session carries the annunciator text as it read at
   * the time, and re-deriving an alarm from an hours-old snapshot would annunciate the past.
   */
  function browseSession(record: SessionRecord): boolean {
    if (bmsState.value !== 'idle' || solarState.value !== 'idle') return false
    if (record.schema !== SNAPSHOT_SCHEMA_VERSION) return false
    if (record.finalBattery === null) return false

    resetReadings()
    rememberedAt.value = null
    rememberedStatus.value = null
    battery.value = record.finalBattery
    solar.value = record.finalSolar
    device.value = record.deviceInfo
    settings.value = record.settings
    solarRssi.value = 0
    source.value = 'history'
    return true
  }

  /**
   * Restores the last live session from localStorage on load, so the instruments render with
   * the last-seen numbers rather than the empty landing page — even in browsers without Web
   * Bluetooth. Pure localStorage, no gesture required. History is deliberately not restored,
   * and neither are the windows: a projection over a window that ended hours ago would assert a
   * rate that no longer describes the boat.
   */
  function restoreRemembered(): boolean {
    if (source.value !== 'none') return false
    const session = loadRememberedSession()
    if (!session) return false
    observations.clear()
    battery.value = session.battery
    solar.value = session.solar
    device.value = session.device
    settings.value = session.settings
    solarRssi.value = session.solarRssi
    rememberedAt.value = session.capturedAt
    rememberedStatus.value = session.status
    source.value = 'remembered'
    evaluateFaults(now())
    return true
  }

  function forgetRemembered(): void {
    forgetRememberedSession()
    if (source.value !== 'remembered') return
    resetReadings()
    rememberedAt.value = null
    rememberedStatus.value = null
    source.value = 'none'
  }

  async function connectBms(showAllDevices = false): Promise<void> {
    // A second connect over a live one abandons the first device with its drop listener still
    // bound to it, and nothing afterwards holds a reference able to remove it.
    if (bmsState.value === 'live') return
    bmsError.value = null
    if (source.value === 'remembered') leaveRemembered()
    else if (source.value === 'history') leaveHistory()
    bmsState.value = 'connecting'
    try {
      await bmsLink.connect(showAllDevices)
      bmsState.value = 'live'
      source.value = 'live'
    } catch (error) {
      bmsState.value = 'idle'
      bmsError.value = describeConnectError(error as Error)
      // A cancelled or failed connect must not strand the user on the blank landing: restore the
      // remembered view if nothing came live to replace it.
      if (source.value === 'none' && !battery.value) restoreRemembered()
    }
  }

  async function disconnectBms(): Promise<void> {
    await bmsLink.disconnect()
    bmsState.value = 'idle'
    settleAfterLive('user-disconnect')
    if (solarState.value !== 'idle') clearBmsView('user')
  }

  async function startSolar(key: string): Promise<void> {
    solarError.value = null
    foreignDeviceSeen.value = false
    if (source.value === 'remembered') leaveRemembered()
    else if (source.value === 'history') leaveHistory()
    solarState.value = 'connecting'
    // Saved before the attempt, not after it. requestLEScan raises a native permission prompt, and
    // a scan that is declined, dismissed or simply never answered would otherwise discard
    // thirty-two hex characters the owner has to find in VictronConnect and type again. This is a
    // synchronous localStorage write, so it yields nothing and cannot spend the click's transient
    // activation before the scan asks for it.
    saveAdvertisementKey(key)
    try {
      await solarScan.start(key)
      // The scan is running, but no advertisement has arrived yet. It only becomes 'live'
      // once a packet decodes under this key — which may never happen if the controller is
      // out of range or the key is wrong, so the user keeps a way to stop it.
      solarState.value = 'listening'
      source.value = 'live'
      // The transient activation is already spent, so hashing the key costs nothing here. The key
      // itself never reaches the archive; only a digest of it does.
      void solarDeviceKeyFor(key)
        .then((deviceKey) => {
          solarDeviceKey = deviceKey
          recorder.identifySolar(deviceKey, solarModelId)
        })
        .catch(() => undefined)
    } catch (error) {
      solarState.value = 'idle'
      solarError.value = describeScanError(error as Error)
      // As with connectBms: don't leave the user blank if the scan never started.
      if (source.value === 'none' && !battery.value) restoreRemembered()
    }
  }

  function stopSolar(): void {
    stopSolarLink()
    settleAfterLive('user-disconnect')
  }

  /**
   * The annunciator line as the archive will keep it: title and detail together, exactly as they
   * read at the time. The recorder never re-derives it from numbers that have since moved on.
   *
   * Synchronous flush, because a deferred one would run after the frame that produced it — and
   * after a `finish()` on the same tick, which would drop the entry into a session that has
   * already closed.
   */
  const headline = computed(() => {
    const leading = faults.value[0]
    return leading ? `${leading.title} — ${leading.detail}` : 'No active faults'
  })
  const stopStatusWatch = watch(
    [worstFault, headline],
    ([worst, text]) => recorder.noteStatus(worst, text),
    { flush: 'sync' },
  )

  // A clean tab close may be the only chance to capture the freshest state, and the synchronous
  // localStorage write is the only one guaranteed to land — an IndexedDB transaction may not
  // commit before the page is killed. pagehide also fires on a bfcache freeze the page may be
  // restored from, so this is a checkpoint and never a session end.
  const onPageHide = (): void => persistRememberedNow(true)
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') recorder.checkpoint()
  }
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)

  /** Resolves once every archive write asked for so far has been attempted. Never rejects. */
  function drain(): Promise<void> {
    return recorder.drain()
  }

  /**
   * Lets go of everything this telemetry owns. The open session is deliberately not closed: a torn
   * down tab has learned nothing about how the session ended, and the recovery sweep closing it
   * 'abandoned' is what actually happened.
   */
  function dispose(): void {
    stopStatusWatch()
    stopWatchingAdapter?.()
    stopWatchingAdapter = null
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
    recorder.dispose()
    observations.clear()
  }

  return {
    capabilities,
    adapterOn: readonly(adapterOn),
    source: readonly(source),
    bmsState: readonly(bmsState),
    solarState: readonly(solarState),
    bmsError: readonly(bmsError),
    solarError: readonly(solarError),
    foreignDeviceSeen: readonly(foreignDeviceSeen),
    solarRssi: readonly(solarRssi),
    device,
    settings,
    battery,
    solar,
    bus,
    faults,
    worstFault,
    history,
    rememberedAt: readonly(rememberedAt),
    rememberedStatus: readonly(rememberedStatus),
    packReach: observations.packReach,
    solarReach: observations.solarReach,
    cellReach: observations.cellReach,
    balance: observations.balance,
    projection: observations.projection,
    recording,
    connectBms,
    disconnectBms,
    startSolar,
    stopSolar,
    browseSession,
    leaveHistory,
    restoreRemembered,
    forgetRemembered,
    drain,
    dispose,
  }
}

export type Telemetry = ReturnType<typeof createTelemetry>

/**
 * The archive arrives after first paint, so the shared telemetry is built without one and is
 * handed the store when the probe answers. It is read through a closure rather than assigned into
 * the recorder, so a store that never arrives is simply a store that is always null.
 */
let attachedStore: HistoryStore | null = null

export function attachHistoryStore(store: HistoryStore): void {
  attachedStore = store
}

function browserDeps(): TelemetryDeps {
  return {
    createBmsLink: (handlers) => new JkBmsClient(handlers),
    createSolarScan: (handlers) => new VictronScanner(handlers),
    historyStore: () => attachedStore,
    now: () => Date.now(),
    // Not derived from the wall clock: the whole point of a monotonic reading is that a clock
    // step cannot move it.
    monotonic: () => performance.now(),
    newId: () => crypto.randomUUID(),
  }
}

const shared = createTelemetry(browserDeps())

export function useTelemetry(): Telemetry {
  return shared
}
