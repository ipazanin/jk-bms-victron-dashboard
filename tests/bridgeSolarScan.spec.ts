// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fixtures from './fixtures.json'
import { holdDecrypt } from './support/pendingDecrypt'
import { hexToBytes, toArrayBuffer } from '../src/domain/bytes'
import { BridgeSolarScan } from '../src/infrastructure/ble/BridgeSolarScan'
import type { VictronHandlers } from '../src/infrastructure/ble/solarScan'

// jsdom's WebSocket would open a real connection, so we swap in a fake we drive by hand — the same
// approach victronScanner.spec takes with navigator.bluetooth. WebCrypto is genuinely available
// under jsdom, so the shared processor's decrypt runs for real against the captured payload —
// except where a spec has to pin the moment the decode lands and holds the decrypt open itself.

class FakeWebSocket {
  static readonly OPEN = 1
  static last: FakeWebSocket | null = null

  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeWebSocket.last = this
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  deliver(data: string): void {
    this.onmessage?.({ data })
  }

  close(): void {
    this.readyState = 3
  }
}

function toHex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const KEY = fixtures.victron.advertisementKey
const PAYLOAD_HEX = fixtures.victron.payloadHex

async function startScan(handlers: VictronHandlers): Promise<{ scan: BridgeSolarScan; socket: FakeWebSocket }> {
  const scan = new BridgeSolarScan('ws://localhost:8787', handlers)
  const started = scan.start(KEY)
  const socket = FakeWebSocket.last!
  socket.open()
  await started
  return { scan, socket }
}

beforeEach(() => {
  ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
  FakeWebSocket.last = null
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as { WebSocket?: unknown }).WebSocket
})

describe('BridgeSolarScan', () => {
  it('decodes a relayed advertisement into a reading', async () => {
    const readings: number[] = []
    const errors: Error[] = []
    let foreignDeviceCount = 0
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt')
    const { scan, socket } = await startScan({
      onReading: (reading) => readings.push(reading.pvPower ?? -1),
      onForeignDevice: () => {
        foreignDeviceCount += 1
      },
      onError: (error) => errors.push(error),
    })

    socket.deliver(JSON.stringify({ mfg: PAYLOAD_HEX, rssi: -55 }))

    await vi.waitFor(() => expect(readings).toEqual([fixtures.victron.expected.pvPower]))
    // waitFor resolves on the first poll that sees a reading, which is a waypoint. stop() turns it
    // into an end state: the processor ingests nothing more and drops any decode whose generation
    // has moved on, so no second reading or foreign device can land for this frame after here.
    scan.stop()

    // One frame in, one decrypt attempted. The frame reaches the decrypt synchronously, so a frame
    // fed to the processor twice fails here whether or not its second decode has resolved yet.
    expect(decryptSpy).toHaveBeenCalledTimes(1)
    expect(readings).toEqual([fixtures.victron.expected.pvPower])
    expect(foreignDeviceCount).toBe(0)
    expect(errors).toEqual([])
  })

  it('reports a foreign device for a payload whose key-check byte does not match', async () => {
    let foreignDeviceCount = 0
    let readingCount = 0
    const errors: Error[] = []
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt')
    const foreignPayload = hexToBytes(PAYLOAD_HEX)
    // Byte 7 is the key-check byte; flip it so matchesKey fails before any decrypt.
    foreignPayload[7] ^= 0xff
    const { scan, socket } = await startScan({
      onForeignDevice: () => {
        foreignDeviceCount += 1
      },
      onReading: () => {
        readingCount += 1
      },
      onError: (error) => errors.push(error),
    })

    socket.deliver(JSON.stringify({ mfg: toHex(foreignPayload), rssi: -55 }))

    await vi.waitFor(() => expect(foreignDeviceCount).toBe(1))
    scan.stop()

    // The negatives stay outside waitFor: it resolves the moment its callback stops throwing, so a
    // zero reading count inside it would pass on the very first poll, proving only that no decode
    // had landed yet. After stop() no reading can land at all, so the same assertion here is a
    // claim about the end state.
    expect(readingCount).toBe(0)
    expect(decryptSpy).not.toHaveBeenCalled()
    expect(foreignDeviceCount).toBe(1)
    expect(errors).toEqual([])
  })

  it('drops a decode that completes after stop()', async () => {
    const readings: unknown[] = []
    const errors: Error[] = []
    const decrypt = holdDecrypt(toArrayBuffer(hexToBytes(fixtures.victron.plaintextHex)))
    const { scan, socket } = await startScan({
      onReading: (reading) => readings.push(reading),
      onError: (error) => errors.push(error),
    })

    socket.deliver(JSON.stringify({ mfg: PAYLOAD_HEX, rssi: -55 }))
    scan.stop()
    await decrypt.complete()

    // The payload reached the decrypt, so an empty reading list is the generation guard dropping a
    // finished decode rather than a decode that never got that far; no error stands in for it either.
    expect(decrypt.spy).toHaveBeenCalledTimes(1)
    expect(readings).toEqual([])
    expect(errors).toEqual([])
  })

  it('rejects start when the socket never opens', async () => {
    const scan = new BridgeSolarScan('ws://localhost:8787', {})
    const started = scan.start(KEY)
    FakeWebSocket.last!.onerror?.()

    await expect(started).rejects.toThrow(/Victron bridge/)
  })
})
