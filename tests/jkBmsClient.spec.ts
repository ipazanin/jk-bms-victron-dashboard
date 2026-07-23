// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { JkBmsClient } from '../src/infrastructure/ble/JkBmsClient'

// A minimal Web Bluetooth GATT mock, enough to exercise the reconnect handshake and — the point of
// this file — what happens when a connection completes after its reconnect timeout has already
// fired. The real device is only available on the boat; this pins the cancellation logic offline.

interface Mock {
  device: {
    id: string
    name: string
    gatt: { connected: boolean; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
  }
  server: { getPrimaryService: ReturnType<typeof vi.fn> }
  characteristic: {
    properties: { writeWithoutResponse: boolean }
    value: DataView | null
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
    startNotifications: ReturnType<typeof vi.fn>
    stopNotifications: ReturnType<typeof vi.fn>
    writeValueWithoutResponse: ReturnType<typeof vi.fn>
    writeValueWithResponse: ReturnType<typeof vi.fn>
  }
  /** Resolves the pending gatt.connect(). Call it to let a handshake proceed. */
  completeConnect(): void
}

let mock: Mock

function buildMock(): Mock {
  let resolveConnect: () => void = () => undefined

  const characteristic: Mock['characteristic'] = {
    properties: { writeWithoutResponse: true },
    value: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    startNotifications: vi.fn(async () => characteristic),
    stopNotifications: vi.fn(async () => undefined),
    writeValueWithoutResponse: vi.fn(async () => undefined),
    writeValueWithResponse: vi.fn(async () => undefined),
  }
  const server = { getPrimaryService: vi.fn(async () => ({ getCharacteristic: vi.fn(async () => characteristic) })) }
  const gatt = {
    connected: false,
    connect: vi.fn(
      () =>
        new Promise<typeof server>((resolve) => {
          resolveConnect = () => {
            gatt.connected = true
            resolve(server)
          }
        }),
    ),
    disconnect: vi.fn(() => {
      gatt.connected = false
    }),
  }
  const device = {
    id: 'dev-1',
    name: 'JK-Pack',
    gatt,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }

  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    value: { getDevices: async () => [device] },
  })

  return { device, server, characteristic, completeConnect: () => resolveConnect() }
}

beforeEach(() => {
  mock = buildMock()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'bluetooth')
})

describe('JkBmsClient reconnect', () => {
  it('wires up the link when the pack answers in time', async () => {
    const client = new JkBmsClient({})
    const reconnecting = client.reconnect('dev-1')
    // Let getDevices resolve and attach reach gatt.connect() before answering it.
    await Promise.resolve()
    await Promise.resolve()
    mock.completeConnect()
    await reconnecting

    expect(client.connected).toBe(true)
    expect(mock.characteristic.addEventListener).toHaveBeenCalledWith(
      'characteristicvaluechanged',
      expect.any(Function),
    )
    // Device info, cell info and the logbook are each requested.
    expect(mock.characteristic.writeValueWithoutResponse).toHaveBeenCalledTimes(3)

    await client.disconnect()
  })

  it('rejects, and wires up nothing, when the connection completes after the timeout', async () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const onDisconnect = vi.fn()
    const client = new JkBmsClient({ onDisconnect })

    // Captured eagerly, so the rejection is never momentarily unhandled while the timer is advanced.
    const outcome = client.reconnect('dev-1').then(
      () => 'resolved',
      (error: unknown) => error,
    )
    // Let getDevices resolve and attach park on `await gatt.connect()`, then pass the deadline.
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(6_001)

    expect(String(await outcome)).toMatch(/timed out/i)

    // The connection now resolves, late. The superseded attach must abort at its next checkpoint
    // rather than binding a listener and a stall timer to a link nothing is holding.
    mock.completeConnect()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(client.connected).toBe(false)
    expect(mock.server.getPrimaryService).not.toHaveBeenCalled()
    expect(setIntervalSpy).not.toHaveBeenCalled()
    // A timed-out reconnect is not a dropped link; the app is not told the pack went away.
    expect(onDisconnect).not.toHaveBeenCalled()
  })
})
