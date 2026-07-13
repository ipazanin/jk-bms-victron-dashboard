import { computed, reactive, readonly, ref, shallowRef } from 'vue'

import { reconcile, hoursToEmpty, hoursToFull } from '../domain/dcBus'
import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../domain/bms/types'
import type { SolarReading } from '../domain/solar/types'
import { JkBmsClient } from '../infrastructure/ble/JkBmsClient'
import { VictronScanner } from '../infrastructure/ble/VictronScanner'
import { DemoSource } from '../infrastructure/demo/DemoSource'
import { adapterAvailable, detectCapabilities, watchAdapter } from '../infrastructure/ble/capabilities'
import { describeConnectError, describeScanError } from './errors'
import { saveAdvertisementKey } from './storage'
import { worstOf, type FaultLevel } from './severity'
import {
  REMEMBERED_SCHEMA_VERSION,
  forgetRememberedSession,
  loadRememberedSession,
  saveRememberedSession,
} from './rememberedSession'
import type { RememberedStatus } from './rememberedSession'

export type LinkState = 'idle' | 'connecting' | 'listening' | 'live' | 'error'
export type Source = 'none' | 'live' | 'demo' | 'remembered'
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

const HISTORY_SECONDS = 600
const SAMPLE_INTERVAL_MS = 1000

/** Cell spread above the BMS's own balance trigger is worth surfacing. */
const SPREAD_WARNING = 0.01
const SPREAD_SERIOUS = 0.05
const MOSFET_WARNING = 55
const MOSFET_SERIOUS = 70
const MOSFET_CRITICAL = 80
const CELL_TEMPERATURE_WARNING = 45
const LOW_STATE_OF_CHARGE = 20

const capabilities = detectCapabilities()

/** null until the browser answers, and again if it refuses to. */
const adapterOn = ref<boolean | null>(null)
if (capabilities.hasBluetooth) {
  void adapterAvailable().then((value) => (adapterOn.value = value))
  watchAdapter((value) => (adapterOn.value = value))
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
/** The last withSolar the demo was armed with, so a cancelled reconnect can re-arm the same. */
let lastDemoWithSolar = true

/** Populated only in 'remembered' mode, from the persisted session. */
const rememberedAt = ref<number | null>(null)
const rememberedStatus = ref<RememberedStatus | null>(null)

/** At most one write every fifteen samples; snapshots arrive roughly once a second. */
const WRITE_THROTTLE_MS = 15_000
let lastWriteAt = 0
/** Observation time of the latest battery snapshot — the honest age of remembered data. */
let lastSnapshotAt = 0

const bus = computed(() => (battery.value && solar.value ? reconcile(battery.value, solar.value) : null))

const projection = computed(() => {
  const snapshot = battery.value
  if (!snapshot) return null
  const toFull = hoursToFull(snapshot)
  const toEmpty = hoursToEmpty(snapshot)
  return { toFull, toEmpty }
})

const faults = computed<Fault[]>(() => {
  const found: Fault[] = []
  const snapshot = battery.value
  if (snapshot) {
    if (snapshot.cellDelta >= SPREAD_SERIOUS) {
      found.push({
        level: 'serious',
        title: 'Cell imbalance',
        detail: `Spread ${Math.round(snapshot.cellDelta * 1000)} mV, cell ${snapshot.lowestCell} low. Check the balance leads.`,
      })
    } else if (snapshot.cellDelta >= SPREAD_WARNING) {
      found.push({
        level: 'warning',
        title: 'Cell imbalance',
        detail: `Spread ${Math.round(snapshot.cellDelta * 1000)} mV, cell ${snapshot.lowestCell} low. The balancer should be working.`,
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

  return found
})

const worstFault = computed<FaultLevel>(() => worstOf(faults.value.map((fault) => fault.level)))

function currentStatus(): RememberedStatus {
  return { worst: worstFault.value, headline: faults.value[0]?.title ?? 'All nominal' }
}

/**
 * The single guarded write. Only genuinely live data with a battery present is ever
 * persisted, so demo replay (source 'demo') and solar-only sessions no-op here — the
 * exclusion is structural, not a special case. Throttled unless forced on session end.
 */
function persistRememberedNow(force = false): void {
  if (source.value !== 'live') return
  const snapshot = battery.value
  if (!snapshot) return
  const now = Date.now()
  if (!force && now - lastWriteAt < WRITE_THROTTLE_MS) return
  lastWriteAt = now
  saveRememberedSession({
    version: REMEMBERED_SCHEMA_VERSION,
    capturedAt: lastSnapshotAt || now,
    battery: snapshot,
    solar: solar.value,
    device: device.value,
    settings: settings.value,
    solarRssi: solarRssi.value,
    status: currentStatus(),
  })
}

function recordSample(): void {
  const now = Date.now()
  if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return

  const snapshot = battery.value
  // A sample always pairs a pack current with the solar of that same instant, so it can only
  // be taken when a battery snapshot exists. A solar-only tick claims no interval slot.
  if (!snapshot) return
  lastSampleAt = now

  history.push({
    at: now,
    packCurrent: snapshot.current,
    pvPower: solar.value?.pvPower ?? null,
    // A house load that another source has poisoned is recorded as a gap, not a fabricated
    // trace, so TrendStrips shows the break rather than a line dipping below zero.
    housePower: bus.value?.houseLoadPlausible ? bus.value.housePower : null,
  })

  const cutoff = now - HISTORY_SECONDS * 1000
  while (history.length > 0 && history[0].at < cutoff) history.shift()
}

function applySnapshot(snapshot: BatterySnapshot): void {
  battery.value = snapshot
  lastSnapshotAt = Date.now()
  recordSample()
  persistRememberedNow()
}

const bmsClient = new JkBmsClient({
  onSnapshot: applySnapshot,
  onDeviceInfo: (info) => (device.value = info),
  onSettings: (parsed) => (settings.value = parsed),
  onDisconnect: () => {
    bmsState.value = 'idle'
    bmsError.value = 'Lost the BMS. Move closer to the boat’s panel and reconnect.'
    settleAfterLive()
    if (solarState.value !== 'idle') clearBmsView()
  },
  onError: (error) => (bmsError.value = error.message),
})

const victronScanner = new VictronScanner({
  onReading: (reading, rssi) => {
    solar.value = reading
    solarRssi.value = rssi
    solarState.value = 'live'
    // Sample here too: a run of solar advertisements between BMS frames must still feed the
    // trend, and the SAMPLE_INTERVAL_MS gate keeps it to one point a second across both radios.
    recordSample()
  },
  onForeignDevice: () => (foreignDeviceSeen.value = true),
  onStale: () => {
    // Advertisements have stopped: the controller slept or drifted out of range. Drop the
    // frozen reading so the derived house load disappears rather than lying, and fall back
    // to 'listening' — the scan is still up and the controller may return.
    if (solarState.value !== 'live') return
    solar.value = null
    solarState.value = 'listening'
  },
  onError: (error) => (solarError.value = error.message),
})

const demoSource = new DemoSource({
  onSnapshot: applySnapshot,
  onSolar: (reading) => (solar.value = reading),
  onDeviceInfo: (info) => (device.value = info),
})

function resetReadings(): void {
  battery.value = null
  solar.value = null
  device.value = null
  settings.value = null
  history.splice(0, history.length)
  lastSampleAt = 0
}

/**
 * Clears the BMS-side view while a solar scan is still live. settleAfterLive early-returns in
 * that case (solarState is not idle) so source stays 'live' — without this, a frozen battery
 * would sit under a live solar badge. The freshest frame was just force-flushed to disk, so it
 * returns as the remembered view once solar ends too: settleAfterLive's no-battery branch
 * restores it from disk. The solar refs are left untouched — that link is still reporting.
 */
function clearBmsView(): void {
  battery.value = null
  device.value = null
  settings.value = null
  history.splice(0, history.length)
}

/**
 * Stops a running Victron scan and clears the solar view. Synchronous, so it is safe on the
 * demo boundaries that must not yield before requestDevice.
 */
function stopSolarLink(): void {
  victronScanner.stop()
  solar.value = null
  solarState.value = 'idle'
  foreignDeviceSeen.value = false
}

/**
 * Synchronous demo teardown. Awaiting anything before requestDevice would spend the
 * click's transient activation and the chooser would be refused, so the demo must be
 * dismantled without yielding to the microtask queue. The demo boundaries own the solar
 * link as fully as the BMS link: leaving the demo stops any scan so no live advertisement
 * bleeds into an idle page or overwrites the recording.
 */
function teardownDemo(): void {
  demoSource.stop()
  stopSolarLink()
  resetReadings()
  source.value = 'none'
}

/**
 * Closes out a live session. Force-flushes the freshest state, then — only if both links
 * have gone idle and a battery was seen — settles into 'remembered' so disconnecting leaves
 * the last numbers on screen instead of blanking. A session that saw no battery (solar-only,
 * or a BMS that dropped before its first cell frame) sets 'none' and then falls back to any
 * valid on-disk session, rather than stranding the user on the blank landing while a
 * remembered view sits ready. If the other link is still live, its source is left untouched.
 */
function settleAfterLive(): void {
  persistRememberedNow(true)
  if (source.value !== 'live') return
  if (bmsState.value !== 'idle' || solarState.value !== 'idle') return
  if (battery.value) {
    rememberedAt.value = lastSnapshotAt || Date.now()
    rememberedStatus.value = currentStatus()
    source.value = 'remembered'
  } else {
    source.value = 'none'
    restoreRemembered()
  }
}

/**
 * Leaves remembered mode without yielding to the microtask queue, mirroring teardownDemo:
 * awaiting anything before requestDevice would spend the click's transient activation. The
 * on-disk session is left intact — only the in-memory view is cleared.
 */
function leaveRemembered(): void {
  resetReadings()
  rememberedAt.value = null
  rememberedStatus.value = null
  source.value = 'none'
}

/**
 * Restores the last live session from localStorage on load, so the instruments render with
 * the last-seen numbers rather than the empty landing page — even in browsers without Web
 * Bluetooth. Pure localStorage, no gesture required. History is deliberately not restored.
 */
function restoreRemembered(): boolean {
  if (source.value !== 'none') return false
  const session = loadRememberedSession()
  if (!session) return false
  battery.value = session.battery
  solar.value = session.solar
  device.value = session.device
  settings.value = session.settings
  solarRssi.value = session.solarRssi
  rememberedAt.value = session.capturedAt
  rememberedStatus.value = session.status
  source.value = 'remembered'
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

// A clean tab close may be the only chance to capture the freshest state.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => persistRememberedNow(true))
}

export function useTelemetry() {
  async function connectBms(showAllDevices = false): Promise<void> {
    bmsError.value = null
    const cameFromDemo = source.value === 'demo'
    if (source.value === 'demo') teardownDemo()
    else if (source.value === 'remembered') leaveRemembered()
    bmsState.value = 'connecting'
    try {
      await bmsClient.connect(showAllDevices)
      bmsState.value = 'live'
      source.value = 'live'
    } catch (error) {
      bmsState.value = 'idle'
      const message = describeConnectError(error as Error)
      bmsError.value = message
      if (message === null && cameFromDemo) {
        // The user only dismissed the chooser after leaving a demo — put the recording they
        // were watching back rather than stranding them on the blank landing. This re-arm
        // wins over the remembered restore below; a genuine error keeps its message and falls
        // through to that restore instead.
        await startDemo(lastDemoWithSolar)
      } else if (source.value === 'none' && !battery.value) {
        // A cancelled or failed connect must not strand the user on the blank landing:
        // restore the remembered view if nothing came live to replace it.
        restoreRemembered()
      }
    }
  }

  async function disconnectBms(): Promise<void> {
    await bmsClient.disconnect()
    bmsState.value = 'idle'
    settleAfterLive()
    if (solarState.value !== 'idle') clearBmsView()
  }

  async function startSolar(key: string): Promise<void> {
    solarError.value = null
    foreignDeviceSeen.value = false
    if (source.value === 'remembered') leaveRemembered()
    solarState.value = 'connecting'
    try {
      await victronScanner.start(key)
      saveAdvertisementKey(key)
      // The scan is running, but no advertisement has arrived yet. It only becomes 'live'
      // once a packet decodes under this key — which may never happen if the controller is
      // out of range or the key is wrong, so the user keeps a way to stop it.
      solarState.value = 'listening'
      source.value = source.value === 'demo' ? 'demo' : 'live'
    } catch (error) {
      solarState.value = 'idle'
      solarError.value = describeScanError(error as Error)
      // As with connectBms: don't leave the user blank if the scan never started.
      if (source.value === 'none' && !battery.value) restoreRemembered()
    }
  }

  function stopSolar(): void {
    stopSolarLink()
    settleAfterLive()
  }

  async function startDemo(withSolar = true): Promise<void> {
    lastDemoWithSolar = withSolar
    if (bmsState.value === 'live') await disconnectBms()
    // The demo owns the solar link too: a live scan must stop, or its advertisements would
    // overwrite the recorded solar the demo is about to play.
    stopSolarLink()
    // disconnectBms can settle into 'remembered'; clear it before the fetch below yields, or
    // the stale banner flashes over an empty grid. A brief landing flash is acceptable.
    if (source.value === 'remembered') leaveRemembered()
    else resetReadings()
    await demoSource.start(withSolar)
    source.value = 'demo'
  }

  async function stopDemo(): Promise<void> {
    teardownDemo()
    restoreRemembered()
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
    projection,
    faults,
    worstFault,
    history,
    rememberedAt: readonly(rememberedAt),
    rememberedStatus: readonly(rememberedStatus),
    connectBms,
    disconnectBms,
    startSolar,
    stopSolar,
    startDemo,
    stopDemo,
    restoreRemembered,
    forgetRemembered,
  }
}
