// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useTelemetry } from '../src/application/telemetry'
import { REMEMBERED_SCHEMA_VERSION, saveRememberedSession } from '../src/application/rememberedSession'
import type { RememberedSession } from '../src/application/rememberedSession'
import type { BatterySnapshot } from '../src/domain/bms/types'

// telemetry.ts is a module-level singleton, so these tests run sequentially against shared
// reactive state and reset it explicitly between each. jsdom exposes no navigator.bluetooth,
// so the capability probe finds nothing and every connect/scan genuinely throws — which is
// exactly the failure path the restore/fallback logic must survive.

const KEY = 'shunt.rememberedSession'
const VALID_ADVERTISEMENT_KEY = '0123456789abcdef0123456789abcdef'

function battery(overrides: Partial<BatterySnapshot> = {}): BatterySnapshot {
  return {
    cellVoltages: [3.394, 3.394, 3.393, 3.394],
    cellResistances: [0.052, 0.053, 0.053, 0.053],
    averageCellVoltage: 3.393,
    cellDelta: 0.001,
    highestCell: 1,
    lowestCell: 3,
    packVoltage: 13.573,
    current: -8.4,
    power: 114.0,
    stateOfCharge: 98,
    remainingCapacity: 309.1,
    nominalCapacity: 315,
    cycleCount: 4,
    cycledCapacity: 1268.6,
    mosfetTemperature: 30.1,
    temperatureSensor1: 27.5,
    temperatureSensor2: 27.1,
    uptimeSeconds: 4_481_077,
    chargingEnabled: true,
    dischargingEnabled: true,
    ...overrides,
  }
}

function session(overrides: Partial<RememberedSession> = {}): RememberedSession {
  return {
    version: REMEMBERED_SCHEMA_VERSION,
    capturedAt: Date.now() - 5 * 60 * 1000,
    battery: battery(),
    solar: null,
    device: null,
    settings: null,
    solarRssi: -67,
    status: { worst: 'good', headline: 'All nominal' },
    ...overrides,
  }
}

let telemetry: ReturnType<typeof useTelemetry>

beforeEach(() => {
  telemetry = useTelemetry()
  // Force the singleton back to the blank landing and wipe the disk between tests.
  telemetry.forgetRemembered()
  localStorage.clear()
})

afterEach(() => {
  telemetry.forgetRemembered()
  localStorage.clear()
})

describe('remembered session restore', () => {
  it('restores a valid on-disk session into the remembered view', () => {
    const saved = session()
    saveRememberedSession(saved)

    const restored = telemetry.restoreRemembered()

    expect(restored).toBe(true)
    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).toEqual(saved.battery)
    expect(telemetry.rememberedAt.value).toBe(saved.capturedAt)
  })

  it('forgetting clears the view and removes the on-disk session', () => {
    saveRememberedSession(session())
    telemetry.restoreRemembered()

    telemetry.forgetRemembered()

    expect(telemetry.source.value).toBe('none')
    expect(telemetry.battery.value).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('does not restore a corrupt payload and stays on the landing', () => {
    localStorage.setItem(KEY, 'not json {')

    const restored = telemetry.restoreRemembered()

    expect(restored).toBe(false)
    expect(telemetry.source.value).toBe('none')
    expect(telemetry.battery.value).toBeNull()
  })
})

describe('failed connect falls back to the remembered view', () => {
  it('restores the remembered view after connectBms throws with no Web Bluetooth', async () => {
    const saved = session()
    saveRememberedSession(saved)
    telemetry.restoreRemembered()

    await telemetry.connectBms()

    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).toEqual(saved.battery)
    expect(telemetry.bmsError.value).not.toBeNull()
  })

  it('restores the remembered view after startSolar throws with no Web Bluetooth', async () => {
    const saved = session()
    saveRememberedSession(saved)
    telemetry.restoreRemembered()

    await telemetry.startSolar(VALID_ADVERTISEMENT_KEY)

    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).toEqual(saved.battery)
    expect(telemetry.solarError.value).not.toBeNull()
  })
})

describe('ending a live session that produced no battery snapshot', () => {
  // A stub radio lets the scanner genuinely reach 'live' inside jsdom, so stopping it
  // exercises settleAfterLive's no-battery branch — the one that must fall back to the
  // on-disk session instead of stranding the user on the blank landing.
  beforeEach(() => {
    Object.defineProperty(navigator, 'bluetooth', {
      configurable: true,
      value: {
        requestLEScan: async () => ({ active: true, stop: () => undefined }),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    })
  })

  afterEach(() => {
    delete (navigator as { bluetooth?: unknown }).bluetooth
  })

  it('stopping a solar-only scan falls back to the remembered view on disk', async () => {
    const saved = session()
    saveRememberedSession(saved)
    telemetry.restoreRemembered()

    await telemetry.startSolar(VALID_ADVERTISEMENT_KEY)
    // The scan is genuinely running: no advertisement decoded yet, so no battery either.
    expect(telemetry.source.value).toBe('live')
    expect(telemetry.solarState.value).toBe('listening')
    expect(telemetry.battery.value).toBeNull()

    telemetry.stopSolar()

    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).toEqual(saved.battery)
    expect(telemetry.rememberedAt.value).toBe(saved.capturedAt)
  })

  it('stopping a solar-only scan with nothing on disk falls to the landing', async () => {
    await telemetry.startSolar(VALID_ADVERTISEMENT_KEY)
    expect(telemetry.source.value).toBe('live')

    telemetry.stopSolar()

    expect(telemetry.source.value).toBe('none')
    expect(telemetry.battery.value).toBeNull()
  })
})
