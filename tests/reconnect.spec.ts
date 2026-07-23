// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadLastDevice, saveLastDevice } from '../src/application/lastDevice'
import { saveRememberedSession } from '../src/application/rememberedSession'
import { createTelemetry } from '../src/application/telemetry'
import type { Telemetry } from '../src/application/telemetry'
import { rememberedSession } from './support/samples'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { fakeBmsLink, fakeSolarScan } from './support/fakeRadios'
import type { FakeBmsLink } from './support/fakeRadios'

// createTelemetry reads its capabilities from navigator.bluetooth, so canReconnect is only true when
// getDevices exists. The fake link performs the reconnect itself; this stub only makes the browser
// look capable enough for the guard to let the attempt through.
const bluetoothStub = {
  getDevices: async () => [],
  requestDevice: async () => ({}),
  requestLEScan: async () => ({}),
  getAvailability: async () => true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
}

let clock = 0
let ids = 0
const cleanups: Array<() => Promise<void>> = []

function spawn(options: { deviceId?: string | null; deviceName?: string | null } = {}): {
  telemetry: Telemetry
  bms: FakeBmsLink
} {
  const bms = fakeBmsLink({ deviceId: options.deviceId ?? 'jk-abc', deviceName: options.deviceName ?? 'JK_B2A8S20P' })
  const solar = fakeSolarScan()
  const store = new MemoryHistoryStore({ now: () => clock })
  const telemetry = createTelemetry({
    createBmsLink: bms.create,
    createSolarScan: solar.create,
    historyStore: () => store,
    now: () => clock,
    monotonic: () => clock,
    newId: () => `session-${(ids += 1)}`,
  })
  cleanups.push(async () => {
    telemetry.dispose()
    await telemetry.drain()
    store.close()
  })
  return { telemetry, bms }
}

beforeEach(() => {
  localStorage.clear()
  clock = Date.now()
  ids = 0
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: bluetoothStub })
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'bluetooth')
  localStorage.clear()
})

describe('remembering the pack', () => {
  it('persists the pack id and name on a successful connect', async () => {
    const { telemetry } = spawn()
    expect(telemetry.lastDevice.value).toBeNull()

    await telemetry.connectBms()

    expect(telemetry.lastDevice.value).toEqual({ id: 'jk-abc', name: 'JK_B2A8S20P', at: clock })
    expect(loadLastDevice()).toEqual({ id: 'jk-abc', name: 'JK_B2A8S20P', at: clock })
  })

  it('offers the remembered pack to a freshly constructed telemetry', () => {
    saveLastDevice('jk-xyz', 'JK-Pack', clock)
    const { telemetry } = spawn()
    expect(telemetry.lastDevice.value).toEqual({ id: 'jk-xyz', name: 'JK-Pack', at: clock })
  })
})

describe('reconnecting without the chooser', () => {
  it('rejoins the remembered pack by its id', async () => {
    const { telemetry, bms } = spawn()
    await telemetry.connectBms()
    await telemetry.disconnectBms()
    await telemetry.drain()
    expect(telemetry.bmsState.value).toBe('idle')

    await telemetry.reconnectBms()

    expect(bms.lastReconnectId).toBe('jk-abc')
    expect(telemetry.bmsState.value).toBe('live')
    expect(telemetry.source.value).toBe('live')
  })

  it('does nothing when no pack has ever been connected', async () => {
    const { telemetry, bms } = spawn()
    await telemetry.reconnectBms()
    expect(bms.lastReconnectId).toBeNull()
    expect(telemetry.bmsState.value).toBe('idle')
  })

  it('surfaces the failure when the pack is out of range', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms } = spawn()
    bms.failNextReconnectWith(new Error('Reconnect timed out. Use Connect BMS.'))

    await telemetry.reconnectBms()

    expect(telemetry.bmsState.value).toBe('idle')
    expect(telemetry.bmsError.value).toContain('Reconnect timed out')
  })

  it('says nothing when a silent auto-reconnect fails', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms } = spawn()
    bms.failNextReconnectWith(new Error('out of range'))

    await telemetry.reconnectBms(true)

    expect(telemetry.bmsState.value).toBe('idle')
    expect(telemetry.bmsError.value).toBeNull()
  })
})

describe('holding the remembered view through the attempt', () => {
  it('replaces the remembered numbers only once the link is live', async () => {
    saveRememberedSession(rememberedSession({ capturedAt: clock }))
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry } = spawn()
    telemetry.restoreRemembered()
    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).not.toBeNull()

    await telemetry.reconnectBms()

    expect(telemetry.source.value).toBe('live')
    expect(telemetry.rememberedAt.value).toBeNull()
  })

  it('leaves the remembered view untouched when the reconnect fails', async () => {
    saveRememberedSession(rememberedSession({ capturedAt: clock }))
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms } = spawn()
    telemetry.restoreRemembered()
    bms.failNextReconnectWith(new Error('out of range'))

    await telemetry.reconnectBms(true)

    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).not.toBeNull()
    expect(telemetry.bmsState.value).toBe('idle')
  })
})
