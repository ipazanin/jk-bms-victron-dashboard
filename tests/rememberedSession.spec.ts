import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_REMEMBERED_AGE_MS,
  REMEMBERED_SCHEMA_VERSION,
  forgetRememberedSession,
  loadRememberedSession,
  saveRememberedSession,
} from '../src/application/rememberedSession'
import type { RememberedSession } from '../src/application/rememberedSession'
import type { BatterySnapshot } from '../src/domain/bms/types'

const KEY = 'shunt.rememberedSession'

class LocalStorageStub {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  has(key: string): boolean {
    return this.store.has(key)
  }
}

let storage: LocalStorageStub

beforeEach(() => {
  storage = new LocalStorageStub()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

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
    capturedAt: Date.now(),
    battery: battery(),
    solar: {
      chargeState: 'float',
      chargerError: 0,
      batteryVoltage: 13.5,
      batteryCurrent: 2.1,
      yieldTodayKwh: 0.42,
      pvPower: 60,
      loadCurrent: 1.2,
    },
    device: {
      model: 'JK-BMS',
      hardwareVersion: '11.XW',
      softwareVersion: '11.26',
      serialNumber: '405032',
      uptimeSeconds: 4_481_077,
      powerOnCount: 12,
    },
    settings: {
      cellCount: 4,
      nominalCapacity: 315,
      cellOverVoltage: 3.65,
      cellUnderVoltage: 2.5,
      balanceTriggerDelta: 0.008,
      startBalanceVoltage: 3.4,
      maxBalanceCurrent: 1,
      chargeOverTemperature: 70,
      chargeUnderTemperature: -10,
      mosfetOverTemperature: 90,
      balancerEnabled: true,
    },
    solarRssi: -67,
    status: { worst: 'good', headline: 'All nominal' },
    ...overrides,
  }
}

describe('rememberedSession', () => {
  it('round-trips a full session through save and load', () => {
    const original = session()
    saveRememberedSession(original)
    expect(loadRememberedSession()).toEqual(original)
  })

  it('returns null when the key is absent', () => {
    expect(loadRememberedSession()).toBeNull()
  })

  it('discards and removes a session with a mismatched version', () => {
    saveRememberedSession(session({ version: REMEMBERED_SCHEMA_VERSION + 1 }))
    expect(loadRememberedSession()).toBeNull()
    expect(storage.has(KEY)).toBe(false)
  })

  it('discards and removes non-JSON garbage', () => {
    storage.setItem(KEY, 'not json {')
    expect(loadRememberedSession()).toBeNull()
    expect(storage.has(KEY)).toBe(false)
  })

  it('discards a session captured longer ago than the maximum age', () => {
    saveRememberedSession(session({ capturedAt: Date.now() - MAX_REMEMBERED_AGE_MS - 1000 }))
    expect(loadRememberedSession()).toBeNull()
    expect(storage.has(KEY)).toBe(false)
  })

  it('keeps a session captured just within the maximum age', () => {
    const fresh = session({ capturedAt: Date.now() - MAX_REMEMBERED_AGE_MS + 60_000 })
    saveRememberedSession(fresh)
    expect(loadRememberedSession()).toEqual(fresh)
  })

  it('discards a session whose battery is missing a field', () => {
    const incomplete = session()
    const withoutSoc = { ...incomplete, battery: { ...incomplete.battery } } as Record<string, unknown>
    delete (withoutSoc.battery as Record<string, unknown>).stateOfCharge
    storage.setItem(KEY, JSON.stringify(withoutSoc))
    expect(loadRememberedSession()).toBeNull()
  })

  it('discards a session whose battery holds a NaN', () => {
    // NaN serialises to JSON null, so a corrupted number reads back as a non-number.
    saveRememberedSession(session({ battery: battery({ packVoltage: NaN }) }))
    expect(loadRememberedSession()).toBeNull()
  })

  it('discards a session whose battery has no cells', () => {
    saveRememberedSession(session({ battery: battery({ cellVoltages: [] }) }))
    expect(loadRememberedSession()).toBeNull()
  })

  it('accepts a session with no solar, device or settings', () => {
    const batteryOnly = session({ solar: null, device: null, settings: null })
    saveRememberedSession(batteryOnly)
    expect(loadRememberedSession()).toEqual(batteryOnly)
  })

  it('rejects a solar reading whose charge state is not a known state', () => {
    const bogus = session()
    saveRememberedSession({ ...bogus, solar: { ...bogus.solar!, chargeState: 'turbo' as never } })
    expect(loadRememberedSession()).toBeNull()
  })

  it('accepts the unknown charge state, which the decoder emits for unmapped codes', () => {
    const withUnknown = session()
    const payload = { ...withUnknown, solar: { ...withUnknown.solar!, chargeState: 'unknown' as const } }
    saveRememberedSession(payload)
    expect(loadRememberedSession()).toEqual(payload)
  })

  it('rejects an unknown status level', () => {
    saveRememberedSession(session({ status: { worst: 'meltdown' as never, headline: 'x' } }))
    expect(loadRememberedSession()).toBeNull()
  })

  it('forget removes the key', () => {
    saveRememberedSession(session())
    forgetRememberedSession()
    expect(storage.has(KEY)).toBe(false)
    expect(loadRememberedSession()).toBeNull()
  })
})
