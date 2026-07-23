// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTelemetry } from '../src/application/telemetry'
import type { Telemetry, TelemetryDeps } from '../src/application/telemetry'
import { saveRememberedSession } from '../src/application/rememberedSession'
import type { RememberedSession } from '../src/application/rememberedSession'
import type { BatterySnapshot } from '../src/domain/bms/types'
import { SNAPSHOT_SCHEMA_VERSION } from '../src/domain/schemaVersion'
import { JkBmsClient } from '../src/infrastructure/ble/JkBmsClient'
import { VictronScanner } from '../src/infrastructure/ble/VictronScanner'
import { battery, rememberedSession, sessionRecord, solarReading } from './support/samples'
import { fakeBmsLink, fakeSolarScan } from './support/fakeRadios'
import type { FakeBmsLink, FakeSolarScan } from './support/fakeRadios'

// Each case builds its own telemetry and throws it away, so nothing leaks between them: the
// windows, the fault latch and the recorder are all per-instance. The failure-path cases run
// against the REAL adapters, because jsdom exposes no navigator.bluetooth and both radios
// therefore genuinely throw — which is exactly the restore/fallback path under test.

const KEY = 'shunt.rememberedSession'
const VALID_ADVERTISEMENT_KEY = '0123456789abcdef0123456789abcdef'

function session(overrides: Partial<RememberedSession> = {}): RememberedSession {
  return rememberedSession({ capturedAt: Date.now() - 5 * 60 * 1000, ...overrides })
}

function radioDeps(): TelemetryDeps {
  return {
    createBmsLink: (handlers) => new JkBmsClient(handlers),
    createSolarScan: (handlers) => new VictronScanner(handlers),
    historyStore: () => null,
    now: () => Date.now(),
    monotonic: () => performance.now(),
    newId: () => crypto.randomUUID(),
  }
}

let telemetry: Telemetry

afterEach(() => {
  telemetry.dispose()
  localStorage.clear()
})

describe('remembered session restore', () => {
  beforeEach(() => {
    localStorage.clear()
    telemetry = createTelemetry(radioDeps())
  })

  it('restores a valid on-disk session into the remembered view', () => {
    const saved = session()
    saveRememberedSession(saved)

    const restored = telemetry.restoreRemembered()

    expect(restored).toBe(true)
    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).toEqual(saved.battery)
    expect(telemetry.rememberedAt.value).toBe(saved.capturedAt)
  })

  it('forgetting clears the view and removes the on-disk session', () => {
    saveRememberedSession(session())
    telemetry.restoreRemembered()

    telemetry.forgetRemembered()

    expect(telemetry.source.value).toBe('none')
    expect(telemetry.battery.value).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('does not restore a corrupt payload and stays on the landing', () => {
    localStorage.setItem(KEY, 'not json {')

    const restored = telemetry.restoreRemembered()

    expect(restored).toBe(false)
    expect(telemetry.source.value).toBe('none')
    expect(telemetry.battery.value).toBeNull()
  })
})

describe('failed connect falls back to the remembered view', () => {
  beforeEach(() => {
    localStorage.clear()
    telemetry = createTelemetry(radioDeps())
  })

  it('restores the remembered view after connectBms throws with no Web Bluetooth', async () => {
    const saved = session()
    saveRememberedSession(saved)
    telemetry.restoreRemembered()

    await telemetry.connectBms()

    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).toEqual(saved.battery)
    expect(telemetry.bmsError.value).not.toBeNull()
  })

  it('restores the remembered view after startSolar throws with no Web Bluetooth', async () => {
    const saved = session()
    saveRememberedSession(saved)
    telemetry.restoreRemembered()

    await telemetry.startSolar(VALID_ADVERTISEMENT_KEY)

    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).toEqual(saved.battery)
    expect(telemetry.solarError.value).not.toBeNull()
  })
})

describe('ending a live session that produced no battery snapshot', () => {
  // A stub radio lets the scanner genuinely reach 'live' inside jsdom, so stopping it
  // exercises settleAfterLive's no-battery branch — the one that must fall back to the
  // on-disk session instead of stranding the user on the blank landing.
  beforeEach(() => {
    Object.defineProperty(navigator, 'bluetooth', {
      configurable: true,
      value: {
        requestLEScan: async () => ({ active: true, stop: () => undefined }),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    })
    localStorage.clear()
    telemetry = createTelemetry(radioDeps())
  })

  afterEach(() => {
    delete (navigator as { bluetooth?: unknown }).bluetooth
  })

  it('stopping a solar-only scan falls back to the remembered view on disk', async () => {
    const saved = session()
    saveRememberedSession(saved)
    telemetry.restoreRemembered()

    await telemetry.startSolar(VALID_ADVERTISEMENT_KEY)
    // The scan is genuinely running: no advertisement decoded yet, so no battery either.
    expect(telemetry.source.value).toBe('live')
    expect(telemetry.solarState.value).toBe('listening')
    expect(telemetry.battery.value).toBeNull()

    telemetry.stopSolar()

    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).toEqual(saved.battery)
    expect(telemetry.rememberedAt.value).toBe(saved.capturedAt)
  })

  it('stopping a solar-only scan with nothing on disk falls to the landing', async () => {
    await telemetry.startSolar(VALID_ADVERTISEMENT_KEY)
    expect(telemetry.source.value).toBe('live')

    telemetry.stopSolar()

    expect(telemetry.source.value).toBe('none')
    expect(telemetry.battery.value).toBeNull()
  })
})

describe('what reaches the archive is raw', () => {
  // The regression that must never break. A derived, damped or corrected number that found its
  // way into a TrendPoint or a RememberedSession would be indistinguishable from a measurement
  // forever after, so the trend columns and the persisted snapshot are pinned exactly.

  /** Loaded and resting frames alternating, at deliberately awkward precision. */
  const CURRENTS = [-5.037, 4.4013, -0.0009, 2.90001, -4.7, 0.13, -3.0004, 2.6]

  let clock = 0
  let bms: FakeBmsLink
  let solar: FakeSolarScan

  beforeEach(() => {
    localStorage.clear()
    clock = Date.now()
    bms = fakeBmsLink()
    solar = fakeSolarScan()
    telemetry = createTelemetry({
      createBmsLink: bms.create,
      createSolarScan: solar.create,
      historyStore: () => null,
      now: () => clock,
      monotonic: () => clock,
      newId: () => 'session',
    })
  })

  function drive(currents: readonly number[]): BatterySnapshot[] {
    return currents.map((current) => {
      const snapshot = battery({ current })
      bms.emitSnapshot(snapshot)
      clock += 1000
      return snapshot
    })
  }

  it('records only the four raw trend columns', () => {
    drive(CURRENTS)

    expect(Object.keys(telemetry.history[0]).sort()).toEqual([
      'at',
      'housePower',
      'packCurrent',
      'pvPower',
    ])
  })

  it('carries every pack current through at full float precision', () => {
    const snapshots = drive(CURRENTS)

    expect(telemetry.history).toHaveLength(snapshots.length)
    telemetry.history.forEach((point, index) => {
      expect(point.packCurrent).toBe(snapshots[index].current)
    })
  })

  it('persists the snapshot the radio handed over and nothing derived from it', async () => {
    await telemetry.connectBms()
    const snapshot = battery({ current: -5.037 })
    bms.emitSnapshot(snapshot)

    // The live ref is the object the decoder produced, not a copy some filter rebuilt.
    expect(telemetry.battery.value).toBe(snapshot)
    const persisted = JSON.parse(localStorage.getItem(KEY) ?? 'null') as RememberedSession
    expect(persisted.battery).toEqual(snapshot)
  })

  it('does not persist while a stored session is on the instruments', async () => {
    const stored = battery({ current: 3.3, stateOfCharge: 41 })
    expect(telemetry.browseSession(sessionRecord({ finalBattery: stored }))).toBe(true)
    expect(telemetry.source.value).toBe('history')
    localStorage.clear()

    // The instruments are showing a session from disk. Nothing about it may overwrite the
    // remembered snapshot, and the guard is on the source rather than on any caller.
    bms.emitSnapshot(battery({ current: -5.037 }))
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})

describe('browsing a stored session', () => {
  let bms: FakeBmsLink
  let solar: FakeSolarScan

  beforeEach(() => {
    localStorage.clear()
    bms = fakeBmsLink()
    solar = fakeSolarScan()
    telemetry = createTelemetry({
      createBmsLink: bms.create,
      createSolarScan: solar.create,
      historyStore: () => null,
      now: () => Date.now(),
      monotonic: () => performance.now(),
      newId: () => 'session',
    })
  })

  it('loads the session into the instruments when both radios are idle', () => {
    const stored = battery({ stateOfCharge: 41 })

    expect(telemetry.browseSession(sessionRecord({ finalBattery: stored }))).toBe(true)

    expect(telemetry.source.value).toBe('history')
    expect(telemetry.battery.value).toEqual(stored)
    // The session carries what the annunciator said at the time; re-running the engine over an
    // hours-old snapshot would annunciate the past.
    expect(telemetry.faults.value).toEqual([])
  })

  it('refuses while a radio is up, so the badges never describe the wrong pack', async () => {
    await telemetry.connectBms()

    expect(telemetry.browseSession(sessionRecord({ finalBattery: battery() }))).toBe(false)
    expect(telemetry.source.value).toBe('live')
  })

  it('refuses a row written under a snapshot shape this build does not know', () => {
    const record = sessionRecord({ finalBattery: battery(), schema: SNAPSHOT_SCHEMA_VERSION + 1 })

    expect(telemetry.browseSession(record)).toBe(false)
    expect(telemetry.source.value).toBe('none')
  })

  it('leaves history synchronously, clearing the view', () => {
    telemetry.browseSession(sessionRecord({ finalBattery: battery() }))

    telemetry.leaveHistory()

    expect(telemetry.source.value).toBe('none')
    expect(telemetry.battery.value).toBeNull()
  })

  it('starting a scan while browsing leaves history first', async () => {
    telemetry.browseSession(sessionRecord({ finalBattery: battery() }))

    await telemetry.startSolar(VALID_ADVERTISEMENT_KEY)

    expect(telemetry.source.value).toBe('live')
    expect(telemetry.battery.value).toBeNull()
  })
})

describe('the windows never outlive the pack they describe', () => {
  let clock = 0
  let bms: FakeBmsLink
  let solar: FakeSolarScan

  beforeEach(() => {
    localStorage.clear()
    clock = Date.now()
    bms = fakeBmsLink()
    solar = fakeSolarScan()
    telemetry = createTelemetry({
      createBmsLink: bms.create,
      createSolarScan: solar.create,
      historyStore: () => null,
      now: () => clock,
      monotonic: () => clock,
      newId: () => 'session',
    })
  })

  function driveSeconds(count: number, current = -8.4): void {
    for (let index = 0; index < count; index += 1) {
      bms.emitSnapshot(battery({ current }))
      clock += 1000
    }
  }

  it('clears the pack window when the BMS drops with the scan still up', async () => {
    await telemetry.startSolar(VALID_ADVERTISEMENT_KEY)
    await telemetry.connectBms()
    solar.emitReading(solarReading())
    driveSeconds(35)

    expect(telemetry.packReach.value).not.toBeNull()
    expect(telemetry.cellReach.value).not.toBeNull()
    expect(telemetry.balance.value).not.toBeNull()

    bms.emitDisconnect('dropped')

    expect(telemetry.source.value).toBe('live')
    expect(telemetry.packReach.value).toBeNull()
    expect(telemetry.cellReach.value).toBeNull()
    expect(telemetry.balance.value).toBeNull()
    expect(telemetry.faults.value).toEqual([])
  })

  it('projects a runtime while live and withholds it once the session is remembered', async () => {
    await telemetry.connectBms()
    driveSeconds(65)

    expect(telemetry.projection.value).toEqual({ kind: 'toEmpty', hours: expect.any(Number), overMs: 64_000 })

    await telemetry.disconnectBms()

    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.projection.value).toBeNull()
    expect(telemetry.packReach.value).toBeNull()
  })

  it('says it is still collecting before the window can answer', async () => {
    await telemetry.connectBms()
    driveSeconds(10)

    expect(telemetry.projection.value).toEqual({ kind: 'collecting' })
  })
})
