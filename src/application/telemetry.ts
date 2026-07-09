import { computed, reactive, readonly, ref, shallowRef } from 'vue'

import { reconcile, hoursToEmpty, hoursToFull } from '../domain/dcBus'
import type { BatterySnapshot, BmsSettings, DeviceInfo } from '../domain/bms/types'
import type { SolarReading } from '../domain/solar/types'
import { JkBmsClient } from '../infrastructure/ble/JkBmsClient'
import { VictronScanner } from '../infrastructure/ble/VictronScanner'
import { DemoSource } from '../infrastructure/demo/DemoSource'
import { detectCapabilities } from '../infrastructure/ble/capabilities'
import { saveAdvertisementKey } from './storage'

export type LinkState = 'idle' | 'connecting' | 'live' | 'error'
export type Source = 'none' | 'live' | 'demo'
export type FaultLevel = 'good' | 'warning' | 'serious' | 'critical'

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

const worstFault = computed<FaultLevel>(() => {
  const order: FaultLevel[] = ['good', 'warning', 'serious', 'critical']
  return faults.value.reduce<FaultLevel>((worst, fault) => (order.indexOf(fault.level) > order.indexOf(worst) ? fault.level : worst), 'good')
})

function recordSample(): void {
  const now = Date.now()
  if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return
  lastSampleAt = now

  const snapshot = battery.value
  if (!snapshot) return

  history.push({
    at: now,
    packCurrent: snapshot.current,
    pvPower: solar.value?.pvPower ?? null,
    housePower: bus.value?.housePower ?? null,
  })

  const cutoff = now - HISTORY_SECONDS * 1000
  while (history.length > 0 && history[0].at < cutoff) history.shift()
}

function applySnapshot(snapshot: BatterySnapshot): void {
  battery.value = snapshot
  recordSample()
}

const bmsClient = new JkBmsClient({
  onSnapshot: applySnapshot,
  onDeviceInfo: (info) => (device.value = info),
  onSettings: (parsed) => (settings.value = parsed),
  onDisconnect: () => {
    bmsState.value = 'idle'
    bmsError.value = 'Lost the BMS. Move closer to the boat’s panel and reconnect.'
    if (solarState.value !== 'live') source.value = 'none'
  },
  onError: (error) => (bmsError.value = error.message),
})

const victronScanner = new VictronScanner({
  onReading: (reading, rssi) => {
    solar.value = reading
    solarRssi.value = rssi
    solarState.value = 'live'
  },
  onForeignDevice: () => (foreignDeviceSeen.value = true),
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

export function useTelemetry() {
  async function connectBms(showAllDevices = false): Promise<void> {
    bmsError.value = null
    if (source.value === 'demo') await stopDemo()
    bmsState.value = 'connecting'
    try {
      await bmsClient.connect(showAllDevices)
      bmsState.value = 'live'
      source.value = 'live'
    } catch (error) {
      bmsState.value = 'idle'
      const message = (error as Error).message
      bmsError.value = /cancelled|User cancelled/i.test(message) ? null : message
    }
  }

  async function disconnectBms(): Promise<void> {
    await bmsClient.disconnect()
    bmsState.value = 'idle'
    if (solarState.value !== 'live') source.value = 'none'
  }

  async function startSolar(key: string): Promise<void> {
    solarError.value = null
    solarState.value = 'connecting'
    try {
      await victronScanner.start(key)
      saveAdvertisementKey(key)
      source.value = source.value === 'demo' ? 'demo' : 'live'
    } catch (error) {
      solarState.value = 'idle'
      solarError.value = (error as Error).message
    }
  }

  function stopSolar(): void {
    victronScanner.stop()
    solarState.value = 'idle'
    solar.value = null
  }

  async function startDemo(withSolar = true): Promise<void> {
    if (bmsState.value === 'live') await disconnectBms()
    resetReadings()
    await demoSource.start(withSolar)
    source.value = 'demo'
  }

  async function stopDemo(): Promise<void> {
    demoSource.stop()
    resetReadings()
    source.value = 'none'
  }

  return {
    capabilities,
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
    connectBms,
    disconnectBms,
    startSolar,
    stopSolar,
    startDemo,
    stopDemo,
  }
}
