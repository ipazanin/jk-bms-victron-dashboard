// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { JkBmsClient } from '../src/infrastructure/ble/JkBmsClient'
import type { JkBmsHandlers } from '../src/infrastructure/ble/JkBmsClient'
import {
  CMD_DETAIL_LOG,
  FRAME_CELL_INFO,
  FRAME_DETAIL_LOG,
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

interface StoredSample {
  readonly rtcSeconds: number
  readonly packVoltage: number
  readonly current: number
}

/**
 * A type 0x06 frame carrying the given samples, laid out the way the detail-log specification
 * describes. Only the three fields these cases assert on are populated; everything else is zero,
 * which decodes to a scheduled sample with no event.
 */
function detailLogFrame(counter: number, firstRecordIndex: number, samples: readonly StoredSample[]): Uint8Array {
  const frame = responseFrame(FRAME_DETAIL_LOG)
  const view = new DataView(frame.buffer)
  frame[5] = counter
  view.setUint16(6, firstRecordIndex, true)
  frame[8] = samples.length
  samples.forEach((sample, position) => {
    const base = 9 + position * 24
    view.setUint32(base, sample.rtcSeconds, true)
    view.setUint16(base + 12, Math.round(sample.packVoltage * 100), true)
    view.setInt16(base + 14, Math.round(sample.current * 10), true)
  })
  frame[FRAME_LENGTH - 1] = checksum(frame.subarray(0, FRAME_LENGTH - 1))
  return frame
}

/** A frame whose checksum will not verify — what a burst mangled in transit leaves behind. */
function mangledFrame(): Uint8Array {
  const frame = responseFrame(FRAME_DETAIL_LOG)
  frame[150] ^= 0xff
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

// The stored detail log is a diagnostic before it is a feature: a bare 0xA7 has already been sent
// to this pack on a demonstrably live link and produced no frames, and nobody knows whether the
// pack ignored it or the transport dropped the reply. The two are indistinguishable by frame count
// and separable only by raw notification bytes, so that is what these cases pin.

describe('JkBmsClient stored detail log', () => {
  const PACK_CLOCK = { packUtcOffsetMinutes: 60 }

  /** The command bytes of the last write, so a case can name the opcode that went out. */
  function lastCommandWritten(): Uint8Array {
    const calls = mock.characteristic.writeValueWithoutResponse.mock.calls
    return new Uint8Array(calls[calls.length - 1][0] as ArrayBuffer)
  }

  it('refuses a read when there is no link to read over', async () => {
    const client = new JkBmsClient({})

    await expect(client.readDetailLog(PACK_CLOCK)).rejects.toThrow(/Connect the BMS/)
  })

  it('reports total silence as an opcode the pack never answered', async () => {
    vi.useFakeTimers()
    const client = await liveClient()

    const reading = client.readDetailLog(PACK_CLOCK)
    await vi.advanceTimersByTimeAsync(8_100)
    const transfer = await reading

    expect(lastCommandWritten()[4]).toBe(CMD_DETAIL_LOG)
    expect(transfer.outcome).toBe('no-answer')
    expect(transfer.notificationBytes).toBe(0)
    expect(transfer.notificationCount).toBe(0)
    expect(transfer.frames).toEqual([])
    expect(transfer.records).toEqual([])
    // Three handshake commands and the read. No stall poke went out during the window, so nothing
    // the pack sends back in it can have been an answer to anything but 0xA7.
    expect(mock.characteristic.writeValueWithoutResponse).toHaveBeenCalledTimes(4)

    await client.disconnect()
  })

  it('reports bytes that assembled into nothing as a torn burst, never as silence', async () => {
    vi.useFakeTimers()
    const client = await liveClient()
    // Three replies whose checksums no longer verify: the pack answered and the transport mangled
    // it. Counting frames alone, this case and the silent one are the same case.
    const wreckage = concat(mangledFrame(), mangledFrame(), mangledFrame())

    const reading = client.readDetailLog(PACK_CLOCK)
    // Delivered in MTU-sized pieces, as the browser would: no one notification is a frame.
    for (let offset = 0; offset < wreckage.length; offset += 180) {
      mock.notify(wreckage.subarray(offset, offset + 180))
    }
    await vi.advanceTimersByTimeAsync(2_100)
    const transfer = await reading

    expect(transfer.outcome).toBe('torn-burst')
    expect(transfer.notificationBytes).toBe(wreckage.length)
    expect(transfer.notificationCount).toBe(5)
    expect(transfer.frames).toEqual([])
    expect(transfer.records).toEqual([])

    await client.disconnect()
  })

  it('reports frames of another type as the opcode meaning something else', async () => {
    vi.useFakeTimers()
    const onSnapshot = vi.fn()
    const client = await liveClient({ onSnapshot })

    const reading = client.readDetailLog(PACK_CLOCK)
    mock.notify(responseFrame(FRAME_CELL_INFO))
    await vi.advanceTimersByTimeAsync(2_100)
    const transfer = await reading

    expect(transfer.outcome).toBe('other-frames')
    expect(transfer.frames.map((header) => header.frameType)).toEqual([FRAME_CELL_INFO])
    expect(transfer.notificationBytes).toBe(FRAME_LENGTH)
    expect(transfer.records).toEqual([])
    // A frame that arrives inside a read window is still a frame: it reaches its own decoder.
    expect(onSnapshot).toHaveBeenCalledTimes(1)

    await client.disconnect()
  })

  it('decodes the records a reply carries and reads each frame’s paging off the one run', async () => {
    vi.useFakeTimers()
    const client = await liveClient()
    const firstPage = detailLogFrame(0, 0, [
      { rtcSeconds: 1_000, packVoltage: 13.42, current: -8.2 },
      { rtcSeconds: 4_601, packVoltage: 13.38, current: 20.8 },
    ])
    const secondPage = detailLogFrame(1, 2, [{ rtcSeconds: 8_202, packVoltage: 13.51, current: 0 }])

    const reading = client.readDetailLog(PACK_CLOCK)
    mock.notify(concat(firstPage, secondPage))
    await vi.advanceTimersByTimeAsync(2_100)
    const transfer = await reading

    expect(transfer.outcome).toBe('records-read')
    expect(transfer.frames).toEqual([
      { frameType: FRAME_DETAIL_LOG, counter: 0, firstRecordIndex: 0, recordCount: 2 },
      { frameType: FRAME_DETAIL_LOG, counter: 1, firstRecordIndex: 2, recordCount: 1 },
    ])
    expect(transfer.records.map((record) => record.index)).toEqual([0, 1, 2])
    expect(transfer.records[0].packVoltage).toBeCloseTo(13.42, 2)
    expect(transfer.records[0].current).toBeCloseTo(-8.2, 1)
    expect(transfer.records[2].packVoltage).toBeCloseTo(13.51, 2)
    // The offset the caller supplied is the only thing separating the two stamps, and it moves
    // the instant alone.
    expect(transfer.records[0].recordedAt).toBe(transfer.records[0].packClockMs - 60 * 60_000)

    await client.disconnect()
  })

  it('joins a second press to the read already running rather than starting a rival one', async () => {
    vi.useFakeTimers()
    const client = await liveClient()

    const first = client.readDetailLog(PACK_CLOCK)
    const second = client.readDetailLog(PACK_CLOCK)
    await vi.advanceTimersByTimeAsync(8_100)

    expect(await first).toBe(await second)
    expect(mock.characteristic.writeValueWithoutResponse).toHaveBeenCalledTimes(4)

    await client.disconnect()
  })

  it('holds the link through a long burst that assembles nothing, which the stall watch would kill', async () => {
    vi.useFakeTimers()
    const onDisconnect = vi.fn()
    const client = await liveClient({ onDisconnect })
    const junk = new Uint8Array(20)

    const reading = client.readDetailLog(PACK_CLOCK)
    // Twenty-seven seconds of bytes that never become a frame — past the three silent strikes that
    // end a link, because only an assembled frame resets the stall clock and none of these does.
    for (let tick = 0; tick < 18; tick += 1) {
      mock.notify(junk)
      await vi.advanceTimersByTimeAsync(1_500)
    }
    await vi.advanceTimersByTimeAsync(2_100)
    const transfer = await reading

    expect(transfer.outcome).toBe('torn-burst')
    expect(transfer.notificationBytes).toBe(18 * junk.length)
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(client.connected).toBe(true)

    await client.disconnect()
  })

  it('puts the stall watch back, with a fresh grace period, once the read is done', async () => {
    vi.useFakeTimers()
    const onDisconnect = vi.fn()
    const client = await liveClient({ onDisconnect })

    const reading = client.readDetailLog(PACK_CLOCK)
    await vi.advanceTimersByTimeAsync(8_100)
    await reading

    // The strikes count from the moment the read ended, so the pack is not charged for the silence
    // the read itself asked for: two strikes here, not three.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(onDisconnect).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(20_000)
    expect(onDisconnect).toHaveBeenCalledExactlyOnceWith('stalled')
  })

  it('stops at the ceiling rather than following a reply that never ends', async () => {
    vi.useFakeTimers()
    const client = await liveClient()
    const junk = new Uint8Array(20)

    const reading = client.readDetailLog(PACK_CLOCK)
    for (let tick = 0; tick < 34; tick += 1) {
      mock.notify(junk)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    const transfer = await reading

    expect(transfer.elapsedMs).toBe(30_000)
    expect(transfer.outcome).toBe('torn-burst')

    await client.disconnect()
  })

  it('settles a read with what it collected when the radio goes away mid-reply', async () => {
    vi.useFakeTimers()
    const onDisconnect = vi.fn()
    const client = await liveClient({ onDisconnect })

    const reading = client.readDetailLog(PACK_CLOCK)
    mock.notify(new Uint8Array(64))
    mock.dropLink()
    const transfer = await reading

    expect(transfer.notificationBytes).toBe(64)
    expect(transfer.outcome).toBe('torn-burst')
    expect(onDisconnect).toHaveBeenCalledExactlyOnceWith('dropped')
    expect(client.connected).toBe(false)
  })
})
