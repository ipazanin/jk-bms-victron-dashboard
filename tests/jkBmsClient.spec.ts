// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { JkBmsClient } from '../src/infrastructure/ble/JkBmsClient'
import type { JkBmsHandlers } from '../src/infrastructure/ble/JkBmsClient'
import {
  FRAME_CELL_INFO,
  FRAME_DEVICE_INFO,
  FRAME_LENGTH,
  RESPONSE_HEADER,
  checksum,
} from '../src/domain/bms/protocol'

// A minimal Web Bluetooth GATT mock, enough to drive the whole life of a link offline: the
// handshake and its race with the reconnect timeout, notifications carrying frames, the pack going
// away underneath us, and the silence that ends a link nobody told us about. The real device is
// only available on the boat, so everything here is what pins that behaviour down.

interface FakeEventTarget {
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  /** Delivers to whatever the client bound for this type, as the browser would. */
  fire(type: string, event: Event): void
}

interface Mock {
  device: FakeEventTarget & {
    id: string
    name: string
    gatt: { connected: boolean; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
  }
  server: { getPrimaryService: ReturnType<typeof vi.fn> }
  characteristic: FakeEventTarget & {
    properties: { writeWithoutResponse: boolean }
    value: DataView | null
    startNotifications: ReturnType<typeof vi.fn>
    stopNotifications: ReturnType<typeof vi.fn>
    writeValueWithoutResponse: ReturnType<typeof vi.fn>
    writeValueWithResponse: ReturnType<typeof vi.fn>
  }
  requestDevice: ReturnType<typeof vi.fn>
  /** Resolves the pending gatt.connect(). Call it to let a handshake proceed. */
  completeConnect(): void
  /** The radio going away underneath the link, exactly as the browser reports it. */
  dropLink(): void
  /** One GATT notification carrying these bytes. */
  notify(bytes: Uint8Array): void
}

let mock: Mock

/** A well-formed 300-byte response frame of the given type, zero everywhere it is not structural. */
function responseFrame(type: number): Uint8Array {
  const frame = new Uint8Array(FRAME_LENGTH)
  frame.set(RESPONSE_HEADER, 0)
  frame[4] = type
  frame[FRAME_LENGTH - 1] = checksum(frame.subarray(0, FRAME_LENGTH - 1))
  return frame
}

function concat(...chunks: readonly Uint8Array[]): Uint8Array {
  const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

function fakeEventTarget(): FakeEventTarget {
  const bound = new Map<string, Set<EventListener>>()
  return {
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      const forType = bound.get(type) ?? new Set<EventListener>()
      forType.add(listener)
      bound.set(type, forType)
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      bound.get(type)?.delete(listener)
    }),
    fire(type: string, event: Event) {
      for (const listener of [...(bound.get(type) ?? [])]) listener(event)
    },
  }
}

function buildMock(): Mock {
  let resolveConnect: () => void = () => undefined
  const deviceEvents = fakeEventTarget()
  const announceDrop = (): void => {
    deviceEvents.fire('gattserverdisconnected', new Event('gattserverdisconnected'))
  }

  const characteristic: Mock['characteristic'] = {
    ...fakeEventTarget(),
    properties: { writeWithoutResponse: true },
    value: null,
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
    // A local teardown of a live link raises gattserverdisconnected too — the event says the link
    // ended, not who ended it — so anything still bound hears about a disconnect it asked for.
    disconnect: vi.fn(() => {
      if (!gatt.connected) return
      gatt.connected = false
      announceDrop()
    }),
  }
  const device: Mock['device'] = {
    ...deviceEvents,
    id: 'dev-1',
    name: 'JK-Pack',
    gatt,
  }
  const requestDevice = vi.fn(async () => device)

  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    value: { getDevices: async () => [device], requestDevice },
  })

  return {
    device,
    server,
    characteristic,
    requestDevice,
    completeConnect: () => resolveConnect(),
    dropLink: () => {
      gatt.connected = false
      announceDrop()
    },
    notify: (bytes: Uint8Array) => {
      characteristic.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      characteristic.fire('characteristicvaluechanged', { target: characteristic } as unknown as Event)
    },
  }
}

/** A client that has finished its handshake and is holding a live link. */
async function liveClient(handlers: JkBmsHandlers = {}): Promise<JkBmsClient> {
  const client = new JkBmsClient(handlers)
  const reconnecting = client.reconnect('dev-1')
  // Let getDevices resolve and attach reach gatt.connect() before answering it.
  await Promise.resolve()
  await Promise.resolve()
  mock.completeConnect()
  await reconnecting
  return client
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

  it('abandons the handshake when the pack goes away part-way through it', async () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const onDisconnect = vi.fn()
    const client = new JkBmsClient({ onDisconnect })
    // The link dies on the first command of the handshake, leaving two more to run with no
    // characteristic behind them. Those writes have nothing to fail against, so nothing but the
    // abort stops this path ending in a link the app calls live.
    mock.characteristic.writeValueWithoutResponse.mockImplementationOnce(async () => {
      mock.dropLink()
    })

    const outcome = client.reconnect('dev-1').then(
      () => 'resolved',
      (error: unknown) => (error as Error).name,
    )
    await Promise.resolve()
    await Promise.resolve()
    mock.completeConnect()

    expect(await outcome).toBe('AbortError')
    expect(client.connected).toBe(false)
    expect(setIntervalSpy).not.toHaveBeenCalled()
    expect(onDisconnect).toHaveBeenCalledExactlyOnceWith('dropped')
  })

  it('ignores a second connect while the first is still in the chooser', async () => {
    const client = new JkBmsClient({})
    const first = client.connect()
    const second = client.connect()
    await Promise.resolve()
    await Promise.resolve()
    mock.completeConnect()
    await Promise.all([first, second])

    expect(mock.requestDevice).toHaveBeenCalledTimes(1)

    await client.disconnect()
  })
})

describe('JkBmsClient notifications', () => {
  it('dispatches each frame in a notification to its decoder', async () => {
    const onSnapshot = vi.fn()
    const onDeviceInfo = vi.fn()
    const client = await liveClient({ onSnapshot, onDeviceInfo })

    mock.notify(concat(responseFrame(FRAME_DEVICE_INFO), responseFrame(FRAME_CELL_INFO)))

    expect(onDeviceInfo).toHaveBeenCalledTimes(1)
    expect(onSnapshot).toHaveBeenCalledTimes(1)

    await client.disconnect()
  })

  it('reports a frame that fails to handle and carries on with the next one', async () => {
    const onSnapshot = vi.fn()
    const onError = vi.fn()
    const onDisconnect = vi.fn()
    const client = await liveClient({
      onDeviceInfo: () => {
        throw new Error('bad device info')
      },
      onSnapshot,
      onError,
      onDisconnect,
    })

    mock.notify(concat(responseFrame(FRAME_DEVICE_INFO), responseFrame(FRAME_CELL_INFO)))

    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as Error).message).toBe('bad device info')
    // One bad frame is not a reason to tear down a link that is otherwise reporting.
    expect(onSnapshot).toHaveBeenCalledTimes(1)
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(client.connected).toBe(true)

    await client.disconnect()
  })
})

describe('JkBmsClient link loss', () => {
  it('reports a dropped link when the radio goes away', async () => {
    const onDisconnect = vi.fn()
    const client = await liveClient({ onDisconnect })

    mock.dropLink()

    expect(onDisconnect).toHaveBeenCalledExactlyOnceWith('dropped')
    expect(client.connected).toBe(false)
  })

  it('says nothing about a link the app tore down itself', async () => {
    const onDisconnect = vi.fn()
    const client = await liveClient({ onDisconnect })

    await client.disconnect()

    expect(onDisconnect).not.toHaveBeenCalled()
    expect(client.connected).toBe(false)
  })

  it('is still silent when the radio goes away inside the teardown', async () => {
    const onDisconnect = vi.fn()
    const client = await liveClient({ onDisconnect })
    // The common case for a deliberate disconnect: the user is closing the link because the boat is
    // already leaving range, and the radio goes before the unsubscribe it is waiting on returns.
    // The drop handler must be unbound by then, or a teardown the user asked for reports itself as
    // a lost pack.
    mock.characteristic.stopNotifications.mockImplementationOnce(async () => {
      mock.dropLink()
    })

    await client.disconnect()

    expect(onDisconnect).not.toHaveBeenCalled()
  })

  it('gives up on a link that stops notifying, after three silent strikes', async () => {
    vi.useFakeTimers()
    const onDisconnect = vi.fn()
    const client = await liveClient({ onDisconnect })

    // Real time, not synchronous timer ticks: giveUp() awaits disconnect() before it reports, so a
    // run that never yields would see the strikes land and the report never arrive.
    await vi.advanceTimersByTimeAsync(40_000)

    expect(onDisconnect).toHaveBeenCalledExactlyOnceWith('stalled')
    expect(client.connected).toBe(false)
  })

  it('holds the link when a frame arrives between strikes', async () => {
    vi.useFakeTimers()
    const onDisconnect = vi.fn()
    const client = await liveClient({ onDisconnect })

    // Two strikes, then the pack speaks: the count goes back to zero, so the two that follow
    // cannot add up to the three that would end the link.
    await vi.advanceTimersByTimeAsync(18_000)
    mock.notify(responseFrame(FRAME_CELL_INFO))
    await vi.advanceTimersByTimeAsync(18_000)

    expect(onDisconnect).not.toHaveBeenCalled()
    expect(client.connected).toBe(true)

    await client.disconnect()
  })
})
