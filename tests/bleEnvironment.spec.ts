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
