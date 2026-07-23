// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fixtures from './fixtures.json'
import { BridgeSolarScan } from '../src/infrastructure/ble/BridgeSolarScan'
import type { VictronHandlers } from '../src/infrastructure/ble/solarScan'

// jsdom's WebSocket would open a real connection, so we swap in a fake we drive by hand — the same
// approach victronScanner.spec takes with navigator.bluetooth. WebCrypto is genuinely available
// under jsdom, so the shared processor's decrypt runs for real against the captured payload.

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

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function toHex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function flushDecrypt(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
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
  delete (globalThis as { WebSocket?: unknown }).WebSocket
})

describe('BridgeSolarScan', () => {
  it('decodes a relayed advertisement into a reading', async () => {
    const readings: number[] = []
    const { socket } = await startScan({ onReading: (reading) => readings.push(reading.pvPower ?? -1) })

    socket.deliver(JSON.stringify({ mfg: PAYLOAD_HEX, rssi: -55 }))
    await flushDecrypt()

    expect(readings).toEqual([fixtures.victron.expected.pvPower])
  })

  it('reports a foreign device for a payload whose key-check byte does not match', async () => {
    let foreign = 0
    let read = 0
    const foreignPayload = bytes(PAYLOAD_HEX)
    // Byte 7 is the key-check byte; flip it so matchesKey fails before any decrypt.
    foreignPayload[7] ^= 0xff
    const { socket } = await startScan({ onForeignDevice: () => (foreign += 1), onReading: () => (read += 1) })

    socket.deliver(JSON.stringify({ mfg: toHex(foreignPayload), rssi: -55 }))
    await flushDecrypt()

    expect(foreign).toBe(1)
    expect(read).toBe(0)
  })

  it('drops a decode that completes after stop()', async () => {
    const readings: unknown[] = []
    const { scan, socket } = await startScan({ onReading: (reading) => readings.push(reading) })

    socket.deliver(JSON.stringify({ mfg: PAYLOAD_HEX, rssi: -55 }))
    scan.stop()
    await flushDecrypt()

    expect(readings).toHaveLength(0)
  })

  it('rejects start when the socket never opens', async () => {
    const scan = new BridgeSolarScan('ws://localhost:8787', {})
    const started = scan.start(KEY)
    FakeWebSocket.last!.onerror?.()

    await expect(started).rejects.toThrow(/Victron bridge/)
  })
})
