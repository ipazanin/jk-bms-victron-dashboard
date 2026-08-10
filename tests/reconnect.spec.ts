// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadLastDevice, saveLastDevice } from '../src/application/lastDevice'
import { saveRememberedSession } from '../src/application/rememberedSession'
import { createTelemetry } from '../src/application/telemetry'
import type { Telemetry } from '../src/application/telemetry'
import { browserBleEnvironment } from '../src/infrastructure/ble/capabilities'
import type { BleEnvironment } from '../src/infrastructure/ble/capabilities'
import { rememberedSession } from './support/samples'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { fakeBmsLink, fakeSolarHistoryLink, fakeSolarScan } from './support/fakeRadios'
import type { FakeBmsLink } from './support/fakeRadios'

/**
 * Rejoining without the chooser is gated on getDevices existing, which jsdom has no radio to
 * provide. The fake link performs the reconnect itself, so raising the one flag is all the guard
 * needs and everything else stays as honest as the browser running the spec.
 */
function browserThatCanRejoin(): BleEnvironment {
  const environment = browserBleEnvironment()
  return { ...environment, capabilities: { ...environment.capabilities, canReconnect: true } }
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
    createSolarHistoryLink: fakeSolarHistoryLink().create,
    bleEnvironment: browserThatCanRejoin(),
    historyStore: () => store,
    refreshRingLedger: async () => undefined,
    refreshSolarLedger: async () => undefined,
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
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
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

describe('the banner after an attempt that failed mid-handshake', () => {
  // Chrome rejects a request that was in flight when the link went away with a NetworkError, whose
  // guidance — close the JK app on your phone, the pack accepts one connection at a time — is true
  // of a refused connection and wrong about a pack that has simply left range.
  function linkGone(): DOMException {
    return new DOMException('GATT Server is disconnected.', 'NetworkError')
  }

  it('keeps the drop banner when the pack goes away inside a chooser connect', async () => {
    const { telemetry, bms } = spawn()
    bms.reportDuringNextConnect(() => bms.emitDisconnect(), linkGone())

    await telemetry.connectBms()

    expect(telemetry.bmsState.value).toBe('idle')
    expect(telemetry.bmsError.value).toMatch(/Lost the BMS/)
  })

  it('answers a failed connect with its own guidance, not the frame the pack could not be read from', async () => {
    const { telemetry, bms } = spawn()
    // A device-info frame that runs short makes the decoder read past its end, and the client
    // reports that over onError while the handshake is still running. It describes one bad frame,
    // not why the connection then failed, so the connect guidance has to win the slot.
    bms.reportDuringNextConnect(
      () => bms.emitError(new RangeError('Offset is outside the bounds of the DataView')),
      linkGone(),
    )

    await telemetry.connectBms()

    expect(telemetry.bmsError.value).toMatch(/JK app/)
    expect(telemetry.bmsError.value).not.toMatch(/DataView/)
  })

  it('keeps the drop banner when a superseded reconnect unwinds', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms } = spawn()
    // What the handshake throws at its next checkpoint once its own drop handler has superseded it.
    bms.reportDuringNextReconnect(() => bms.emitDisconnect(), new DOMException('Reconnect superseded', 'AbortError'))

    await telemetry.reconnectBms()

    expect(telemetry.bmsState.value).toBe('idle')
    expect(telemetry.bmsError.value).toMatch(/Lost the BMS/)
  })

  it('keeps the drop banner when a write in flight rejects as the pack goes away', async () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', clock)
    const { telemetry, bms } = spawn()
    bms.reportDuringNextReconnect(() => bms.emitDisconnect(), linkGone())

    await telemetry.reconnectBms()

    expect(telemetry.bmsState.value).toBe('idle')
    expect(telemetry.bmsError.value).toMatch(/Lost the BMS/)
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
