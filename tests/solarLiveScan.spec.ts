// @vitest-environment jsdom
/// <reference types="web-bluetooth" />

import { afterEach, describe, expect, it, vi } from 'vitest'

import fixtures from './fixtures.json'
import { SolarLiveScan } from '../src/infrastructure/ble/SolarLiveScan'

// Both browser radios are faked at once, because the whole point of this class is which of the two
// it reaches for. The scan target resolves a live BluetoothLEScan and stays silent, which is
// exactly what macOS Chrome does; the chooser hands back a device that is never watched for long
// enough to matter here.

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

afterEach(() => {
  vi.restoreAllMocks()
  delete (navigator as { bluetooth?: unknown }).bluetooth
  Reflect.deleteProperty(globalThis, 'BluetoothDevice')
})

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

  it('takes the chooser whenever both routes exist, so the page can come back up on its own', async () => {
    const radio = installRadio({ scan: true, watch: true })
    const scan = new SolarLiveScan()

    await scan.start(KEY)

    expect(radio.requestDevice).toHaveBeenCalledTimes(1)
    expect(radio.requestLEScan).not.toHaveBeenCalled()
    scan.stop()
  })
})

describe('coming back up without a press', () => {
  it('resumes the remembered controller on the watch route, raising no chooser', async () => {
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

  it('offers no resume when nothing has been remembered to resume to', () => {
    installRadio({ scan: true, watch: true })
    const scan = new SolarLiveScan()

    expect(scan.canResume(null)).toBe(false)
    // Which says nothing about the route: this browser is one chooser tap away from a link that
    // comes back on its own, and a page with nothing remembered must not be told otherwise.
    expect(scan.canEverResume()).toBe(true)
  })

  it('has no way back on the scan route, whatever this browser is shown', () => {
    installRadio({ scan: true, watch: false })
    const scan = new SolarLiveScan()

    expect(scan.canEverResume()).toBe(false)
  })

  it('reports the chosen device up to the caller, so the app can remember it', async () => {
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
