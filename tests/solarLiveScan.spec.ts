// @vitest-environment jsdom
/// <reference types="web-bluetooth" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fixtures from './fixtures.json'
import { advertisementEvent } from './support/watchRadio'
import { hexToBytes } from '../src/domain/bytes'
import { SolarLiveScan } from '../src/infrastructure/ble/SolarLiveScan'
import { VICTRON_COMPANY_ID } from '../src/domain/solar/types'

// Both browser radios are faked at once, because the whole point of this class is which of the two
// it reaches for. The scan target resolves a live BluetoothLEScan and stays silent, which is
// exactly what macOS Chrome does; the chooser hands back a device that is never watched for long
// enough to matter here. localStorage is jsdom's own, so the remembered verdict is real.

const payload = hexToBytes(fixtures.victron.payloadHex)
const KEY = fixtures.victron.advertisementKey

interface FakeRadio {
  readonly target: EventTarget
  readonly requestLEScan: ReturnType<typeof vi.fn>
  readonly requestDevice: ReturnType<typeof vi.fn>
  readonly getDevices: ReturnType<typeof vi.fn>
}

function installRadio(routes: { scan: boolean; watch: boolean }): FakeRadio {
  const target = new EventTarget()
  const requestLEScan = vi.fn(async () => ({ active: true, stop: () => undefined }))
  const device = new EventTarget()
  Object.assign(device, { id: 'victron-1', name: 'SmartSolar HQ', watchAdvertisements: vi.fn(async () => undefined) })
  const requestDevice = vi.fn(async () => device)
  const getDevices = vi.fn(async () => [device])

  if (routes.scan) Object.assign(target, { requestLEScan })
  if (routes.watch) {
    Object.assign(target, { requestDevice, getDevices })
    Object.defineProperty(globalThis, 'BluetoothDevice', {
      configurable: true,
      value: class {
        watchAdvertisements(): Promise<void> {
          return Promise.resolve()
        }
      },
    })
  }
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: target })

  return { target, requestLEScan, requestDevice, getDevices }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
  delete (navigator as { bluetooth?: unknown }).bluetooth
  Reflect.deleteProperty(globalThis, 'BluetoothDevice')
  Reflect.deleteProperty(navigator, 'userAgentData')
})

function pretendMacos(): void {
  Object.defineProperty(navigator, 'userAgentData', {
    configurable: true,
    value: { platform: 'macOS' },
  })
}

describe('which radio SolarLiveScan reaches for', () => {
  it('scans when the browser offers only a scan', async () => {
    const radio = installRadio({ scan: true, watch: false })
    const scan = new SolarLiveScan()

    await scan.start(KEY)

    expect(radio.requestLEScan).toHaveBeenCalledTimes(1)
    scan.stop()
  })

  it('watches a chosen device when the browser offers only a chooser', async () => {
    const radio = installRadio({ scan: false, watch: true })
    const scan = new SolarLiveScan()

    await scan.start(KEY)

    expect(radio.requestDevice).toHaveBeenCalledTimes(1)
    scan.stop()
  })

  it('goes straight to the chooser on macOS, where the scan is known never to deliver', async () => {
    pretendMacos()
    const radio = installRadio({ scan: true, watch: true })
    const scan = new SolarLiveScan()

    await scan.start(KEY)

    expect(radio.requestDevice).toHaveBeenCalledTimes(1)
    expect(radio.requestLEScan).not.toHaveBeenCalled()
    scan.stop()
  })

  it('lets a remembered scan verdict outrank the macOS default', async () => {
    pretendMacos()
    const radio = installRadio({ scan: true, watch: true })
    localStorage.setItem('victron.liveTransport', 'scan')
    const scan = new SolarLiveScan()

    await scan.start(KEY)

    expect(radio.requestLEScan).toHaveBeenCalledTimes(1)
    expect(radio.requestDevice).not.toHaveBeenCalled()
    scan.stop()
  })
})

describe('coming back up without a press', () => {
  it('resumes the remembered controller on the watch route, raising no chooser', async () => {
    pretendMacos()
    const radio = installRadio({ scan: true, watch: true })
    const scan = new SolarLiveScan()

    expect(scan.canResume('victron-1')).toBe(true)
    await scan.resume(KEY, 'victron-1')

    expect(radio.getDevices).toHaveBeenCalledTimes(1)
    expect(radio.requestDevice).not.toHaveBeenCalled()
    expect(radio.requestLEScan).not.toHaveBeenCalled()
    expect(scan.scanning).toBe(true)
    scan.stop()
  })

  it('refuses to resume where the browser has only its own scan, which needs the prompt', async () => {
    const radio = installRadio({ scan: true, watch: false })
    const scan = new SolarLiveScan()

    expect(scan.canResume('victron-1')).toBe(false)
    await expect(scan.resume(KEY, 'victron-1')).rejects.toThrow(/Connect solar/)

    expect(radio.requestLEScan).not.toHaveBeenCalled()
  })

  it('keeps a proven scan verdict rather than taking the watch route for a free resume', async () => {
    pretendMacos()
    installRadio({ scan: true, watch: true })
    localStorage.setItem('victron.liveTransport', 'scan')
    const scan = new SolarLiveScan()

    // This browser has heard an advertisement on its own scan, which outranks the platform default
    // and outranks the convenience of a gesture-free start: the route is decided on the evidence,
    // and only then asked whether it can resume.
    expect(scan.canResume('victron-1')).toBe(false)
  })

  it('offers no resume when nothing has been remembered to resume to', () => {
    pretendMacos()
    installRadio({ scan: true, watch: true })
    const scan = new SolarLiveScan()

    expect(scan.canResume(null)).toBe(false)
  })

  it('reports the chosen device up through the relay, so the app can remember it', async () => {
    pretendMacos()
    installRadio({ scan: true, watch: true })
    const watched: Array<[string, string | null]> = []
    const scan = new SolarLiveScan({
      onWatchedDevice: (deviceId, deviceName) => watched.push([deviceId, deviceName]),
    })

    await scan.start(KEY)

    expect(watched).toEqual([['victron-1', 'SmartSolar HQ']])
    scan.stop()
  })
})

describe('what a silent scan teaches the next press', () => {
  it('remembers the watch and asks the user to press again when the scan hears nothing at all', async () => {
    vi.useFakeTimers()
    installRadio({ scan: true, watch: true })
    const errors: string[] = []
    const scan = new SolarLiveScan({ onError: (error) => errors.push(error.message) })
    await scan.start(KEY)

    // No advertisement ever arrives, which on macOS is not a quiet marina but the scan itself.
    vi.advanceTimersByTime(30_000)

    expect(localStorage.getItem('victron.liveTransport')).toBe('watch')
    expect(errors).toEqual([
      'The browser’s scan found nothing. Press Stop solar, then Connect solar, and pick the controller from the list.',
    ])
    scan.stop()
  })

  it('takes the chooser on the next press once the watch has been remembered', async () => {
    const radio = installRadio({ scan: true, watch: true })
    localStorage.setItem('victron.liveTransport', 'watch')
    const scan = new SolarLiveScan()

    await scan.start(KEY)

    expect(radio.requestDevice).toHaveBeenCalledTimes(1)
    expect(radio.requestLEScan).not.toHaveBeenCalled()
    scan.stop()
  })

  it('leaves the scan remembered when it did decode before falling silent, so a sleeping controller costs nothing', async () => {
    vi.useFakeTimers()
    const radio = installRadio({ scan: true, watch: true })
    const readings: number[] = []
    const scan = new SolarLiveScan({ onReading: (reading) => readings.push(reading.pvPower ?? -1) })
    await scan.start(KEY)

    radio.target.dispatchEvent(advertisementEvent(payload, VICTRON_COMPANY_ID, -55))
    await vi.waitFor(() => expect(readings).toEqual([fixtures.victron.expected.pvPower]))
    vi.advanceTimersByTime(30_000)

    expect(localStorage.getItem('victron.liveTransport')).toBe('scan')
    scan.stop()
  })
})
