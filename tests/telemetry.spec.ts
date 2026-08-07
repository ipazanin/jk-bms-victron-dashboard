// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { browserStandardUtcOffsetMinutes } from '../src/application/browserZone'
import { unavailableHistoryStore } from '../src/application/history/port'
import type { HistoryStore } from '../src/application/history/port'
import { RING_STALE_AFTER_MS } from '../src/application/history/ringIngest'
import { createTelemetry } from '../src/application/telemetry'
import type { Telemetry, TelemetryDeps } from '../src/application/telemetry'
import { saveRememberedSession } from '../src/application/rememberedSession'
import type { RememberedSession } from '../src/application/rememberedSession'
import { decodeDetailLogRecord } from '../src/domain/bms/detailLog'
import type { DetailLogTransfer } from '../src/domain/bms/DetailLogTransfer'
import type { BatterySnapshot } from '../src/domain/bms/types'
import type { RingRecordBytes } from '../src/domain/history/RingRecordBytes'
import type { DeviceKey } from '../src/domain/history/types'
import { SNAPSHOT_SCHEMA_VERSION } from '../src/domain/schemaVersion'
import { JkBmsClient } from '../src/infrastructure/ble/JkBmsClient'
import { VictronScanner } from '../src/infrastructure/ble/VictronScanner'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
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
    createSolarHistoryLink: fakeSolarHistoryLink().create,
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
