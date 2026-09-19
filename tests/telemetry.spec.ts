// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { browserStandardUtcOffsetMinutes } from '../src/application/browserZone'
import { unavailableHistoryStore } from '../src/application/history/port'
import type { HistoryStore } from '../src/application/history/port'
import { RING_STALE_AFTER_MS } from '../src/application/history/ringIngest'
import { SOLAR_HISTORY_STALE_AFTER_MS } from '../src/application/history/solarHistoryIngest'
import { saveLastController } from '../src/application/lastController'
import { saveAdvertisementKey } from '../src/application/storage'
import { createTelemetry } from '../src/application/telemetry'
import type { Telemetry, TelemetryDeps } from '../src/application/telemetry'
import { saveRememberedSession } from '../src/application/rememberedSession'
import type { RememberedSession } from '../src/application/rememberedSession'
import { decodeDetailLogRecord } from '../src/domain/bms/detailLog'
import type { DetailLogTransfer } from '../src/domain/bms/DetailLogTransfer'
import type { BatterySnapshot } from '../src/domain/bms/types'
import type { RingRecordBytes } from '../src/domain/history/RingRecordBytes'
import type { DeviceKey } from '../src/domain/history/types'
import type { SolarHistoryTransfer } from '../src/domain/solar/SolarHistoryTransfer'
import { SNAPSHOT_SCHEMA_VERSION } from '../src/domain/schemaVersion'
import { browserBleEnvironment } from '../src/infrastructure/ble/capabilities'
import type { BleEnvironment } from '../src/infrastructure/ble/capabilities'
import { JkBmsClient } from '../src/infrastructure/ble/JkBmsClient'
import { ReconnectRefusedError } from '../src/infrastructure/ble/ReconnectRefusedError'
import { VictronScanner } from '../src/infrastructure/ble/VictronScanner'
import { browserThatCanRejoin } from './support/browserThatCanRejoin'
import { manualSchedule } from './support/manualSchedule'
import type { ManualSchedule } from './support/manualSchedule'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { scriptedPage } from './support/scriptedPage'
import type { ScriptedPage } from './support/scriptedPage'
import { capturedDayReadings, capturedTotals } from './support/solarHistoryFixture'
import {
  PACK_DEVICE_KEY,
  battery,
  deviceInfo,
  rememberedSession,
  ringRecords,
  sessionRecord,
  solarReading,
} from './support/samples'
import { fakeBmsLink, fakeSolarHistoryLink, fakeSolarScan } from './support/fakeRadios'
import type { FakeBmsLink, FakeSolarHistoryLink, FakeSolarScan } from './support/fakeRadios'

// Each case builds its own telemetry and throws it away, so nothing leaks between them: the
// windows, the fault latch and the recorder are all per-instance. The failure-path cases run
// against the REAL adapters and the real environment, because jsdom exposes no navigator.bluetooth
// and both radios therefore genuinely throw — which is exactly the restore/fallback path under
// test. An environment that claimed more would quietly change what those cases assert.

const KEY = 'shunt.rememberedSession'
const VALID_ADVERTISEMENT_KEY = '0123456789abcdef0123456789abcdef'

function session(overrides: Partial<RememberedSession> = {}): RememberedSession {
  return rememberedSession({ capturedAt: Date.now() - 5 * 60 * 1000, ...overrides })
}

function radioDeps(): TelemetryDeps {
  return {
    createBmsLink: (handlers) => new JkBmsClient(handlers),
    createSolarScan: (handlers) => new VictronScanner(handlers),
    createSolarHistoryLink: fakeSolarHistoryLink().create,
    bleEnvironment: browserBleEnvironment(),
    historyStore: () => null,
    refreshRingLedger: async () => undefined,
    refreshSolarLedger: async () => undefined,
    now: () => Date.now(),
    monotonic: () => performance.now(),
    newId: () => crypto.randomUUID(),
  }
}

/** Records at consecutive ring positions, as the frames of one unbroken burst carried them. */
function carried(records: readonly Uint8Array[], firstIndex: number): RingRecordBytes[] {
  return records.map((bytes, position) => ({ index: firstIndex + position, bytes }))
}

/**
 * A finished read. The decoded records are derived from the bytes rather than stated beside them,
 * because the two lists being index-aligned is the transport's contract and no case here is about
 * breaking it.
 */
function transferOf(
  rawRecords: readonly RingRecordBytes[],
  overrides: Partial<DetailLogTransfer> = {},
): DetailLogTransfer {
  return {
    outcome: 'records-read',
    notificationBytes: 300 * Math.ceil(rawRecords.length / 12),
    notificationCount: rawRecords.length,
    assembledFrameCount: Math.ceil(rawRecords.length / 12),
    frames: [],
    records: rawRecords.map((raw) =>
      decodeDetailLogRecord(raw.bytes, raw.index, { packUtcOffsetMinutes: 60 }),
    ),
    rawRecords,
    elapsedMs: 940,
    ...overrides,
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
      createSolarHistoryLink: fakeSolarHistoryLink().create,
      bleEnvironment: browserBleEnvironment(),
      historyStore: () => null,
      refreshRingLedger: async () => undefined,
      refreshSolarLedger: async () => undefined,
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

  it('records only the five raw trend columns', () => {
    drive(CURRENTS)

    // Pack watts are deliberately absent: the strip multiplies the current by the voltage at read
    // time, so no column here holds anything but a figure a radio reported.
    expect(Object.keys(telemetry.history[0]).sort()).toEqual([
      'at',
      'housePower',
      'packCurrent',
      'packVoltage',
      'pvPower',
    ])
  })

  it('carries every pack current and voltage through at full float precision', () => {
    const snapshots = drive(CURRENTS)

    expect(telemetry.history).toHaveLength(snapshots.length)
    telemetry.history.forEach((point, index) => {
      expect(point.packCurrent).toBe(snapshots[index].current)
      expect(point.packVoltage).toBe(snapshots[index].packVoltage)
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

  it('restores the latest readings and timestamped trends after a refresh', async () => {
    await telemetry.connectBms()
    drive(CURRENTS)
    const capturedHistory = [...telemetry.history]
    const capturedBattery = telemetry.battery.value

    window.dispatchEvent(new Event('pagehide'))
    telemetry.dispose()
    telemetry = createTelemetry(radioDeps())

    expect(telemetry.restoreRemembered()).toBe(true)
    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.bmsState.value).toBe('idle')
    expect(telemetry.battery.value).toEqual(capturedBattery)
    expect(telemetry.history).toEqual(capturedHistory)
    expect(telemetry.packReach.value).toBeNull()
    expect(telemetry.projection.value).toBeNull()
  })

  it('flushes the latest snapshot when hidden before the periodic write is due', async () => {
    await telemetry.connectBms()
    drive([-1, -9])
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      const persisted = JSON.parse(localStorage.getItem(KEY) ?? 'null') as RememberedSession
      expect(persisted.battery?.current).toBe(-9)
      expect(persisted.capturedAt).toBe(clock - 1000)
    } finally {
      visibility.mockRestore()
    }
  })

  it('restores a solar-only watch after refresh without inventing a battery reading', async () => {
    await telemetry.startSolar(VALID_ADVERTISEMENT_KEY)
    const reading = solarReading({ pvPower: 123 })
    solar.emitReading(reading, -62)
    window.dispatchEvent(new Event('pagehide'))
    telemetry.dispose()
    telemetry = createTelemetry(radioDeps())

    expect(telemetry.restoreRemembered()).toBe(true)
    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).toBeNull()
    expect(telemetry.solar.value).toEqual(reading)
    expect(telemetry.solarState.value).toBe('idle')
  })

  it('keeps the final solar-only reading when the owner stops its watch', async () => {
    await telemetry.startSolar(VALID_ADVERTISEMENT_KEY)
    solar.emitReading(solarReading({ pvPower: 40 }), -62)
    clock += 1000
    const finalReading = solarReading({ pvPower: 90 })
    solar.emitReading(finalReading, -61)

    telemetry.stopSolar()

    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.battery.value).toBeNull()
    expect(telemetry.solar.value).toEqual(finalReading)
    expect(telemetry.rememberedAt.value).toBe(clock)
    expect(telemetry.solarState.value).toBe('idle')
  })

  it('keeps the saved pack through a second refresh when solar rejoins first', async () => {
    await telemetry.connectBms()
    drive(CURRENTS)
    solar.emitReading(solarReading({ pvPower: 40 }), -62)
    window.dispatchEvent(new Event('pagehide'))
    const saved = localStorage.getItem(KEY)

    telemetry.dispose()
    telemetry = createTelemetry({ ...radioDeps(), createSolarScan: solar.create })
    expect(telemetry.restoreRemembered()).toBe(true)
    solar.emitReading(solarReading({ pvPower: 90 }), -61)
    expect(telemetry.source.value).toBe('live')
    expect(telemetry.battery.value).toBeNull()
    window.dispatchEvent(new Event('pagehide'))

    expect(localStorage.getItem(KEY)).toBe(saved)
    telemetry.dispose()
    telemetry = createTelemetry(radioDeps())
    expect(telemetry.restoreRemembered()).toBe(true)
    expect(telemetry.battery.value).not.toBeNull()
    expect(telemetry.solar.value?.pvPower).toBe(40)
    expect(telemetry.history).toHaveLength(CURRENTS.length + 1)
  })

  it('keeps the saved trend identity when the adapter clears its device before reporting a drop', async () => {
    telemetry.dispose()
    let deviceCleared = false
    telemetry = createTelemetry({
      ...radioDeps(),
      createBmsLink: (handlers) => {
        const link = bms.create(handlers)
        return {
          ...link,
          get deviceId() {
            return deviceCleared ? null : 'jk-abc'
          },
        }
      },
    })
    await telemetry.connectBms()
    bms.emitSnapshot(battery())
    deviceCleared = true

    bms.emitDisconnect()

    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as RememberedSession
    expect(saved.bmsDeviceId).toBe('jk-abc')
    expect(saved.history).toHaveLength(1)
    expect(telemetry.source.value).toBe('remembered')
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
      createSolarHistoryLink: fakeSolarHistoryLink().create,
      bleEnvironment: browserBleEnvironment(),
      historyStore: () => null,
      refreshRingLedger: async () => undefined,
      refreshSolarLedger: async () => undefined,
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

describe('reading the pack’s stored detail log', () => {
  // The transport half: what came back, and what the receipt renders it against. The archive is
  // deliberately absent here, so nothing in these cases can be filed.
  let bms: FakeBmsLink
  let solar: FakeSolarScan

  const hostZone = process.env.TZ

  function telemetryReadingAt(now: () => number): Telemetry {
    return createTelemetry({
      createBmsLink: bms.create,
      createSolarScan: solar.create,
      createSolarHistoryLink: fakeSolarHistoryLink().create,
      bleEnvironment: browserBleEnvironment(),
      historyStore: () => null,
      refreshRingLedger: async () => undefined,
      refreshSolarLedger: async () => undefined,
      now,
      monotonic: () => performance.now(),
      newId: () => 'session',
    })
  }

  beforeEach(() => {
    localStorage.clear()
    bms = fakeBmsLink()
    solar = fakeSolarScan()
    telemetry = telemetryReadingAt(() => Date.now())
  })

  afterEach(() => {
    if (hostZone === undefined) delete process.env.TZ
    else process.env.TZ = hostZone
  })

  it('holds what came back and resolves the records against this browser’s standard offset', async () => {
    await telemetry.connectBms()
    const answer = {
      outcome: 'torn-burst',
      notificationBytes: 4_812,
      notificationCount: 27,
      assembledFrameCount: 0,
      frames: [],
      records: [],
      rawRecords: [],
      elapsedMs: 3_100,
    } as const
    bms.answerNextDetailLogWith(answer)

    await telemetry.readDetailLog()

    expect(telemetry.detailLog.value).toEqual(answer)
    expect(telemetry.detailLogReading.value).toBe(false)
    expect(telemetry.detailLogError.value).toBeNull()
    expect(bms.lastDetailLogOffsetMinutes).toBe(browserStandardUtcOffsetMinutes(Date.now()))
  })

  /**
   * The pack's counter runs on its zone's standard offset whatever season a record falls in, so a
   * read taken during summer time still has to hand the decoder the winter offset. Hand it the
   * offset in force at the moment of the read instead and every stored timestamp the Stats card
   * shows lands an hour late, for as long as summer time lasts.
   */
  it('hands the decoder the standard offset even when the read itself is taken in summer', async () => {
    process.env.TZ = 'Europe/Zagreb'
    const midsummer = Date.UTC(2026, 6, 15, 12)
    telemetry.dispose()
    telemetry = telemetryReadingAt(() => midsummer)
    await telemetry.connectBms()

    await telemetry.readDetailLog()

    expect(new Date(midsummer).getTimezoneOffset()).toBe(-120)
    expect(bms.lastDetailLogOffsetMinutes).toBe(60)
  })

  it('does nothing at all when no pack is connected', async () => {
    await telemetry.readDetailLog()

    expect(bms.lastDetailLogOffsetMinutes).toBeNull()
    expect(telemetry.detailLog.value).toBeNull()
  })

  it('shows a failed read as a banner and leaves the last transfer alone', async () => {
    await telemetry.connectBms()
    bms.failNextDetailLogWith(new Error('Connect the BMS before reading its stored log.'))

    await telemetry.readDetailLog()

    expect(telemetry.detailLogError.value).toMatch(/Connect the BMS/)
    expect(telemetry.detailLog.value).toBeNull()
    expect(telemetry.detailLogReading.value).toBe(false)
  })
})

describe('filing a stored-log read against the pack that answered it', () => {
  // The archive half. What is filed is the bytes the pack sent, under the key its own sessions
  // group by, whatever this build made of them on screen.
  let bms: FakeBmsLink
  let solar: FakeSolarScan
  let store: MemoryHistoryStore
  let refreshed: DeviceKey[]
  let clock = 0

  function telemetryOver(historyStore: () => HistoryStore | null): Telemetry {
    return createTelemetry({
      createBmsLink: bms.create,
      createSolarScan: solar.create,
      createSolarHistoryLink: fakeSolarHistoryLink().create,
      bleEnvironment: browserBleEnvironment(),
      historyStore,
      refreshRingLedger: async (deviceKey) => {
        refreshed.push(deviceKey)
      },
      refreshSolarLedger: async () => undefined,
      now: () => clock,
      monotonic: () => clock,
      newId: () => 'session',
    })
  }

  async function liveWithIdentity(): Promise<void> {
    await telemetry.connectBms()
    bms.emitDeviceInfo(deviceInfo())
  }

  beforeEach(() => {
    localStorage.clear()
    clock = Date.UTC(2026, 7, 1, 11, 14)
    bms = fakeBmsLink()
    solar = fakeSolarScan()
    store = new MemoryHistoryStore({ now: () => clock })
    refreshed = []
    telemetry = telemetryOver(() => store)
  })

  it('files what came back under the pack’s own device key', async () => {
    await liveWithIdentity()
    bms.answerNextDetailLogWith(transferOf(carried(ringRecords(8), 0)))

    await telemetry.readDetailLog()

    const ledger = await store.readRingLedger(PACK_DEVICE_KEY)
    expect(ledger?.records).toHaveLength(8)
    expect(ledger?.reads).toHaveLength(1)
    expect(telemetry.ringIngest.value).toMatchObject({ stored: true, appended: 8, totalRecords: 8, failure: null })
    expect(telemetry.ringFilingNote.value).toBeNull()
    // The channel never delivers to the tab that posted it, so this tab re-reads its own write.
    expect(refreshed).toEqual([PACK_DEVICE_KEY])
  })

  it('files the unbroken stretches a torn burst carried and counts the orphans it dropped', async () => {
    await liveWithIdentity()
    const burst = ringRecords(12)
    // Indices 8 and 9 never arrived. What is left is eight records the fold can place and a pair
    // too short to identify itself, which is guessed at nowhere.
    bms.answerNextDetailLogWith(
      transferOf([...carried(burst.slice(0, 8), 0), ...carried(burst.slice(10), 10)]),
    )

    await telemetry.readDetailLog()

    expect(telemetry.ringIngest.value).toMatchObject({ appended: 8, runsDiscarded: 1 })
    expect((await store.readRingLedger(PACK_DEVICE_KEY))?.records).toHaveLength(8)
  })

  /**
   * The fold aligns on ring position, so a window whose records sit at the wrong positions is
   * filed as real history rather than rejected. A burst that retransmits part of itself has to
   * collapse to one window before it ever reaches the fold, whatever order the frames landed in.
   */
  it('collapses a burst that retransmitted part of itself into one window', async () => {
    await liveWithIdentity()
    const fresh = ringRecords(8)
    const stale = ringRecords(4, { current: 12.5 })
    bms.answerNextDetailLogWith(transferOf([...carried(stale, 4), ...carried(fresh, 0)]))

    await telemetry.readDetailLog()

    const ledger = await store.readRingLedger(PACK_DEVICE_KEY)
    expect(telemetry.ringIngest.value).toMatchObject({ appended: 8, runsDiscarded: 0, gapDeclared: false })
    expect(ledger?.records).toHaveLength(8)
    // Element-wise: the archive's rows come back through structuredClone, and a typed array that
    // crossed a realm boundary is not the same object as one built here however it prints.
    expect(Array.from(ledger?.records[4].bytes ?? [])).toEqual(Array.from(fresh[4]))
  })

  it('journals a read the pack answered without a stored log among it, and stores no record', async () => {
    await liveWithIdentity()
    bms.answerNextDetailLogWith(
      transferOf([], { outcome: 'other-frames', notificationBytes: 1_200, assembledFrameCount: 4 }),
    )

    await telemetry.readDetailLog()

    const ledger = await store.readRingLedger(PACK_DEVICE_KEY)
    expect(ledger?.records).toEqual([])
    expect(ledger?.reads).toHaveLength(1)
    expect(ledger?.reads[0]).toMatchObject({ outcome: 'other-frames', indexSpan: null, recordsAppended: 0 })
  })

  it('journals a read the pack never answered, which is the finding worth keeping', async () => {
    await liveWithIdentity()
    bms.answerNextDetailLogWith(
      transferOf([], { outcome: 'no-answer', notificationBytes: 0, notificationCount: 0, assembledFrameCount: 0 }),
    )

    await telemetry.readDetailLog()

    const ledger = await store.readRingLedger(PACK_DEVICE_KEY)
    expect(ledger?.records).toEqual([])
    expect(ledger?.reads[0]).toMatchObject({ outcome: 'no-answer', notificationBytes: 0 })
  })

  it('keeps the transfer on screen when the archive refused the write', async () => {
    telemetry.dispose()
    const refusing = unavailableHistoryStore('quota-exhausted')
    telemetry = telemetryOver(() => refusing)
    await liveWithIdentity()
    const answer = transferOf(carried(ringRecords(8), 0))
    bms.answerNextDetailLogWith(answer)

    await telemetry.readDetailLog()

    expect(telemetry.detailLog.value).toEqual(answer)
    // A storage failure is the receipt's business. The link's error line is about the link.
    expect(telemetry.detailLogError.value).toBeNull()
    expect(telemetry.ringIngest.value).toMatchObject({ stored: false, appended: 0, failure: 'quota-exhausted' })
  })

  it('says the pack could not be named rather than filing it under an invented key', async () => {
    // No device-info frame and no advertised name: inventing a key here merges every unnamed pack
    // this browser ever meets into one ledger, and the first read is what makes that unrecoverable.
    await telemetry.connectBms()
    bms.answerNextDetailLogWith(transferOf(carried(ringRecords(8), 0)))

    await telemetry.readDetailLog()

    expect(telemetry.ringFilingNote.value).toMatch(/neither a serial nor a name/)
    expect(telemetry.ringIngest.value).toBeNull()
    expect(await store.listRingLedgers()).toEqual([])
    expect(refreshed).toEqual([])
  })
})

describe('fetching a stale stored log without being asked', () => {
  let bms: FakeBmsLink
  let solar: FakeSolarScan
  let store: MemoryHistoryStore
  let clock = 0

  /**
   * Drains the microtask chain the auto-read runs on. It touches no timer — the whole path is a
   * ledger read, the radio's answer, a merge and a refresh — so turning the queue over settles it.
   */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve()
  }

  /** A connection that has reached live and produced its first cell frame, which is the trigger. */
  async function liveWithCellFrame(): Promise<void> {
    await telemetry.connectBms()
    bms.emitDeviceInfo(deviceInfo())
    bms.emitSnapshot(battery())
    await settle()
  }

  async function readsFiled(): Promise<number> {
    return (await store.readRingLedger(PACK_DEVICE_KEY))?.reads.length ?? 0
  }

  beforeEach(() => {
    localStorage.clear()
    clock = Date.UTC(2026, 7, 1, 11, 14)
    bms = fakeBmsLink()
    solar = fakeSolarScan()
    store = new MemoryHistoryStore({ now: () => clock })
    telemetry = createTelemetry({
      createBmsLink: bms.create,
      createSolarScan: solar.create,
      createSolarHistoryLink: fakeSolarHistoryLink().create,
      bleEnvironment: browserBleEnvironment(),
      historyStore: () => store,
      refreshRingLedger: async () => undefined,
      refreshSolarLedger: async () => undefined,
      now: () => clock,
      monotonic: () => clock,
      newId: () => 'session',
    })
    bms.answerNextDetailLogWith(transferOf(carried(ringRecords(8), 0)))
  })

  it('reads the stored log by itself when this browser holds none of it', async () => {
    await liveWithCellFrame()

    const ledger = await store.readRingLedger(PACK_DEVICE_KEY)
    expect(ledger?.records).toHaveLength(8)
    expect(ledger?.reads).toHaveLength(1)
  })

  it('fires once in a connection, whatever the pack streams after it', async () => {
    await liveWithCellFrame()

    bms.emitSnapshot(battery())
    bms.emitSnapshot(battery())
    await settle()

    expect(await readsFiled()).toBe(1)
  })

  it('leaves the pack alone on a connection made inside the day', async () => {
    await liveWithCellFrame()
    await telemetry.disconnectBms()

    clock += RING_STALE_AFTER_MS - 60_000
    await liveWithCellFrame()

    expect(await readsFiled()).toBe(1)
  })

  it('reads again on the first connection after the ring has gone a day unread', async () => {
    await liveWithCellFrame()
    await telemetry.disconnectBms()

    clock += RING_STALE_AFTER_MS + 60_000
    await liveWithCellFrame()

    expect(await readsFiled()).toBe(2)
  })

  /**
   * A read the pack ignored still journals, and that row must not stand in for the ring this
   * browser has never held. Counting it as an answer would let one silent read lock the pack out
   * of the archive for a day, which is exactly the day the ring is rolling records off the end of.
   */
  it('tries again on the next connection when the pack answered nothing', async () => {
    bms.answerNextDetailLogWith(transferOf([], { outcome: 'no-answer', notificationBytes: 0 }))
    await liveWithCellFrame()
    expect((await store.readRingLedger(PACK_DEVICE_KEY))?.records).toEqual([])
    await telemetry.disconnectBms()

    clock += 60 * 60_000
    bms.answerNextDetailLogWith(transferOf(carried(ringRecords(8), 0)))
    await liveWithCellFrame()

    expect((await store.readRingLedger(PACK_DEVICE_KEY))?.records).toHaveLength(8)
  })

  it('does not retry inside the connection that the read failed in', async () => {
    bms.failNextDetailLogWith(new Error('Lost the BMS mid-read.'))

    await liveWithCellFrame()
    expect(telemetry.detailLogError.value).toMatch(/Lost the BMS/)

    bms.emitSnapshot(battery())
    await settle()

    expect(await store.readRingLedger(PACK_DEVICE_KEY)).toBeNull()
  })
})

describe('gathering the controller’s stored history without being asked', () => {
  // The other radio's half of the same policy, and a great deal more contended: the tunnel and the
  // live watch cannot both have the controller, so every case here is as much about what happens to
  // the watch as about what reaches the archive. Time and the page are the spec's, because the
  // watch coming back is the supervisor's own schedule doing it.

  /** A watch the loop can put up on its own: a key to decode with and a controller to go back to. */
  const REMEMBERED_CONTROLLER = 'victron-1'
  /** The floor the supervisor paces its attempts by, which a restored watch waits out. */
  const ATTEMPT_GAP_MS = 1_000

  let pendingDigests: Set<Promise<ArrayBuffer>>
  let restoreDigest = (): void => undefined
  let timers: ManualSchedule
  let page: ScriptedPage
  let solar: FakeSolarScan
  let tunnel: FakeSolarHistoryLink
  let store: MemoryHistoryStore
  /** What `historyStore` answers, so a case can play an archive that has not landed yet. */
  let archive: HistoryStore | null

  /** Native hashes finish outside the microtask queue; filing can start another after one settles. */
  async function settle(): Promise<void> {
    do {
      await Promise.allSettled([...pendingDigests])
      await new Promise((resolve) => setTimeout(resolve, 0))
    } while (pendingDigests.size > 0)
  }

  /** The captured backlog, which is a sweep that leaves the ledger with nothing left to fetch. */
  function daysRead(): SolarHistoryTransfer {
    return {
      outcome: 'days-read',
      totals: capturedTotals,
      days: capturedDayReadings(),
      refusedRegisters: [],
      notificationBytes: 1_984,
      notificationCount: 62,
      controlNotificationCount: 9,
      pduCount: 32,
      unreadableReplyCount: 0,
      elapsedMs: 6_400,
    }
  }

  function spawn(environment: BleEnvironment = browserThatCanRejoin()): void {
    solar = fakeSolarScan()
    solar.allowResume(true)
    tunnel = fakeSolarHistoryLink()
    telemetry = createTelemetry({
      createBmsLink: fakeBmsLink().create,
      createSolarScan: solar.create,
      createSolarHistoryLink: tunnel.create,
      bleEnvironment: environment,
      historyStore: () => archive,
      refreshRingLedger: async () => undefined,
      refreshSolarLedger: async () => undefined,
      now: () => timers.now(),
      monotonic: () => timers.now(),
      newId: () => 'session',
      pageActivity: page.activity,
      schedule: timers.schedule,
    })
  }

  /** A watch the loop put up on its own, with the controller heard on it — which is the trigger. */
  async function watchedAndHeard(): Promise<void> {
    telemetry.startRejoin()
    await settle()
    solar.emitReading(solarReading())
    await settle()
    // Whatever the sweep did, the loop has a watch to put back once the tunnel lets go. It is left
    // standing before a case goes on, because a watch the sweep itself took down and the loop
    // restored is the same watch and carries the same spent chance.
    timers.advance(ATTEMPT_GAP_MS)
    await settle()
  }

  /**
   * The owner looks away and comes back. Chromium killed the watch on the way out and the loop puts
   * a fresh one up on the way in, which is the controller's answer to the pack's next connection.
   */
  async function watchGoesAwayAndComesBack(): Promise<void> {
    page.hide()
    page.show()
    timers.advance(ATTEMPT_GAP_MS)
    await settle()
    solar.emitReading(solarReading())
    await settle()
  }

  beforeEach(() => {
    localStorage.clear()
    timers = manualSchedule(Date.UTC(2026, 7, 1, 11, 14))
    pendingDigests = new Set()
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle)
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((...parameters) => {
      const digest = nativeDigest(...parameters)
      pendingDigests.add(digest)
      void digest.then(
        () => pendingDigests.delete(digest),
        () => pendingDigests.delete(digest),
      )
      return digest
    })
    restoreDigest = () => digestSpy.mockRestore()
    page = scriptedPage()
    store = new MemoryHistoryStore({ now: () => timers.now() })
    archive = store
    saveAdvertisementKey(VALID_ADVERTISEMENT_KEY)
    saveLastController(REMEMBERED_CONTROLLER, 'SmartSolar HQ22487VZHZ', timers.now())
    spawn()
  })

  afterEach(() => {
    store.close()
    restoreDigest()
  })

  it('sweeps the controller by itself when this browser holds none of its backlog', async () => {
    tunnel.answerNextSweepWith(daysRead())

    await watchedAndHeard()

    // Through the remembered route and not the chooser: a dialog nobody asked for is worse than no
    // history at all, and the whole feature rests on there being a way in that raises none.
    expect(tunnel.rememberedSweepCalls).toEqual([REMEMBERED_CONTROLLER])
    expect(tunnel.chooserSweepCount).toBe(0)
    expect(telemetry.solarHistory.value?.outcome).toBe('days-read')
    expect(telemetry.solarHistoryIngest.value?.totalDays).toBe(capturedDayReadings().length)
    expect(telemetry.solarHistoryError.value).toBeNull()
  })

  it('sweeps once in a watch, whatever the controller advertises after it', async () => {
    tunnel.answerNextSweepWith(daysRead())
    await watchedAndHeard()

    solar.emitReading(solarReading())
    solar.emitReading(solarReading())
    await settle()

    expect(tunnel.rememberedSweepCalls).toHaveLength(1)
  })

  it('leaves the controller alone on a watch that came up inside the day', async () => {
    tunnel.answerNextSweepWith(daysRead())
    await watchedAndHeard()

    timers.advance(SOLAR_HISTORY_STALE_AFTER_MS - 60_000)
    await watchGoesAwayAndComesBack()

    expect(tunnel.rememberedSweepCalls).toHaveLength(1)
  })

  it('sweeps again on the first watch after the backlog has gone a day unswept', async () => {
    tunnel.answerNextSweepWith(daysRead())
    await watchedAndHeard()

    timers.advance(SOLAR_HISTORY_STALE_AFTER_MS + 60_000)
    await watchGoesAwayAndComesBack()

    expect(tunnel.rememberedSweepCalls).toHaveLength(2)
  })

  /**
   * A sweep the controller ignored still journals, and that row must not stand in for a backlog
   * this browser has never held. Counting it as an answer would let one silent sweep lock the
   * controller out of the archive for a day, over a backlog that rolls a day off the end each night.
   */
  it('tries again on the next watch when the controller answered nothing', async () => {
    await watchedAndHeard()
    expect(telemetry.solarHistory.value?.outcome).toBe('no-answer')

    tunnel.answerNextSweepWith(daysRead())
    await watchGoesAwayAndComesBack()

    expect(tunnel.rememberedSweepCalls).toHaveLength(2)
    expect(telemetry.solarHistory.value?.outcome).toBe('days-read')
  })

  it('does not try again inside the watch a sweep failed in', async () => {
    tunnel.failNextSweepWith(new Error('the controller refused the connection'))

    await watchedAndHeard()
    expect(telemetry.solarHistoryError.value).toBe('the controller refused the connection')

    solar.emitReading(solarReading())
    await settle()

    expect(tunnel.rememberedSweepCalls).toHaveLength(1)
  })

  it('takes the watch back from a sweep that failed, exactly as from one that worked', async () => {
    // The radio is handed over before the tunnel is asked for anything, so every way out of a sweep
    // owes the watch back — and a failure is the way out nobody is watching the screen for.
    tunnel.failNextSweepWith(new Error('the controller refused the connection'))

    await watchedAndHeard()

    expect(telemetry.solarHistoryError.value).toBe('the controller refused the connection')
    expect(telemetry.solarState.value).toBe('listening')
    expect(solar.resumeCalls).toEqual([REMEMBERED_CONTROLLER, REMEMBERED_CONTROLLER])
  })

  it('clears the last failure off the receipt the moment the next sweep starts', async () => {
    tunnel.failNextSweepWith(new Error('the controller refused the connection'))
    await watchedAndHeard()
    expect(telemetry.solarHistoryError.value).toBe('the controller refused the connection')

    tunnel.answerNextSweepWith(daysRead())
    await watchGoesAwayAndComesBack()

    // A sentence about yesterday's tunnel standing over today's days would be the receipt arguing
    // with itself, and the reader has no way to tell which half is current.
    expect(telemetry.solarHistoryError.value).toBeNull()
    expect(telemetry.solarHistory.value?.outcome).toBe('days-read')
  })

  /**
   * A grant this browser has let lapse, and a grant minted without the tunnel service, are the two
   * answers no retry moves. Every attempt at one costs a live watch and buys the same refusal back,
   * so the automatic sweep gives up for the life of the page rather than spending the afternoon
   * proving it. Only a chooser can widen a grant, and only the owner can raise one.
   */
  it('gives the automatic sweep up for the page once the browser refuses the controller', async () => {
    tunnel.failNextSweepWith(
      new ReconnectRefusedError(
        'permission-gone',
        'This browser no longer has permission for the last controller. Press Read solar history to pick it again.',
      ),
    )

    await watchedAndHeard()
    expect(tunnel.rememberedSweepCalls).toHaveLength(1)

    await watchGoesAwayAndComesBack()
    await watchGoesAwayAndComesBack()

    expect(tunnel.rememberedSweepCalls).toHaveLength(1)
    expect(telemetry.solarState.value).toBe('live')
  })

  it('asks again after a press, because a chooser is what mints a grant wide enough to answer', async () => {
    tunnel.failNextSweepWith(
      new ReconnectRefusedError(
        'permission-gone',
        'This browser no longer has permission for the last controller. Press Read solar history to pick it again.',
      ),
    )
    await watchedAndHeard()

    tunnel.answerNextSweepWith(daysRead())
    await telemetry.readSolarHistory()
    expect(tunnel.chooserSweepCount).toBe(1)

    // And once the backlog has gone stale again, the watch that comes up next is free to gather it
    // on its own: the press put the question back on the table.
    timers.advance(SOLAR_HISTORY_STALE_AFTER_MS + 60_000)
    await watchGoesAwayAndComesBack()

    expect(tunnel.rememberedSweepCalls).toHaveLength(2)
  })

  it('leaves it to the button on a browser that cannot reach a device without the chooser', async () => {
    telemetry.dispose()
    const environment = browserThatCanRejoin()
    // `getDevices` is the whole of the chooser-free route. Without it the remembered id is a string
    // this browser can do nothing with, and the sweep is the owner's to ask for.
    spawn({ ...environment, capabilities: { ...environment.capabilities, canReconnect: false } })

    await watchedAndHeard()

    expect(tunnel.rememberedSweepCalls).toEqual([])
    expect(telemetry.solarState.value).toBe('live')
  })

  it('leaves it to the button when this browser has never been shown a controller', async () => {
    telemetry.dispose()
    localStorage.clear()
    saveAdvertisementKey(VALID_ADVERTISEMENT_KEY)
    spawn()
    // The bridge names no controller: it is a WebSocket with no device handle anywhere in it, so
    // there is no id for the remembered route to be given.
    solar.resumesWithNoHandle()
    solar.reportsDevice(null)

    telemetry.startRejoin()
    await telemetry.startSolar(VALID_ADVERTISEMENT_KEY)
    solar.emitReading(solarReading())
    await settle()

    expect(telemetry.lastController.value).toBeNull()
    expect(tunnel.rememberedSweepCalls).toEqual([])
  })

  /**
   * The archive is probed after first paint, so a watch can be up and reporting before it answers.
   * The latch must not be spent on a store that has yet to arrive, or the whole visit goes unswept.
   */
  it('still gets its chance when the archive lands after the controller has been heard', async () => {
    archive = null
    tunnel.answerNextSweepWith(daysRead())

    await watchedAndHeard()
    expect(tunnel.rememberedSweepCalls).toEqual([])

    archive = store
    solar.emitReading(solarReading())
    await settle()

    expect(tunnel.rememberedSweepCalls).toEqual([REMEMBERED_CONTROLLER])
  })

  it('hands the watch to the tunnel for the sweep and takes it back afterwards', async () => {
    tunnel.answerNextSweepWith(daysRead())
    const settleSweep = tunnel.parkNextSweep()

    await watchedAndHeard()

    // The controller accepts one client and stops broadcasting while it has one, so the watch comes
    // down for the sweep rather than sitting there hearing nothing.
    expect(telemetry.solarHistoryReading.value).toBe(true)
    expect(telemetry.solarState.value).toBe('idle')
    // And the loop does not race the tunnel for the radio it was just handed.
    timers.advance(60_000)
    await settle()
    expect(solar.resumeCalls).toHaveLength(1)

    settleSweep()
    await settle()
    timers.advance(ATTEMPT_GAP_MS)
    await settle()

    expect(telemetry.solarState.value).toBe('listening')
    expect(solar.resumeCalls).toEqual([REMEMBERED_CONTROLLER, REMEMBERED_CONTROLLER])
  })

  /**
   * The page going away takes the watch with it, and it is the page — not the sweep — that the
   * watch coming back afterwards belongs to. So the chance a sweep spends dies with the watch it
   * was spent on: a fresh watch owes nothing to the errand that borrowed the last one.
   */
  it('does not charge the next watch for a sweep the page was put away in the middle of', async () => {
    const settleSweep = tunnel.parkNextSweep()
    await watchedAndHeard()
    expect(telemetry.solarHistoryReading.value).toBe(true)

    page.hide()
    settleSweep()
    await settle()
    page.show()
    timers.advance(ATTEMPT_GAP_MS)
    await settle()
    solar.emitReading(solarReading())
    await settle()

    // The first sweep answered nothing, so the backlog is still this browser's to gather and the
    // watch it came back on is a new one. Both halves have to hold for a second sweep to happen.
    expect(tunnel.rememberedSweepCalls).toHaveLength(2)
  })

  it('still sweeps from the button, on the same terms', async () => {
    tunnel.answerNextSweepWith(daysRead())
    telemetry.startRejoin()
    await settle()
    expect(telemetry.solarState.value).toBe('listening')

    await telemetry.readSolarHistory()

    expect(tunnel.chooserSweepCount).toBe(1)
    expect(tunnel.rememberedSweepCalls).toEqual([])
    expect(telemetry.solarHistory.value?.outcome).toBe('days-read')

    timers.advance(ATTEMPT_GAP_MS)
    await settle()

    expect(telemetry.solarState.value).toBe('listening')
  })

  /**
   * The press is offered from the remembered view too, where there is no watch to hand over and
   * nothing to hand it to. Standing down at nothing would clear the instruments and leave them
   * cleared, because no watch is coming back to fill them in again.
   */
  it('leaves the remembered numbers on screen when the press comes from a page with no radio up', async () => {
    const saved = session({ solar: solarReading() })
    saveRememberedSession(saved)
    telemetry.restoreRemembered()
    tunnel.answerNextSweepWith(daysRead())

    await telemetry.readSolarHistory()

    expect(telemetry.solar.value).toEqual(saved.solar)
    expect(telemetry.source.value).toBe('remembered')
    expect(telemetry.solarHistory.value?.outcome).toBe('days-read')
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
      createSolarHistoryLink: fakeSolarHistoryLink().create,
      bleEnvironment: browserBleEnvironment(),
      historyStore: () => null,
      refreshRingLedger: async () => undefined,
      refreshSolarLedger: async () => undefined,
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

    expect(telemetry.projection.value).toEqual({
      kind: 'toEmpty',
      hours: expect.any(Number),
      overMs: 64_000,
      settled: true,
    })

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
