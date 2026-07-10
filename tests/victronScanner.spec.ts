// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fixtures from './fixtures.json'
import { VictronScanner } from '../src/infrastructure/ble/VictronScanner'
import { VICTRON_COMPANY_ID } from '../src/domain/solar/types'

// jsdom exposes no navigator.bluetooth, so we stub it with a real EventTarget whose
// requestLEScan resolves to a live scan. WebCrypto is genuinely available under jsdom, so
// decodeSolarAdvertisement runs for real against a captured payload — the async decrypt is
// exactly the window the stop()/generation race exploits.

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const payload = bytes(fixtures.victron.payloadHex)
const KEY = fixtures.victron.advertisementKey

type ScanTarget = EventTarget & { requestLEScan: (options: unknown) => Promise<BluetoothLEScan> }

let scanTarget: ScanTarget

function installRadio(): void {
  const target = new EventTarget() as ScanTarget
  target.requestLEScan = async () => ({ active: true, stop: () => undefined }) as unknown as BluetoothLEScan
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: target })
  scanTarget = target
}

function advertisement(): Event {
  const event = new Event('advertisementreceived')
  const manufacturerData = new Map<number, DataView>()
  manufacturerData.set(VICTRON_COMPANY_ID, new DataView(payload.buffer, payload.byteOffset, payload.byteLength))
  Object.assign(event, { manufacturerData, rssi: -55 })
  return event
}

async function flushDecrypt(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

beforeEach(() => {
  installRadio()
})

afterEach(() => {
  vi.useRealTimers()
  delete (navigator as { bluetooth?: unknown }).bluetooth
})

describe('VictronScanner decode lifecycle', () => {
  it('reports a decoded reading from the device holding the key', async () => {
    const readings: number[] = []
    const scanner = new VictronScanner({ onReading: (reading) => readings.push(reading.pvPower ?? -1) })
    await scanner.start(KEY)

    scanTarget.dispatchEvent(advertisement())
    await flushDecrypt()

    expect(readings).toHaveLength(1)
    expect(readings[0]).toBe(fixtures.victron.expected.pvPower)
  })

  it('drops a decode that completes after stop(), so a stale reading cannot resurrect live', async () => {
    const readings: unknown[] = []
    const scanner = new VictronScanner({ onReading: (reading) => readings.push(reading) })
    await scanner.start(KEY)

    scanTarget.dispatchEvent(advertisement())
    // Stop before the in-flight decrypt resolves — the generation it captured is now stale.
    scanner.stop()
    await flushDecrypt()

    expect(readings).toHaveLength(0)
  })
})

describe('VictronScanner staleness', () => {
  it('notifies onStale once after the silence window elapses', async () => {
    vi.useFakeTimers()
    const onStale = vi.fn()
    const scanner = new VictronScanner({ onStale })
    await scanner.start(KEY)

    // No advertisement arrives; well past the staleness window the scanner gives up on 'live'.
    vi.advanceTimersByTime(30_000)

    expect(onStale).toHaveBeenCalledTimes(1)
  })
})
