// @vitest-environment jsdom
/// <reference types="web-bluetooth" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fixtures from './fixtures.json'
import { holdDecrypt } from './support/pendingDecrypt'
import { fakeWatchRadio } from './support/watchRadio'
import type { FakeWatchRadio } from './support/watchRadio'
import { hexToBytes, toArrayBuffer } from '../src/domain/bytes'
import { SolarWatchScanner } from '../src/infrastructure/ble/SolarWatchScanner'
import { VICTRON_COMPANY_ID } from '../src/domain/solar/types'

// jsdom exposes no navigator.bluetooth and no BluetoothDevice, so the fake radio installs both:
// the device is a real EventTarget, so a dispatched advertisement travels the production listener's
// own path, and WebCrypto is genuinely available so the decode runs for real against a captured
// payload. What is faked and nothing more is the browser's radio; the re-arm loop under test is
// entirely production code, driven by timers.

const payload = hexToBytes(fixtures.victron.payloadHex)
const KEY = fixtures.victron.advertisementKey

let radio: FakeWatchRadio

beforeEach(() => {
  radio = fakeWatchRadio(payload)
  radio.install()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  radio.uninstall()
})

describe('SolarWatchScanner chooser', () => {
  it('asks for Victron manufacturer data, without which the browser withholds every payload', async () => {
    const scanner = new SolarWatchScanner()

    await scanner.start(KEY)

    expect(radio.requestDevice).toHaveBeenCalledWith({
      filters: [{ manufacturerData: [{ companyIdentifier: VICTRON_COMPANY_ID }] }],
      optionalManufacturerData: [VICTRON_COMPANY_ID],
    })
    scanner.stop()
  })

  it('stays stopped when the chooser is allowed after the user pressed Cancel', async () => {
    const readings: unknown[] = []
    let choose = (): void => undefined
    const chosen = new Promise<BluetoothDevice>((resolve) => {
      choose = () => resolve(radio.device)
    })
    radio.requestDevice.mockImplementationOnce(() => chosen)
    const scanner = new SolarWatchScanner({ onReading: (reading) => readings.push(reading) })

    // Cancel is on screen for the whole of the chooser, and pressing it cannot withdraw a prompt
    // the browser has already raised — so Allow resolves a start that is no longer wanted.
    const started = scanner.start(KEY)
    scanner.stop()
    choose()
    await started

    expect(scanner.scanning).toBe(false)
    expect(radio.watchCalls).toHaveLength(0)
    radio.deliver()
    await vi.waitFor(() => expect(readings).toEqual([]))
  })
})

describe('SolarWatchScanner decode lifecycle', () => {
  it('reports a decoded reading from the watched device', async () => {
    const readings: number[] = []
    const errors: Error[] = []
    let foreignDeviceCount = 0
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt')
    const scanner = new SolarWatchScanner({
      onReading: (reading) => readings.push(reading.pvPower ?? -1),
      onForeignDevice: () => {
        foreignDeviceCount += 1
      },
      onError: (error) => errors.push(error),
    })
    await scanner.start(KEY)

    radio.deliver()

    await vi.waitFor(() => expect(readings).toEqual([fixtures.victron.expected.pvPower]))
    // waitFor resolves on the first poll that sees a reading, which is a waypoint. stop() turns it
    // into an end state: the listener comes off the device and the processor drops any decode whose
    // generation has moved on.
    scanner.stop()

    expect(decryptSpy).toHaveBeenCalledTimes(1)
    expect(readings).toEqual([fixtures.victron.expected.pvPower])
    expect(foreignDeviceCount).toBe(0)
    expect(errors).toEqual([])
  })

  it('drops a decode that completes after stop(), so a stale reading cannot resurrect live', async () => {
    const readings: unknown[] = []
    const errors: Error[] = []
    const decrypt = holdDecrypt(toArrayBuffer(hexToBytes(fixtures.victron.plaintextHex)))
    const scanner = new SolarWatchScanner({
      onReading: (reading) => readings.push(reading),
      onError: (error) => errors.push(error),
    })
    await scanner.start(KEY)

    radio.deliver()
    scanner.stop()
    await decrypt.complete()

    // The payload reached the decrypt, so an empty reading list is the generation guard dropping a
    // finished decode rather than a decode that never got that far.
    expect(decrypt.spy).toHaveBeenCalledTimes(1)
    expect(readings).toEqual([])
    expect(errors).toEqual([])
  })
})

describe('SolarWatchScanner re-arm loop', () => {
  it('replaces a watch that has said nothing for five seconds, aborting the stalled one first', async () => {
    vi.useFakeTimers()
    const scanner = new SolarWatchScanner()
    await scanner.start(KEY)

    // Chrome stops delivering after about fifteen seconds while still calling the watch live, so
    // silence rather than an error is the only signal the loop can act on.
    vi.advanceTimersByTime(5_000)

    expect(radio.watchCalls).toHaveLength(2)
    expect(radio.watchCalls[0].aborted).toBe(true)
    expect(radio.watchCalls[1].aborted).toBe(false)
    scanner.stop()
  })

  it('decodes again on the replacement watch, which is the whole point of replacing it', async () => {
    vi.useFakeTimers()
    const readings: number[] = []
    const errors: Error[] = []
    const scanner = new SolarWatchScanner({
      onReading: (reading) => readings.push(reading.pvPower ?? -1),
      onError: (error) => errors.push(error),
    })
    await scanner.start(KEY)

    radio.deliver()
    await vi.waitFor(() => expect(readings).toHaveLength(1))

    // The device still calls the watch live while delivering nothing, so silence is the only
    // symptom the loop can act on — and the fake reproduces that claim exactly.
    vi.advanceTimersByTime(4_000)
    expect(radio.device.watchingAdvertisements).toBe(true)

    vi.advanceTimersByTime(2_000)
    expect(radio.watchCalls).toHaveLength(2)

    radio.deliver()
    await vi.waitFor(() => expect(readings).toHaveLength(2))

    expect(scanner.scanning).toBe(true)
    expect(errors).toEqual([])
    scanner.stop()
  })

  it('holds the watch open on an advertisement carrying no Victron data, which still proves it alive', async () => {
    vi.useFakeTimers()
    const scanner = new SolarWatchScanner()
    await scanner.start(KEY)

    vi.advanceTimersByTime(3_000)
    radio.deliverForeign()
    vi.advanceTimersByTime(3_000)

    // Six seconds since the watch was armed, three since the neighbour spoke. Only the second
    // clock is the watch's own health, so the first must not have re-armed it.
    expect(radio.watchCalls).toHaveLength(1)
    scanner.stop()
  })

  it('tears itself down when the browser refuses the watch, rather than reporting a scan that is not up', async () => {
    vi.useFakeTimers()
    vi.mocked(radio.device.watchAdvertisements).mockRejectedValueOnce(new Error('refused'))
    const scanner = new SolarWatchScanner()

    await expect(scanner.start(KEY)).rejects.toThrow(/Press Connect solar/)

    // Nothing above this class stops a scanner on error, so the failure path has to leave the same
    // clean state the user's own stop does: no listener, no watch, and above all no live interval.
    expect(scanner.scanning).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(30_000)
    expect(radio.watchCalls).toHaveLength(0)
  })

  it('stops re-arming once stopped, and leaves no live watch behind', async () => {
    vi.useFakeTimers()
    const scanner = new SolarWatchScanner()
    await scanner.start(KEY)

    scanner.stop()
    vi.advanceTimersByTime(30_000)

    expect(radio.watchCalls).toHaveLength(1)
    expect(radio.watchCalls[0].aborted).toBe(true)
    expect(scanner.scanning).toBe(false)
  })
})
