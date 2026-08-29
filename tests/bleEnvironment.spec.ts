/**
 * The browser's own answers to "what can this do" and "is the radio on", driven against a radio
 * the case owns.
 *
 * The distinction under test is between a radio that is switched off and a browser that has no
 * radio to be asked about. The first reports false; the second must report nothing at all, because
 * the tri-state's null is what the requirements list renders as its own unknown level with its own
 * remedy. A probe that answered false for both would collapse two screens into one, and the browser
 * that actually needs the second sentence — Firefox, where no flag will ever help — is the one that
 * would get the wrong one.
 *
 * This runs under plain Node deliberately. Telemetry builds an environment on every construction
 * now, so a host with no `navigator` at all has to be a state and not a crash.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { browserBleEnvironment, detectCapabilities } from '../src/infrastructure/ble/capabilities'

/** Lets the read behind a fire-and-forget availability probe settle before an assertion. */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
}

const hostNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

/**
 * A radio built on a real EventTarget, so the subscribe, the toggle and the unsubscribe all go
 * through the dispatch the browser uses rather than through a recorded call. `requestLEScan` is
 * deliberately absent: a scan-capable radio sends the probe on to read `navigator.platform`, which
 * a host outside a browser does not have.
 */
function installRadio(answers?: () => Promise<boolean>): EventTarget {
  const radio = new EventTarget()
  Object.assign(radio, { requestDevice: async () => ({}), getDevices: async () => [] })
  if (answers) Object.assign(radio, { getAvailability: answers })
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: radio })
  return radio
}

/** A radio with both advertisement routes, which is what a platform verdict has to narrow. */
function installListeningRadio(): void {
  const radio = new EventTarget()
  Object.assign(radio, {
    requestDevice: async () => ({}),
    getDevices: async () => [],
    requestLEScan: async () => ({}),
  })
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: radio })
  Object.defineProperty(globalThis, 'BluetoothDevice', {
    configurable: true,
    value: class {
      watchAdvertisements(): Promise<void> {
        return Promise.resolve()
      }
    },
  })
}

/**
 * What Chromium says about the machine it is running on, for the length of one case.
 *
 * `platform` is left reading Linux throughout on purpose: it is what Chrome reports on Android and
 * on ChromeOS as well as on a Linux desktop, so a probe that reached for it first would be wrong
 * about two of the three. Passing `null` for `reported` is the older build with no `userAgentData`
 * at all, which is the only case where the deprecated string is consulted.
 */
function onPlatform(reported: string | null, agent: string, run: () => void): void {
  const navigatorWas = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const claimed: Record<string, unknown> = {
    platform: 'Linux x86_64',
    userAgent: agent,
    bluetooth: navigator.bluetooth,
  }
  if (reported !== null) claimed.userAgentData = { platform: reported }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: claimed })
  try {
    run()
  } finally {
    if (navigatorWas) Object.defineProperty(globalThis, 'navigator', navigatorWas)
  }
}

function onAHostWithoutNavigator(run: () => void): void {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined })
  try {
    run()
  } finally {
    if (hostNavigator) Object.defineProperty(globalThis, 'navigator', hostNavigator)
  }
}

afterEach(() => {
  if (hostNavigator) Object.defineProperty(globalThis, 'navigator', hostNavigator)
  Reflect.deleteProperty(navigator, 'bluetooth')
})

describe('what the browser says it can do', () => {
  it('reports the platform rather than a fixed answer', () => {
    installRadio(async () => true)

    const { capabilities } = browserBleEnvironment()

    expect(capabilities).toEqual(detectCapabilities())
    expect(capabilities.canConnect).toBe(true)
    expect(capabilities.canReconnect).toBe(true)
  })

  it('reports nothing available on a host with no radio', () => {
    expect(browserBleEnvironment().capabilities.hasBluetooth).toBe(false)
  })
})

/**
 * Linux is the one platform where feature detection lies. Both advertisement APIs are there, both
 * resolve, and the observer underneath never fires — so the honest answer has to come from the
 * platform rather than from the presence of the calls, or the page offers a control that can never
 * do anything.
 */
describe('what the platform says about listening for a controller', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'BluetoothDevice')
  })

  it('offers no solar on Linux, however much of the API is present', () => {
    installListeningRadio()

    onPlatform('Linux', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0.0.0', () => {
      const capabilities = detectCapabilities()

      expect(capabilities.canScan).toBe(true)
      expect(capabilities.canWatchAdvertisements).toBe(true)
      expect(capabilities.platformDeliversAdvertisements).toBe(false)
      expect(capabilities.canListenSolar).toBe(false)
      // The pack is a GATT connection and has nothing to do with any of this.
      expect(capabilities.canConnect).toBe(true)
    })
  })

  it('offers solar on macOS, where the watch route delivers and the scan does not', () => {
    installListeningRadio()

    onPlatform('macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0', () => {
      const capabilities = detectCapabilities()

      expect(capabilities.platformDeliversAdvertisements).toBe(true)
      expect(capabilities.canListenSolar).toBe(true)
      expect(capabilities.scanKnownSilent).toBe(true)
    })
  })

  it('offers solar on Android, whose navigator.platform says Linux', () => {
    installListeningRadio()

    // The word Linux reaches the deprecated fallback from a phone that reads advertisements
    // perfectly well, so believing it there would take the feature off the owner's own handset.
    onPlatform('Android', 'Mozilla/5.0 (Linux; Android 15; SM-S926B) Chrome/141.0.0.0', () => {
      const capabilities = detectCapabilities()

      expect(capabilities.platformDeliversAdvertisements).toBe(true)
      expect(capabilities.canListenSolar).toBe(true)
      expect(capabilities.scanKnownSilent).toBe(false)
    })
  })

  it('believes the deprecated platform string only once Android and ChromeOS are ruled out', () => {
    installListeningRadio()
    const delivers: Record<string, boolean> = {}
    const agents: Record<string, string> = {
      linux: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0.0.0',
      android: 'Mozilla/5.0 (Linux; Android 15; SM-S926B) Chrome/141.0.0.0',
      chromeos: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/141.0.0.0',
    }

    for (const [host, agent] of Object.entries(agents)) {
      onPlatform(null, agent, () => {
        delivers[host] = detectCapabilities().platformDeliversAdvertisements
      })
    }

    expect(delivers).toEqual({ linux: false, android: true, chromeos: true })
  })
})

describe('watching the radio', () => {
  it('reports availability straight away, without being asked twice', async () => {
    installRadio(async () => true)
    const reported: Array<boolean | null> = []

    browserBleEnvironment().watchAdapter((available) => reported.push(available))
    await flushMicrotasks()

    expect(reported).toEqual([true])
  })

  it('re-reads the radio every time the user toggles it', async () => {
    let switchedOn = true
    const radio = installRadio(async () => switchedOn)
    const reported: Array<boolean | null> = []

    browserBleEnvironment().watchAdapter((available) => reported.push(available))
    await flushMicrotasks()

    switchedOn = false
    radio.dispatchEvent(new Event('availabilitychanged'))
    await flushMicrotasks()

    expect(reported).toEqual([true, false])
  })

  it('lets go of the radio when the watch is stopped', async () => {
    const radio = installRadio(async () => true)
    const reported: Array<boolean | null> = []

    const stop = browserBleEnvironment().watchAdapter((available) => reported.push(available))
    await flushMicrotasks()
    stop()
    radio.dispatchEvent(new Event('availabilitychanged'))
    await flushMicrotasks()

    expect(reported).toEqual([true])
  })

  it('answers null when the radio is there but will not say', async () => {
    installRadio()
    const reported: Array<boolean | null> = []

    browserBleEnvironment().watchAdapter((available) => reported.push(available))
    await flushMicrotasks()

    expect(reported).toEqual([null])
  })

  it('answers null when the availability read rejects', async () => {
    installRadio(async () => {
      throw new DOMException('Bluetooth adapter not available.', 'NotFoundError')
    })
    const reported: Array<boolean | null> = []

    browserBleEnvironment().watchAdapter((available) => reported.push(available))
    await flushMicrotasks()

    expect(reported).toEqual([null])
  })

  it('never calls back at all when the browser has no radio', async () => {
    const reported: Array<boolean | null> = []

    const stop = browserBleEnvironment().watchAdapter((available) => reported.push(available))
    await flushMicrotasks()
    stop()

    expect(reported).toEqual([])
  })

  it('answers a host with no navigator instead of throwing', () => {
    onAHostWithoutNavigator(() => {
      const environment = browserBleEnvironment()

      expect(environment.capabilities.hasBluetooth).toBe(false)
      expect(() => environment.watchAdapter(() => undefined)()).not.toThrow()
    })
  })
})
