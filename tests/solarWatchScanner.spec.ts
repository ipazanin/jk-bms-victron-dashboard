// @vitest-environment jsdom
/// <reference types="web-bluetooth" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fixtures from './fixtures.json'
import { holdDecrypt } from './support/pendingDecrypt'
import { fakeWatchRadio } from './support/watchRadio'
import type { FakeWatchRadio } from './support/watchRadio'
import { scriptedPage } from './support/scriptedPage'
import type { ScriptedPage } from './support/scriptedPage'
import { hexToBytes, toArrayBuffer } from '../src/domain/bytes'
import { SolarWatchScanner } from '../src/infrastructure/ble/SolarWatchScanner'
import type { VictronHandlers } from '../src/infrastructure/ble/solarScan'
import { VICTRON_COMPANY_ID } from '../src/domain/solar/types'

// jsdom exposes no navigator.bluetooth and no BluetoothDevice, so the fake radio installs both:
// the device is a real EventTarget, so a dispatched advertisement travels the production listener's
// own path, and WebCrypto is genuinely available so the decode runs for real against a captured
// payload. What is faked and nothing more is the browser's radio; the re-arm loop under test is
// entirely production code, driven by timers.

const payload = hexToBytes(fixtures.victron.payloadHex)
const KEY = fixtures.victron.advertisementKey

let radio: FakeWatchRadio
let page: ScriptedPage

beforeEach(() => {
  radio = fakeWatchRadio(payload)
  radio.install()
  page = scriptedPage()
})

/**
 * The scanner under a window that is in front. The page is supplied rather than read because jsdom
 * answers `document.hasFocus()` with false for every document, and a scanner told its window is
 * behind another one deliberately asks for no watches at all.
 */
function watchScanner(handlers: VictronHandlers = {}): SolarWatchScanner {
  return new SolarWatchScanner(handlers, page.activity)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  radio.uninstall()
})

describe('SolarWatchScanner chooser', () => {
  it('asks for Victron manufacturer data, without which the browser withholds every payload', async () => {
    const scanner = watchScanner()

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
    const scanner = watchScanner({ onReading: (reading) => readings.push(reading) })

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

  it('stays stopped when the browser brings the watch up after the user pressed Stop', async () => {
    vi.useFakeTimers()
    const watched: string[] = []
    let armWatch = (): void => undefined
    const arming = new Promise<void>((resolve) => {
      armWatch = () => resolve()
    })
    vi.mocked(radio.device.watchAdvertisements).mockImplementationOnce(() => arming)
    const scanner = watchScanner({ onWatchedDevice: (deviceId) => watched.push(deviceId) })

    // Bringing a watch up takes the browser a moment, and Stop is on screen for the whole of it.
    const resuming = scanner.resume(KEY, 'victron-1')
    await vi.waitFor(() => expect(radio.device.watchAdvertisements).toHaveBeenCalledTimes(1))
    scanner.stop()
    armWatch()
    await resuming

    // Naming the controller here would have the page remember the very device the press just told
    // it to forget, and put the watch back up seconds later over the owner's answer.
    expect(watched).toEqual([])
    expect(scanner.scanning).toBe(false)
    // And the silence loop must not outlive the scan it was pacing.
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('SolarWatchScanner resume', () => {
  it('watches the remembered controller with no chooser at all', async () => {
    const scanner = watchScanner()

    await scanner.resume(KEY, 'victron-1')

    expect(radio.requestDevice).not.toHaveBeenCalled()
    expect(radio.getDevices).toHaveBeenCalledTimes(1)
    expect(radio.watchCalls).toHaveLength(1)
    expect(scanner.scanning).toBe(true)
    scanner.stop()
  })

  it('decodes on the resumed watch, which is the whole point of resuming it', async () => {
    const readings: number[] = []
    const scanner = watchScanner({ onReading: (reading) => readings.push(reading.pvPower ?? -1) })
    await scanner.resume(KEY, 'victron-1')

    radio.deliver()

    await vi.waitFor(() => expect(readings).toEqual([fixtures.victron.expected.pvPower]))
    scanner.stop()
  })

  it('reports the device it is watching, by both routes, so it can be gone back to', async () => {
    const watched: Array<[string, string | null]> = []
    const scanner = watchScanner({
      onWatchedDevice: (deviceId, deviceName) => watched.push([deviceId, deviceName]),
    })

    await scanner.start(KEY)
    await scanner.resume(KEY, 'victron-1')

    expect(watched).toEqual([
      ['victron-1', 'SmartSolar HQ'],
      ['victron-1', 'SmartSolar HQ'],
    ])
    scanner.stop()
  })

  it('says nothing about a device whose watch the browser refused', async () => {
    const watched: string[] = []
    vi.mocked(radio.device.watchAdvertisements).mockRejectedValueOnce(new Error('refused'))
    const scanner = watchScanner({ onWatchedDevice: (deviceId) => watched.push(deviceId) })

    await expect(scanner.start(KEY)).rejects.toThrow(/Press Connect solar/)

    // Remembering it would have the next page load go straight back to a handle this browser has
    // just proven it cannot watch, and do it without ever raising the chooser that would fix it.
    expect(watched).toEqual([])
  })

  it('asks the browser for a fresh watch rather than trusting the one it is holding', async () => {
    const scanner = watchScanner()
    await scanner.resume(KEY, 'victron-1')
    expect(radio.watchCalls).toHaveLength(1)
    // Chromium destroys every advertisement client when the window loses focus and tells only the
    // ones still pending, so this flag goes on reading true over a watch that is already dead. It
    // is the one thing here never to believe.
    expect(radio.device.watchingAdvertisements).toBe(true)

    await scanner.resume(KEY, 'victron-1')

    expect(radio.watchCalls).toHaveLength(2)
    expect(radio.watchCalls[0].aborted).toBe(true)
    expect(radio.watchCalls[1].aborted).toBe(false)
    scanner.stop()
  })

  it('refuses a controller this origin is no longer permitted, naming the chooser as the fix', async () => {
    radio.revokePermission()
    const scanner = watchScanner()

    // Permission and range are different questions, and only this one has an answer the owner can
    // act on: no amount of waiting puts a revoked grant back.
    await expect(scanner.resume(KEY, 'victron-1')).rejects.toMatchObject({
      refusal: 'permission-gone',
    })
    expect(scanner.scanning).toBe(false)
    expect(radio.watchCalls).toHaveLength(0)
  })

  it('refuses when this browser has never been shown a controller', async () => {
    const scanner = watchScanner()

    await expect(scanner.resume(KEY, null)).rejects.toMatchObject({ refusal: 'permission-gone' })
    expect(radio.getDevices).not.toHaveBeenCalled()
  })

  it('offers no resume without a remembered id, however capable the browser is', () => {
    const scanner = watchScanner()

    expect(scanner.canResume('victron-1')).toBe(true)
    expect(scanner.canResume(null)).toBe(false)
  })

  it('offers no resume on a browser that will not list its permitted devices', () => {
    Object.defineProperty(navigator, 'bluetooth', {
      configurable: true,
      value: { requestDevice: radio.requestDevice },
    })
    const scanner = watchScanner()

    expect(scanner.canResume('victron-1')).toBe(false)
  })
})

describe('SolarWatchScanner decode lifecycle', () => {
  it('reports a decoded reading from the watched device', async () => {
    const readings: number[] = []
    const errors: Error[] = []
    const rejections: string[] = []
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt')
    const scanner = watchScanner({
      onReading: (reading) => readings.push(reading.pvPower ?? -1),
      onUnreadable: (rejection) => rejections.push(rejection),
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
    expect(rejections).toEqual([])
    expect(errors).toEqual([])
  })

  it('drops a decode that completes after stop(), so a stale reading cannot resurrect live', async () => {
    const readings: unknown[] = []
    const errors: Error[] = []
    const decrypt = holdDecrypt(toArrayBuffer(hexToBytes(fixtures.victron.plaintextHex)))
    const scanner = watchScanner({
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

/** Drives the fake clock on, noting the moment of every fresh watch this scanner asked for. */
function registrationsOver(totalMs: number): number[] {
  const moments: number[] = []
  let counted = radio.watchCalls.length
  for (let elapsed = 0; elapsed < totalMs; elapsed += 250) {
    vi.advanceTimersByTime(250)
    while (counted < radio.watchCalls.length) {
      moments.push(Date.now())
      counted += 1
    }
  }
  return moments
}

/**
 * The same, with an advertisement landing every `gapMs` throughout.
 *
 * A controller at the edge of range is the case the ladder's own arithmetic never covers: Victron
 * broadcasts about once a second and most of those are lost, so what lands arrives in gaps — and
 * every arrival is proof the watch is alive, which puts the ladder back on its first rung before it
 * has climbed anywhere.
 */
function registrationsHearingSomethingEvery(gapMs: number, totalMs: number): number[] {
  const moments: number[] = []
  let counted = radio.watchCalls.length
  let sinceHeard = 0
  for (let elapsed = 0; elapsed < totalMs; elapsed += 250) {
    vi.advanceTimersByTime(250)
    sinceHeard += 250
    if (sinceHeard >= gapMs) {
      sinceHeard = 0
      radio.deliver()
    }
    while (counted < radio.watchCalls.length) {
      moments.push(Date.now())
      counted += 1
    }
  }
  return moments
}

/** The most registrations any rolling thirty-second window over these moments holds. */
function busiestWindow(moments: readonly number[]): number {
  return Math.max(
    0,
    ...moments.map(
      (start) => moments.filter((moment) => moment >= start && moment < start + 30_000).length,
    ),
  )
}

describe('SolarWatchScanner re-arm loop', () => {
  it('never crosses Android’s scan quota, however long the controller stays silent', async () => {
    vi.useFakeTimers()
    const scanner = watchScanner()
    await scanner.start(KEY)
    const armedAt = Date.now()

    const moments = [armedAt, ...registrationsOver(120_000)]
    scanner.stop()

    // AOSP allows five scan registrations per thirty seconds per app and drops the sixth without
    // posting SCAN_FAILED_SCANNING_TOO_FREQUENTLY, so a loop over quota blackholes itself and
    // cannot tell that from an empty berth. Four leaves the pack's own sighting watch room.
    expect(busiestWindow(moments)).toBeLessThanOrEqual(4)
    // And the first step stays quick: a stalled watch on a controller that is there recovers about
    // a second after being asked again, which is worth having on the common failure.
    expect(moments[1] - armedAt).toBe(3_000)
    // The ladder has to grow, or the quota above would be met by pacing alone and a berth with no
    // controller in it would cost the radio a scan every three seconds all night.
    expect(moments.slice(0, 5).map((moment) => moment - armedAt)).toEqual([0, 3_000, 9_000, 21_000, 45_000])
  })

  it('never crosses it against a controller heard in gaps either, which is the ordinary berth', async () => {
    vi.useFakeTimers()
    const scanner = watchScanner()
    await scanner.start(KEY)
    const armedAt = Date.now()

    const moments = [armedAt, ...registrationsHearingSomethingEvery(4_000, 120_000)]
    scanner.stop()

    // The bound has to hold against any arrival pattern, not only against silence. Four seconds
    // between advertisements is longer than the ladder's first rung, so the ladder alone would be
    // reset before it ever grew and would ask for a fresh watch every three seconds all afternoon —
    // twice the quota, and every registration past the fifth dropped without a word.
    expect(busiestWindow(moments)).toBeLessThanOrEqual(4)
    // Under the budget rather than beside it: the loop is still replacing watches, only no faster
    // than the platform will honour. A loop that answered the quota by going quiet would be trading
    // one silent failure for another.
    expect(moments.length).toBeGreaterThan(4)
  })

  it('never crosses it while the owner clicks in and out of the window either', async () => {
    vi.useFakeTimers()
    const scanner = watchScanner()
    await scanner.start(KEY)
    const moments = [Date.now()]
    let counted = radio.watchCalls.length

    // Coming back to the front puts the ladder on its first rung for the same reason an
    // advertisement does — Chromium killed the watch on the way out — so a window being clicked
    // away from and back to is the second route to the same three-second cadence.
    for (let elapsed = 0; elapsed < 120_000; elapsed += 250) {
      vi.advanceTimersByTime(250)
      if (elapsed % 4_000 === 0) {
        page.blur()
        page.focus()
      }
      while (counted < radio.watchCalls.length) {
        moments.push(Date.now())
        counted += 1
      }
    }
    scanner.stop()

    expect(busiestWindow(moments)).toBeLessThanOrEqual(4)
  })

  it('replaces a watch that has said nothing for the first step, aborting the stalled one first', async () => {
    vi.useFakeTimers()
    const scanner = watchScanner()
    await scanner.start(KEY)

    // Chrome stops delivering after about fifteen seconds while still calling the watch live, so
    // silence rather than an error is the only signal the loop can act on.
    vi.advanceTimersByTime(3_000)

    expect(radio.watchCalls).toHaveLength(2)
    expect(radio.watchCalls[0].aborted).toBe(true)
    expect(radio.watchCalls[1].aborted).toBe(false)
    scanner.stop()
  })

  it('goes back to the quick first step the moment an advertisement arrives', async () => {
    vi.useFakeTimers()
    const scanner = watchScanner()
    await scanner.start(KEY)

    // Three re-arms in: the next wait the ladder has queued up is twenty-four seconds.
    vi.advanceTimersByTime(12_000)
    expect(radio.watchCalls).toHaveLength(3)

    radio.deliver()
    vi.advanceTimersByTime(3_000)

    // An advertisement is the only proof a watch is alive, so it is also the only thing that may
    // put the ladder back to the top. Without the reset the next stall would go unanswered for
    // most of a minute.
    expect(radio.watchCalls).toHaveLength(4)
    scanner.stop()
  })

  it('decodes again on the replacement watch, which is the whole point of replacing it', async () => {
    vi.useFakeTimers()
    const readings: number[] = []
    const errors: Error[] = []
    const scanner = watchScanner({
      onReading: (reading) => readings.push(reading.pvPower ?? -1),
      onError: (error) => errors.push(error),
    })
    await scanner.start(KEY)

    radio.deliver()
    await vi.waitFor(() => expect(readings).toHaveLength(1))

    // The device still calls the watch live while delivering nothing, so silence is the only
    // symptom the loop can act on — and the fake reproduces that claim exactly.
    expect(radio.device.watchingAdvertisements).toBe(true)

    vi.advanceTimersByTime(3_000)
    expect(radio.watchCalls).toHaveLength(2)

    radio.deliver()
    await vi.waitFor(() => expect(readings).toHaveLength(2))

    expect(scanner.scanning).toBe(true)
    expect(errors).toEqual([])
    scanner.stop()
  })

  it('holds the watch open on an advertisement carrying no Victron data, which still proves it alive', async () => {
    vi.useFakeTimers()
    const scanner = watchScanner()
    await scanner.start(KEY)

    vi.advanceTimersByTime(2_000)
    radio.deliverForeign()
    vi.advanceTimersByTime(2_000)

    // Four seconds since the watch was armed, two since the neighbour spoke. Only the second clock
    // is the watch's own health, so the first must not have re-armed it.
    expect(radio.watchCalls).toHaveLength(1)
    scanner.stop()
  })

  it('asks for nothing behind a window that is not in front, and is quick again when it returns', async () => {
    vi.useFakeTimers()
    const scanner = watchScanner()
    await scanner.start(KEY)
    vi.advanceTimersByTime(12_000)
    const armedWhileInFront = radio.watchCalls.length

    page.blur()
    vi.advanceTimersByTime(120_000)

    // Chromium tore this watch down when the window lost focus and fired nothing to say so. Asking
    // for another one behind the window spends Android's quota on a scan nothing can reach, and
    // spends it exactly when the owner is about to come back and want one.
    expect(radio.watchCalls).toHaveLength(armedWhileInFront)

    page.focus()
    vi.advanceTimersByTime(3_000)

    // Back on the first step rather than at the ceiling the ladder had climbed to: the owner who
    // has just come back should not wait half a minute for a watch the platform killed.
    expect(radio.watchCalls).toHaveLength(armedWhileInFront + 1)
    scanner.stop()
  })

  it('tears itself down when the browser refuses the watch, rather than reporting a scan that is not up', async () => {
    vi.useFakeTimers()
    vi.mocked(radio.device.watchAdvertisements).mockRejectedValueOnce(new Error('refused'))
    const scanner = watchScanner()

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
    const scanner = watchScanner()
    await scanner.start(KEY)

    scanner.stop()
    vi.advanceTimersByTime(30_000)

    expect(radio.watchCalls).toHaveLength(1)
    expect(radio.watchCalls[0].aborted).toBe(true)
    expect(scanner.scanning).toBe(false)
  })
})
