// @vitest-environment jsdom
/// <reference types="web-bluetooth" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fixtures from './fixtures.json'
import { hexToBytes } from './support/bytes'
import { holdDecrypt } from './support/pendingDecrypt'
import { advertisementEvent } from './support/watchRadio'
import { toArrayBuffer } from '../src/domain/bytes'
import { VictronScanner } from '../src/infrastructure/ble/VictronScanner'
import { VICTRON_COMPANY_ID } from '../src/domain/solar/types'

// jsdom exposes no navigator.bluetooth, so we stub it with a real EventTarget whose
// requestLEScan resolves to a live scan. WebCrypto is genuinely available under jsdom, so
// decodeSolarAdvertisement runs for real against a captured payload — the async decrypt is
// exactly the window the stop()/generation race exploits, which is why the race's own spec holds
// that decrypt open rather than letting it settle whenever it likes.

const payload = hexToBytes(fixtures.victron.payloadHex)
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
  return advertisementEvent(payload, VICTRON_COMPANY_ID, -55)
}

beforeEach(() => {
  installRadio()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (navigator as { bluetooth?: unknown }).bluetooth
})

describe('VictronScanner decode lifecycle', () => {
  it('reports a decoded reading from the device holding the key', async () => {
    const readings: number[] = []
    const errors: Error[] = []
    let foreignDeviceCount = 0
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt')
    const scanner = new VictronScanner({
      onReading: (reading) => readings.push(reading.pvPower ?? -1),
      onForeignDevice: () => {
        foreignDeviceCount += 1
      },
      onError: (error) => errors.push(error),
    })
    await scanner.start(KEY)

    scanTarget.dispatchEvent(advertisement())

    await vi.waitFor(() => expect(readings).toEqual([fixtures.victron.expected.pvPower]))
    // waitFor resolves on the first poll that sees a reading, which is a waypoint. stop() turns it
    // into an end state: the listener comes off and the processor drops any decode whose generation
    // has moved on, so no second reading or foreign device can land for this advertisement.
    scanner.stop()

    // One advertisement in, one decrypt attempted. The payload reaches the decrypt synchronously,
    // so a listener left on twice fails here whether or not its second decode has resolved yet.
    expect(decryptSpy).toHaveBeenCalledTimes(1)
    expect(readings).toEqual([fixtures.victron.expected.pvPower])
    expect(foreignDeviceCount).toBe(0)
    expect(errors).toEqual([])
  })

  it('drops a decode that completes after stop(), so a stale reading cannot resurrect live', async () => {
    const readings: unknown[] = []
    const errors: Error[] = []
    const decrypt = holdDecrypt(toArrayBuffer(hexToBytes(fixtures.victron.plaintextHex)))
    const scanner = new VictronScanner({
      onReading: (reading) => readings.push(reading),
      onError: (error) => errors.push(error),
    })
    await scanner.start(KEY)

    scanTarget.dispatchEvent(advertisement())
    // Stop before the in-flight decrypt resolves — the generation it captured is now stale.
    scanner.stop()
    await decrypt.complete()

    // The payload reached the decrypt, so an empty reading list is the generation guard dropping a
    // finished decode rather than a decode that never got that far; no error stands in for it either.
    expect(decrypt.spy).toHaveBeenCalledTimes(1)
    expect(readings).toEqual([])
    expect(errors).toEqual([])
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
