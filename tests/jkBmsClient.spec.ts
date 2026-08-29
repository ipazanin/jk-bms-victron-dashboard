// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { JkBmsClient } from '../src/infrastructure/ble/JkBmsClient'
import type { JkBmsHandlers } from '../src/infrastructure/ble/JkBmsClient'
import { ReconnectRefusedError } from '../src/infrastructure/ble/ReconnectRefusedError'
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
  /**
   * Resolves a pending gatt.connect(). The newest by default, which is the one a case that made a
   * single attempt is waiting on; 'oldest' answers the connect an abandoned attempt left
   * outstanding, which is what a pack coming back into range does to it.
   */
  completeConnect(which?: 'newest' | 'oldest'): void
  /**
   * The adapter map having forgotten the device, which is what three quiet minutes leave behind:
   * the next gatt.connect() rejects at once, with the radio never asked. One-shot, because a
   * sighting is what puts the device back in the map.
   */
  refuseNextConnect(error: Error): void
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
 * A type 0x06 frame carrying the given samples, laid out the way the detail-log layout describes.
 * Only the three fields these cases assert on are populated; everything else is zero, which decodes
 * to a scheduled sample with no event.
 */
function detailLogFrame(
  unidentifiedByte: number,
  firstRecordIndex: number,
  samples: readonly StoredSample[],
): Uint8Array {
  const frame = responseFrame(FRAME_DETAIL_LOG)
  const view = new DataView(frame.buffer)
  frame[5] = unidentifiedByte
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
  // Every connect is kept, not just the last: Chromium leaves an abandoned attempt's connect
  // outstanding, and a case about what happens when one of those finally resolves needs to be able
  // to reach it after a later attempt has been and gone.
  const outstandingConnects: Array<() => void> = []
  let connectRefusal: Error | null = null
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
    connect: vi.fn(() => {
      const refused = connectRefusal
      connectRefusal = null
      if (refused !== null) return Promise.reject(refused)
      return new Promise<typeof server>((resolve) => {
        outstandingConnects.push(() => {
          gatt.connected = true
          resolve(server)
        })
      })
    }),
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
    completeConnect: (which = 'newest') => {
      const answering = which === 'newest' ? outstandingConnects.pop() : outstandingConnects.shift()
      answering?.()
    },
    refuseNextConnect: (error: Error) => {
      connectRefusal = error
    },
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

/**
 * The advertisement watch on the remembered handle, as the flag-enabled browser on the boat
 * provides it. Kept out of `buildMock` on purpose: a browser without it is the fallback path, and
 * the cases above are that browser.
 *
 * Every signal handed to `watchAdvertisements` is kept, because the re-arm loop's whole contract is
 * that it aborts the stalled watch before asking for the next one. Delivery follows the live watch:
 * an advertisement dispatched when every signal has been aborted reaches nobody, exactly as it does
 * in Chrome, so a client that stopped watching genuinely stops hearing.
 */
interface PackWatch {
  readonly signals: readonly AbortSignal[]
  /**
   * The watch itself, so a case can say it was never even asked for. A rejoin that arms one has
   * tied itself to a focused window, whatever it does afterwards.
   */
  readonly watchAdvertisements: ReturnType<typeof vi.fn>
  /** Whether any watch handed out is still listening. */
  live(): boolean
  /** The pack is heard from — the go-signal a rejoin that has to wait is waiting for. */
  sight(): void
  /** The radio refusing the next watch outright, which is not the same as hearing nothing. */
  refuseNextWatch(error: Error): void
}

function watchThePack(): PackWatch {
  const signals: AbortSignal[] = []
  let refusal: Error | null = null

  const watchAdvertisements = vi.fn(async (options?: WatchAdvertisementsOptions) => {
    const refused = refusal
    refusal = null
    if (refused !== null) throw refused
    if (options?.signal) signals.push(options.signal)
  })
  Object.assign(mock.device, { watchAdvertisements })

  const live = (): boolean => signals.some((signal) => !signal.aborted)
  return {
    signals,
    watchAdvertisements,
    live,
    sight: () => {
      if (!live()) return
      mock.device.fire('advertisementreceived', new Event('advertisementreceived'))
    },
    refuseNextWatch: (error: Error) => {
      refusal = error
    },
  }
}

/**
 * Lets the microtasks between one step of a rejoin and the next run. A loop rather than a counted
 * pair of turns: the count is an artefact of how many awaits the path happens to take, so a case
 * that pins it fails on a tidy-up rather than on a bug.
 */
async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
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

})

// Two attempts can overlap for real: the app reconnects on load without a gesture while the owner
// presses Connect, and Blink does not dedupe gatt.connect() underneath us. What a busy client
// answers is therefore load-bearing — a resolved promise is read one layer up as a live link, so an
// attempt that connected nothing must never resolve, or the dashboard paints frozen numbers as live.

describe('JkBmsClient overlapping attempts', () => {
  it('reaches the chooser with no await ahead of it, so the browser still honours the gesture', async () => {
    const client = new JkBmsClient({})

    const connecting = client.connect()

    // Asserted before this case yields even once: an await anywhere ahead of requestDevice spends
    // the transient activation and the chooser is refused.
    expect(mock.requestDevice).toHaveBeenCalledTimes(1)

    await Promise.resolve()
    await Promise.resolve()
    mock.completeConnect()
    await connecting
    await client.disconnect()
  })

  it('joins a second connect to the attempt already running rather than resolving over a dark link', async () => {
    const client = new JkBmsClient({})

    const first = client.connect()
    const second = client.connect()
    const linkWhenSecondResolved = second.then(() => client.connected)
    await Promise.resolve()
    await Promise.resolve()
    mock.completeConnect()
    await Promise.all([first, second])

    expect(mock.requestDevice).toHaveBeenCalledTimes(1)
    expect(await linkWhenSecondResolved).toBe(true)

    await client.disconnect()
  })

  it('joins a second reconnect for the same pack to the one already running', async () => {
    const client = new JkBmsClient({})

    const first = client.reconnect('dev-1')
    const second = client.reconnect('dev-1')
    const linkWhenSecondResolved = second.then(() => client.connected)
    await Promise.resolve()
    await Promise.resolve()
    mock.completeConnect()
    await Promise.all([first, second])

    expect(mock.device.gatt.connect).toHaveBeenCalledTimes(1)
    expect(await linkWhenSecondResolved).toBe(true)

    await client.disconnect()
  })

  it('refuses a reconnect to another pack while an attempt is still in flight', async () => {
    const client = new JkBmsClient({})

    const connecting = client.connect()
    const refused = client.reconnect('dev-2').then(
      () => 'resolved',
      (error: unknown) => (error as Error).message,
    )

    expect(String(await refused)).toMatch(/already being made/i)

    await Promise.resolve()
    await Promise.resolve()
    mock.completeConnect()
    await connecting
    await client.disconnect()
  })

  it('resolves a reconnect to the pack it is already holding', async () => {
    const client = await liveClient()

    await client.reconnect('dev-1')

    expect(client.connected).toBe(true)
    expect(mock.device.gatt.connect).toHaveBeenCalledTimes(1)

    await client.disconnect()
  })

  it('refuses a reconnect to another pack while a link is already held', async () => {
    const client = await liveClient()

    const refused = client.reconnect('dev-2').then(
      () => 'resolved',
      (error: unknown) => (error as Error).message,
    )

    expect(String(await refused)).toMatch(/different pack/i)
    expect(client.connected).toBe(true)

    await client.disconnect()
  })

  it('refuses a chooser connect while a link is already held', async () => {
    const client = await liveClient()

    const refused = client.connect().then(
      () => 'resolved',
      (error: unknown) => (error as Error).message,
    )

    expect(String(await refused)).toMatch(/disconnect/i)
    expect(mock.requestDevice).not.toHaveBeenCalled()
    expect(client.connected).toBe(true)

    await client.disconnect()
  })
})

// Two things are true of a rejoin at once. Chromium purges a device that is neither paired nor
// connected from its adapter map after three minutes of not advertising, and nothing in the connect
// path scans on the page's behalf — so a remembered handle taken straight to gatt.connect() is
// guaranteed to fail on a boat the owner has walked away from, and only a sighting brings it back.
// But Chromium also kills every advertisement watch the moment the tab is hidden or the window
// loses focus, silently — so a rejoin that insists on hearing the pack first works only with the
// page in front, which is not where the owner is for most of the day. These cases pin both halves:
// the straight attach that costs milliseconds when the map has forgotten the pack and needs no
// focus when it has not, the sighting that is the only way back when it has, and the teardown each
// of them owes.

describe('JkBmsClient rejoining a remembered pack', () => {
  /**
   * Nothing left listening, watching or ticking. The re-arm interval is the one thing that cannot
   * be read directly, so it is caught by its effect: a loop still running would arm another watch.
   */
  async function expectNothingLeftWatching(watch: PackWatch): Promise<void> {
    expect(watch.live()).toBe(false)
    expect(mock.device.removeEventListener).toHaveBeenCalledWith('advertisementreceived', expect.any(Function))
    const armedSoFar = watch.signals.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(watch.signals).toHaveLength(armedSoFar)
  }

  /** What a rejoin refused before it reached the radio came back with, typed as the case reads it. */
  async function refusalFrom(rejoining: Promise<void>): Promise<ReconnectRefusedError> {
    return rejoining.then(
      () => {
        throw new Error('The reconnect resolved where a refusal was expected.')
      },
      (error: unknown) => error as ReconnectRefusedError,
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('attaches a pack still in the adapter map without ever watching for it', async () => {
    const watch = watchThePack()
    const client = new JkBmsClient({})

    const rejoining = client.reconnect('dev-1')
    await settleMicrotasks()

    expect(mock.device.gatt.connect).toHaveBeenCalledTimes(1)

    mock.completeConnect()
    await rejoining

    expect(client.connected).toBe(true)
    // The whole of the case. A watch is the half Chromium tears down when the window loses focus,
    // so a rejoin that armed one here would have stopped working the moment the owner switched to
    // another application — which is precisely when this one has to work.
    expect(watch.watchAdvertisements).not.toHaveBeenCalled()
    expect(watch.signals).toHaveLength(0)

    // The probe's deadline settled along with it. Left running it would come due over the link it
    // had just made and tear that down two and a half seconds in.
    await vi.advanceTimersByTimeAsync(6_000)
    expect(client.connected).toBe(true)
    expect(watch.signals).toHaveLength(0)

    await client.disconnect()
  })

  it('asks for no watch at all when the caller has no window to hold one', async () => {
    const watch = watchThePack()
    const client = new JkBmsClient({})

    // The page is behind another application. A watch armed here would be torn down by Chromium
    // without a word, and on Android it would spend one of the five registrations per thirty
    // seconds that the platform throttles in silence — starving the watch the owner comes back to.
    const rejoining = client.reconnect('dev-1', undefined, 'straight-in-only').then(
      () => 'resolved',
      (error: unknown) => (error as Error).message,
    )
    await settleMicrotasks()

    expect(mock.device.gatt.connect).toHaveBeenCalledTimes(1)
    expect(watch.watchAdvertisements).not.toHaveBeenCalled()

    // Past the point where a rejoin that could wait would have handed over to the watch. There is
    // nothing to hand over to, so the attach keeps the longer blind budget and then says the pack
    // is not there — which is the honest answer while nothing could be armed to change it.
    await vi.advanceTimersByTimeAsync(2_600)
    expect(watch.watchAdvertisements).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3_500)
    expect(await rejoining).toMatch(/Reconnect timed out/)
    expect(client.connected).toBe(false)
    expect(watch.signals).toHaveLength(0)
  })

  it('waits for a sighting, and attaches on it, when the map has forgotten the pack', async () => {
    const watch = watchThePack()
    // What three quiet minutes leave behind: the map entry is gone, so the connect is refused
    // outright rather than left outstanding.
    mock.refuseNextConnect(new DOMException('Bluetooth Device is no longer in range.', 'NetworkError'))
    const client = new JkBmsClient({})

    const rejoining = client.reconnect('dev-1')
    await settleMicrotasks()

    // The refusal costs no radio time, so the watch is up long before the probe's own deadline.
    expect(watch.signals).toHaveLength(1)
    expect(mock.device.gatt.connect).toHaveBeenCalledTimes(1)

    watch.sight()
    await settleMicrotasks()
    mock.completeConnect()
    await rejoining

    expect(client.connected).toBe(true)
    expect(mock.device.gatt.connect).toHaveBeenCalledTimes(2)
    // The watch is the go-signal and nothing more: once it has fired, holding it open would keep a
    // stalled watch alive over a link that no longer needs one.
    await client.disconnect()
    await expectNothingLeftWatching(watch)
  })

  it('hands over to the watch when a map entry outlived the pack and leaves the connect hanging', async () => {
    const watch = watchThePack()
    const client = new JkBmsClient({})

    const rejoining = client.reconnect('dev-1')
    await settleMicrotasks()

    // The device is still listed, so nothing refuses the connect and nothing answers it either.
    // Until the probe's deadline this is indistinguishable from a pack that is about to answer.
    expect(watch.signals).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2_600)

    expect(watch.signals).toHaveLength(1)
    // The probe is short on purpose: a stall here is time the watch is not being given.
    expect(mock.device.gatt.connect).toHaveBeenCalledTimes(1)

    watch.sight()
    await settleMicrotasks()
    mock.completeConnect()
    await rejoining

    expect(client.connected).toBe(true)

    await client.disconnect()
    await expectNothingLeftWatching(watch)
  })

  it('waits indefinitely for a pack that never arrives rather than failing on a deadline of its own', async () => {
    const watch = watchThePack()
    const client = new JkBmsClient({})
    let settled = false

    const rejoining = client.reconnect('dev-1').then(
      () => 'resolved',
      (error: unknown) => (error as Error).name,
    )
    void rejoining.finally(() => {
      settled = true
    })
    await settleMicrotasks()
    // Well past every attach budget the class has. How long a pack out of range is worth waiting
    // for is the caller's policy, and this class has none of its own to run out — the probe's
    // deadline ends the probe, never the rejoin.
    await vi.advanceTimersByTimeAsync(300_000)

    expect(settled).toBe(false)
    expect(mock.device.gatt.connect).toHaveBeenCalledTimes(1)

    await client.disconnect()
    expect(await rejoining).toBe('AbortError')
    await expectNothingLeftWatching(watch)
  })

  it('replaces a watch that has gone silent, because a stalled one still calls itself live', async () => {
    const watch = watchThePack()
    const client = new JkBmsClient({})

    const rejoining = client.reconnect('dev-1')
    await settleMicrotasks()
    // Past the probe, so the watch is up, and then past its first silent spell.
    await vi.advanceTimersByTimeAsync(2_600)
    await vi.advanceTimersByTimeAsync(10_100)

    expect(watch.signals).toHaveLength(2)
    // The stalled watch is dropped only after its replacement is up, so nothing is heard through a
    // moment with no watch at all.
    expect(watch.signals[0].aborted).toBe(true)
    expect(watch.signals[1].aborted).toBe(false)

    // A pack that turns up on the fresh watch is heard, which is the entire point of re-arming.
    watch.sight()
    await settleMicrotasks()
    mock.completeConnect()
    await rejoining

    expect(client.connected).toBe(true)

    await client.disconnect()
    await expectNothingLeftWatching(watch)
  })

  it('stands down during the straight attach without falling through to the watch', async () => {
    const watch = watchThePack()
    const client = new JkBmsClient({})
    const standingDown = new AbortController()

    const rejoining = client.reconnect('dev-1', standingDown.signal).then(
      () => 'resolved',
      (error: unknown) => (error as Error).name,
    )
    await settleMicrotasks()
    expect(watch.signals).toHaveLength(0)
    standingDown.abort()

    // An AbortError, not a failure: a supervisor that fed its own stand-down into a backoff would
    // punish the owner for pressing Disconnect. A probe that treated it as one more thing the pack
    // did not answer would go on to wait for a pack nobody is asking for any more.
    expect(await rejoining).toBe('AbortError')
    expect(client.connected).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(watch.signals).toHaveLength(0)
  })

  it('stands down while it is waiting to hear the pack, and lets go of the watch', async () => {
    const watch = watchThePack()
    const client = new JkBmsClient({})
    const standingDown = new AbortController()

    const rejoining = client.reconnect('dev-1', standingDown.signal).then(
      () => 'resolved',
      (error: unknown) => (error as Error).name,
    )
    await settleMicrotasks()
    await vi.advanceTimersByTimeAsync(2_600)
    expect(watch.signals).toHaveLength(1)

    standingDown.abort()

    expect(await rejoining).toBe('AbortError')
    expect(client.connected).toBe(false)
    await expectNothingLeftWatching(watch)
  })

  it('gives the handshake room to finish once presence is no longer in question', async () => {
    const watch = watchThePack()
    const client = new JkBmsClient({})
    let settled = false

    const rejoining = client.reconnect('dev-1').then(
      () => 'resolved',
      (error: unknown) => (error as Error).message,
    )
    void rejoining.finally(() => {
      settled = true
    })
    await settleMicrotasks()
    await vi.advanceTimersByTimeAsync(2_600)
    watch.sight()
    await settleMicrotasks()

    // The probe's two and a half seconds is a guess at whether the pack is there at all, and the
    // sighting has since answered that — so the handshake behind it is not cut off at anything like
    // the same mark, and the probe running out settles nothing on its own.
    await vi.advanceTimersByTimeAsync(6_100)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(14_100)
    expect(String(await rejoining)).toMatch(/timed out/i)
    expect(client.connected).toBe(false)
    await expectNothingLeftWatching(watch)
  })

  it('drops a handle the browser still calls connected before handshaking over it', async () => {
    const watch = watchThePack()
    // What a pack that power-cycled behind our back leaves: a handle the browser reports as
    // connected, whose gatt.connect() would resolve at once over a link carrying nothing.
    mock.device.gatt.connected = true
    const client = new JkBmsClient({})

    const rejoining = client.reconnect('dev-1')
    await settleMicrotasks()

    expect(mock.device.gatt.disconnect).toHaveBeenCalledTimes(1)
    expect(mock.device.gatt.connect).toHaveBeenCalledTimes(1)

    mock.completeConnect()
    await rejoining

    expect(client.connected).toBe(true)
    expect(watch.signals).toHaveLength(0)

    await client.disconnect()
  })

  it('lets the watch attach over a link the probe opened and then gave up on', async () => {
    const watch = watchThePack()
    const onDisconnect = vi.fn()
    const client = new JkBmsClient({ onDisconnect })
    // The pack is in the map, so the probe gets its link — and then the subscription hangs, which
    // leaves the deadline to tear a live link down. This is the one exit where the probe has
    // something of its own to unwind before the watch behind it may attach.
    mock.characteristic.startNotifications.mockImplementationOnce(() => new Promise<never>(() => undefined))

    const rejoining = client.reconnect('dev-1')
    await settleMicrotasks()
    mock.completeConnect()
    await settleMicrotasks()
    expect(mock.device.gatt.connected).toBe(true)

    await vi.advanceTimersByTimeAsync(2_600)

    // The probe's link is gone and the drop handler went with it, so a teardown the class asked for
    // is not reported as the pack walking away.
    expect(mock.device.gatt.connected).toBe(false)
    expect(watch.signals).toHaveLength(1)
    expect(onDisconnect).not.toHaveBeenCalled()

    watch.sight()
    await settleMicrotasks()
    mock.completeConnect()
    await rejoining

    expect(client.connected).toBe(true)
    expect(onDisconnect).not.toHaveBeenCalled()

    await client.disconnect()
    await expectNothingLeftWatching(watch)
  })

  it('leaves the watch’s link alone when the abandoned probe’s unsubscribe finally returns', async () => {
    const watch = watchThePack()
    const onDisconnect = vi.fn()
    const client = new JkBmsClient({ onDisconnect })
    let finishSubscribe = (): void => undefined
    const subscribing = new Promise<void>((resolve) => {
      finishSubscribe = () => resolve()
    })
    let finishUnsubscribe = (): void => undefined
    const unsubscribing = new Promise<void>((resolve) => {
      finishUnsubscribe = () => resolve()
    })
    mock.characteristic.startNotifications.mockImplementationOnce(() => subscribing)
    // The descriptor write that undoes it goes over the same congested link that blew the probe's
    // budget in the first place, so the teardown parks where the handshake did.
    mock.characteristic.stopNotifications.mockImplementationOnce(() => unsubscribing)

    const rejoining = client.reconnect('dev-1')
    await settleMicrotasks()
    mock.completeConnect()
    await settleMicrotasks()

    await vi.advanceTimersByTimeAsync(2_600)
    expect(mock.characteristic.stopNotifications).toHaveBeenCalledTimes(1)

    // The pack is heard while that unsubscribe is still outstanding, and the handshake behind the
    // sighting runs to the end over the very same handle.
    watch.sight()
    await settleMicrotasks()
    mock.completeConnect()
    await rejoining
    expect(client.connected).toBe(true)

    finishUnsubscribe()
    finishSubscribe()
    await settleMicrotasks()

    // The abandoned teardown resumes here, holding a handle that is no longer its own. Dropping it
    // would take away a link the pack had just been rejoined over, and take it away in silence,
    // because the drop handler came off before the unsubscribe was ever asked for.
    expect(client.connected).toBe(true)
    expect(mock.device.gatt.connected).toBe(true)
    expect(onDisconnect).not.toHaveBeenCalled()

    await client.disconnect()
    await expectNothingLeftWatching(watch)
  })

  it('names permission that has lapsed apart from a pack that is merely out of range', async () => {
    const watch = watchThePack()
    const client = new JkBmsClient({})

    // getDevices reports what this origin may talk to, never what is in range, so a pack missing
    // from it needs a chooser tap and no amount of waiting will bring it back.
    const refusal = await refusalFrom(client.reconnect('dev-2'))

    expect(refusal).toBeInstanceOf(ReconnectRefusedError)
    expect(refusal.refusal).toBe('permission-gone')
    expect(refusal.name).not.toBe('AbortError')
    // Neither half of the rejoin runs. A refusal that fell through to the watch would sit there
    // waiting on a pack it has no permission to attach to however clearly it is heard.
    expect(watch.signals).toHaveLength(0)
    expect(mock.device.gatt.connect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(watch.signals).toHaveLength(0)
  })

  it('says the browser cannot rejoin at all when it will not list permitted devices', async () => {
    Object.defineProperty(navigator, 'bluetooth', {
      configurable: true,
      value: { requestDevice: mock.requestDevice },
    })
    const client = new JkBmsClient({})

    const refusal = await refusalFrom(client.reconnect('dev-1'))

    expect(refusal).toBeInstanceOf(ReconnectRefusedError)
    expect(refusal.refusal).toBe('browser-cannot-rejoin')
    expect(mock.device.gatt.connect).not.toHaveBeenCalled()
  })

  it('leaves the live link alone when the attempt it replaced finally unwinds', async () => {
    const watch = watchThePack()
    const onDisconnect = vi.fn()
    const client = new JkBmsClient({ onDisconnect })
    const deadline = new AbortController()

    // The first attempt's probe reaches gatt.connect() and parks there. Its caller's deadline runs
    // out, and the attempt is abandoned with that connect still outstanding underneath it.
    const abandoned = client.reconnect('dev-1', deadline.signal).then(
      () => 'resolved',
      (error: unknown) => (error as Error).name,
    )
    await settleMicrotasks()
    expect(mock.device.gatt.connect).toHaveBeenCalledTimes(1)
    deadline.abort()
    expect(await abandoned).toBe('AbortError')

    // The next attempt finds the map has since forgotten the pack, waits to hear it, and the link
    // comes up on the other side of that wait — a different phase from the one left outstanding.
    mock.refuseNextConnect(new DOMException('Bluetooth Device is no longer in range.', 'NetworkError'))
    const rejoining = client.reconnect('dev-1')
    await settleMicrotasks()
    watch.sight()
    await settleMicrotasks()
    mock.completeConnect()
    await rejoining
    expect(client.connected).toBe(true)

    // The pack returning to range is exactly what answers the connect the first attempt left
    // behind. It aborts at its next checkpoint, as it is built to — and must unwind with its hands
    // empty, because the link it would reach for is no longer its own.
    mock.completeConnect('oldest')
    await settleMicrotasks()

    expect(client.connected).toBe(true)
    expect(mock.device.gatt.connected).toBe(true)
    // A teardown detaches the drop handler first, so tearing the live link down here would take it
    // away without a word and leave the app holding frozen numbers under a live badge.
    expect(onDisconnect).not.toHaveBeenCalled()

    await client.disconnect()
    await expectNothingLeftWatching(watch)
  })

  it('gives up on a radio that refuses the watch outright, which is not the same as hearing nothing', async () => {
    const watch = watchThePack()
    mock.refuseNextConnect(new DOMException('Bluetooth Device is no longer in range.', 'NetworkError'))
    watch.refuseNextWatch(new DOMException('Bluetooth adapter not available.', 'NotFoundError'))
    const client = new JkBmsClient({})

    const rejoining = client.reconnect('dev-1').then(
      () => 'resolved',
      (error: unknown) => (error as Error).message,
    )

    // The radio's own refusal is what comes back, not the purge that sent us to the watch: there is
    // nothing left to wait for, and saying the pack was out of range would invite a retry.
    expect(String(await rejoining)).toMatch(/adapter not available/i)
    expect(mock.device.gatt.connect).toHaveBeenCalledTimes(1)
    await expectNothingLeftWatching(watch)
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

// The stored detail log is a diagnostic before it is a feature. A pack that ignored 0xA7 and a
// reply the transport tore up are indistinguishable by frame count, and separable only by raw
// notification bytes, so that is what these cases pin.

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
    // Delivered in MTU-sized pieces, as the browser would: no one notification is a frame. Bytes
    // that never assemble hold nothing open, so the read runs to the first-answer grace.
    for (let offset = 0; offset < wreckage.length; offset += 180) {
      mock.notify(wreckage.subarray(offset, offset + 180))
    }
    await vi.advanceTimersByTimeAsync(8_100)
    const transfer = await reading

    expect(transfer.outcome).toBe('torn-burst')
    expect(transfer.notificationBytes).toBe(wreckage.length)
    expect(transfer.notificationCount).toBe(5)
    expect(transfer.assembledFrameCount).toBe(0)
    expect(transfer.frames).toEqual([])
    expect(transfer.records).toEqual([])

    await client.disconnect()
  })

  it('reports whole frames with no stored log among them as a firmware without one', async () => {
    vi.useFakeTimers()
    const onSnapshot = vi.fn()
    const client = await liveClient({ onSnapshot })

    const reading = client.readDetailLog(PACK_CLOCK)
    mock.notify(responseFrame(FRAME_CELL_INFO))
    // Cell-info streams unprompted through every window, so it must not hold the read open: the
    // first-answer grace expires as if nothing had arrived, and the frame count says what did.
    await vi.advanceTimersByTimeAsync(8_100)
    const transfer = await reading

    expect(transfer.outcome).toBe('other-frames')
    expect(transfer.assembledFrameCount).toBe(1)
    expect(transfer.frames).toEqual([])
    expect(transfer.notificationBytes).toBe(FRAME_LENGTH)
    expect(transfer.records).toEqual([])
    expect(transfer.elapsedMs).toBe(8_000)
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
      { unidentifiedByte: 0, firstRecordIndex: 0, recordCount: 2 },
      { unidentifiedByte: 1, firstRecordIndex: 2, recordCount: 1 },
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

  /**
   * The archive files the bytes, and it reads the receipt's decoded records off the same positions.
   * The two lists drifting apart by so much as one record would file a burst under ring indices it
   * never occupied, which the merge would then align on and store as real history.
   */
  it('carries each record’s own bytes alongside the reading it made of them', async () => {
    vi.useFakeTimers()
    const client = await liveClient()
    const firstPage = detailLogFrame(0, 730, [
      { rtcSeconds: 1_000, packVoltage: 13.42, current: -8.2 },
      { rtcSeconds: 4_601, packVoltage: 13.38, current: 20.8 },
    ])
    const secondPage = detailLogFrame(1, 732, [{ rtcSeconds: 8_202, packVoltage: 13.51, current: 0 }])

    const reading = client.readDetailLog(PACK_CLOCK)
    mock.notify(concat(firstPage, secondPage))
    await vi.advanceTimersByTimeAsync(2_100)
    const transfer = await reading

    expect(transfer.rawRecords).toHaveLength(transfer.records.length)
    transfer.rawRecords.forEach((raw, position) => {
      expect(raw.index).toBe(transfer.records[position].index)
      expect(raw.bytes).toHaveLength(24)
      // Byte 0..3 is the pack's own counter, which is what the decoder read the instant off.
      expect(new DataView(raw.bytes.buffer, raw.bytes.byteOffset).getUint32(0, true)).toBe(
        (transfer.records[position].packClockMs - Date.UTC(2020, 0, 1)) / 1_000,
      )
    })

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

  it('holds the link through a torn burst and counts every byte the grace admits', async () => {
    vi.useFakeTimers()
    const onDisconnect = vi.fn()
    const client = await liveClient({ onDisconnect })
    const junk = new Uint8Array(20)

    const reading = client.readDetailLog(PACK_CLOCK)
    // Bytes that never become a frame hold nothing open, so the read runs exactly to the
    // first-answer grace — with every byte that fell inside it counted, and the link intact.
    for (let tick = 0; tick < 5; tick += 1) {
      mock.notify(junk)
      await vi.advanceTimersByTimeAsync(1_500)
    }
    await vi.advanceTimersByTimeAsync(700)
    const transfer = await reading

    expect(transfer.outcome).toBe('torn-burst')
    expect(transfer.notificationBytes).toBe(5 * junk.length)
    expect(transfer.elapsedMs).toBe(8_000)
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

    const reading = client.readDetailLog(PACK_CLOCK)
    // A stored-log frame every second rearms the quiet gap forever; only the ceiling ends this.
    for (let tick = 0; tick < 34; tick += 1) {
      mock.notify(detailLogFrame(0, tick, [{ rtcSeconds: tick, packVoltage: 13.2, current: 0 }]))
      await vi.advanceTimersByTimeAsync(1_000)
    }
    const transfer = await reading

    expect(transfer.elapsedMs).toBe(30_000)
    expect(transfer.outcome).toBe('records-read')

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
