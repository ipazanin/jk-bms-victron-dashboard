import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CHECKPOINT_INTERVAL_MS,
  SESSION_IDLE_TIMEOUT_MS,
  SessionRecorder,
} from '../src/application/history/SessionRecorder'
import type { RecorderClock } from '../src/application/history/SessionRecorder'
import type { BatterySnapshot } from '../src/domain/bms/types'
import { MIN_SESSION_SAMPLES } from '../src/domain/history/budget'
import { decodePackChunk, decodeSolarChunk } from '../src/domain/history/columns'
import { MAX_PAIRING_AGE_MS } from '../src/domain/history/join'
import { recomputeLedger } from '../src/domain/history/ledger'
import {
  CHUNK_CAPACITY,
  MAX_CHUNK_SPAN_MS,
  SAMPLE_INTERVAL_MS,
} from '../src/domain/history/types'
import type { PackSample, SessionId, SolarSample } from '../src/domain/history/types'
import type { Fault } from '../src/application/severity'
import type { SolarReading } from '../src/domain/solar/types'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { SAMPLE_EPOCH, battery, deviceInfo, solarReading, warningSnapshot } from './support/samples'

// The recorder is driven exactly as the radios drive it: synchronous observations, no awaits on
// the observation path, and every write pushed onto a chain the spec drains at the end. The clock
// is injected because vitest fakes `performance.now()` and not `performance.timeOrigin`, so a
// recorder reading a clock it was not handed would be reading half a fake.

const SOLAR_RSSI = -67

interface Harness {
  readonly recorder: SessionRecorder
  readonly store: MemoryHistoryStore
  /** Moves both clocks together, which is what an untroubled machine does. */
  advance(milliseconds: number): void
  /** Moves the wall clock only, which is what an NTP step does. */
  stepWallClock(milliseconds: number): void
  sessionId(): SessionId
  packRows(id?: SessionId): Promise<PackSample[]>
  solarRows(id?: SessionId): Promise<SolarSample[]>
  dispose(): void
}

function harnessFor(store: MemoryHistoryStore = new MemoryHistoryStore()): Harness {
  let wall = SAMPLE_EPOCH
  let monotonic = 0
  let ids = 0

  const clock: RecorderClock = { now: () => wall, monotonic: () => monotonic }
  const recorder = new SessionRecorder({
    store: () => store,
    clock,
    // The first id the recorder asks for is its writer id, so sessions start at one.
    newId: () => (ids === 0 ? (ids += 1, 'writer') : `session-${ids++}`),
  })

  const openId = (): SessionId => {
    const id = recorder.state.sessionId
    if (id === null) throw new Error('no session is open')
    return id
  }

  return {
    recorder,
    store,
    advance(milliseconds) {
      wall += milliseconds
      monotonic += milliseconds
    },
    stepWallClock(milliseconds) {
      wall += milliseconds
    },
    sessionId: openId,
    async packRows(id = openId()) {
      const stored = await store.readSession(id)
      return (stored?.pack ?? []).flatMap(decodePackChunk)
    },
    async solarRows(id = openId()) {
      const stored = await store.readSession(id)
      return (stored?.solar ?? []).flatMap(decodeSolarChunk)
    },
    dispose: () => recorder.dispose(),
  }
}

let harness: Harness

afterEach(() => {
  harness?.dispose()
  vi.useRealTimers()
})

/** Feeds `count` snapshots one sample interval apart, which is the rate the gate admits. */
function drivePack(count: number, overrides: (index: number) => Partial<BatterySnapshot> = () => ({})): void {
  for (let index = 0; index < count; index += 1) {
    harness.recorder.notePack(battery(overrides(index)))
    harness.advance(SAMPLE_INTERVAL_MS)
  }
}

function driveSolar(count: number, overrides: (index: number) => Partial<SolarReading> = () => ({})): void {
  for (let index = 0; index < count; index += 1) {
    harness.recorder.noteSolar(solarReading(overrides(index)), SOLAR_RSSI)
    harness.advance(SAMPLE_INTERVAL_MS)
  }
}

describe('what reaches the archive is exactly what the radios said', () => {
  // The regression the whole change stands on. Nothing between a decoded frame and a stored row
  // may round, damp, average or derive: a number that acquired a correction on the way in is
  // indistinguishable from a measurement forever afterwards, and the archive's one claim is that
  // it holds what the radios reported.

  /**
   * Currents at the scale the BMS transmits — a signed integer of milliamps — alternating loaded
   * and resting so any smoothing would show up as a value between two of them.
   */
  const CURRENTS = [-5.037, 4.401, -0.009, 2.9, -4.7, 0.13, -3.004, 2.6, -5.5, 4.096, -0.001, 3.75]

  const PACK_COLUMN_NAMES = [
    'cellDeltaMv',
    'currentMa',
    'highestCell',
    'lowestCell',
    'mosfetDeciC',
    'offsetMs',
    'packVoltageMv',
    'remainingCapacityMah',
    'stateOfCharge',
    'switches',
    'temperature1DeciC',
    'temperature2DeciC',
  ]

  it('carries every pack figure through at full float precision', async () => {
    harness = harnessFor()
    // Every figure is built from the integer the radio transmits, divided by its own scale, which
    // is the only way to write a fixture a decoder could really have produced. Accumulating a
    // tenth at a time would land on 30.200000000000003, which no BMS ever sent.
    const snapshots = CURRENTS.map((current, index) =>
      battery({
        current,
        packVoltage: (13_573 - index * 4) / 1_000,
        remainingCapacity: (309_100 - index * 250) / 1_000,
        cellDelta: (1 + index) / 1_000,
        stateOfCharge: 98 - index,
        mosfetTemperature: (301 + index) / 10,
        temperatureSensor1: 27.5,
        temperatureSensor2: -1.3,
        chargingEnabled: index % 2 === 0,
        dischargingEnabled: true,
      }),
    )

    for (const snapshot of snapshots) {
      harness.recorder.notePack(snapshot)
      harness.advance(SAMPLE_INTERVAL_MS)
    }
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    const rows = await harness.packRows()
    expect(rows).toHaveLength(snapshots.length)
    rows.forEach((row, index) => {
      const snapshot = snapshots[index]
      // Identity, not closeness. `toBeCloseTo` here would pass over exactly the corruption this
      // exists to catch.
      expect(row.currentA).toBe(snapshot.current)
      expect(row.packVoltageV).toBe(snapshot.packVoltage)
      expect(row.remainingCapacityAh).toBe(snapshot.remainingCapacity)
      expect(row.cellDeltaV).toBe(snapshot.cellDelta)
      expect(row.stateOfCharge).toBe(snapshot.stateOfCharge)
      expect(row.mosfetTemperatureC).toBe(snapshot.mosfetTemperature)
      expect(row.temperatureSensor1C).toBe(snapshot.temperatureSensor1)
      expect(row.temperatureSensor2C).toBe(snapshot.temperatureSensor2)
      expect(row.highestCell).toBe(snapshot.highestCell)
      expect(row.lowestCell).toBe(snapshot.lowestCell)
      expect(row.chargingEnabled).toBe(snapshot.chargingEnabled)
      expect(row.dischargingEnabled).toBe(snapshot.dischargingEnabled)
    })
  })

  it('never lands a stored current between two the radio reported', async () => {
    // What a filter would leave behind. Every stored value is one of the twelve that went in, in
    // the order they went in, and the run reproduces the input exactly.
    harness = harnessFor()
    drivePack(CURRENTS.length, (index) => ({ current: CURRENTS[index] }))
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    expect((await harness.packRows()).map((row) => row.currentA)).toEqual(CURRENTS)
  })

  it('carries every solar figure through at the scale the controller broadcast', async () => {
    harness = harnessFor()
    const readings = [
      solarReading({ batteryVoltage: 13.57, batteryCurrent: 12.3, yieldTodayKwh: 0.42, pvPower: 168, loadCurrent: 0 }),
      solarReading({ batteryVoltage: 14.21, batteryCurrent: -0.3, yieldTodayKwh: 1.47, pvPower: 9, loadCurrent: 3.2 }),
      solarReading({ batteryVoltage: null, batteryCurrent: null, yieldTodayKwh: null, pvPower: null, loadCurrent: null }),
    ]

    for (const reading of readings) {
      harness.recorder.noteSolar(reading, SOLAR_RSSI)
      harness.advance(SAMPLE_INTERVAL_MS)
    }
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    const rows = await harness.solarRows()
    rows.forEach((row, index) => {
      const reading = readings[index]
      expect(row.batteryVoltageV).toBe(reading.batteryVoltage)
      expect(row.batteryCurrentA).toBe(reading.batteryCurrent)
      expect(row.yieldTodayKwh).toBe(reading.yieldTodayKwh)
      expect(row.pvPowerW).toBe(reading.pvPower)
      expect(row.loadCurrentA).toBe(reading.loadCurrent)
      expect(row.chargeState).toBe(reading.chargeState)
      expect(row.rssi).toBe(SOLAR_RSSI)
    })
  })

  it('stores no derived column, so a corrected noise floor corrects what is already on disk', async () => {
    // There is no house column and no power column. `house = solar − pack` is arithmetic done on
    // read, and storing it would freeze today's plausibility rule into every recording.
    harness = harnessFor()
    drivePack(4)
    driveSolar(4)
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    const stored = await harness.store.readSession(harness.sessionId())
    const columns = Object.entries(stored!.pack[0])
      .filter(([, value]) => ArrayBuffer.isView(value))
      .map(([name]) => name)
      .sort()

    expect(columns).toEqual(PACK_COLUMN_NAMES)
  })

  it('freezes the snapshot the radio handed over as the session’s last word', async () => {
    harness = harnessFor()
    drivePack(MIN_SESSION_SAMPLES + 2)
    const last = battery({ current: -9.876, stateOfCharge: 41 })
    harness.recorder.notePack(last)
    harness.recorder.finish('user-disconnect')
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    expect(listing.record.finalBattery).toEqual(last)
  })

  it('folds a ledger the stored chunks reproduce exactly', async () => {
    // The cached ledger is a cache of a pure function of the chunks. If the two ever disagree, the
    // figure on a session row is a second opinion nobody can check.
    harness = harnessFor()
    // The two radios report on their own cadences and land on their own instants, which is the
    // merged timeline both the running fold and a later rescan walk.
    for (let index = 0; index < 40; index += 1) {
      harness.recorder.notePack(battery({ current: index < 24 ? -5.037 : 9.4, stateOfCharge: 98 - index }))
      harness.advance(SAMPLE_INTERVAL_MS / 2)
      harness.recorder.noteSolar(solarReading({ batteryCurrent: index < 24 ? 7.9 : 2.1 }), SOLAR_RSSI)
      harness.advance(SAMPLE_INTERVAL_MS / 2)
    }
    const id = harness.sessionId()
    harness.recorder.finish('user-disconnect')
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    const rescanned = recomputeLedger(await harness.packRows(id), await harness.solarRows(id), MAX_PAIRING_AGE_MS)

    expect(rescanned).toEqual(listing.record.ledger)
  })
})

describe('when a session opens', () => {
  it('opens nothing at all until a frame actually arrives', async () => {
    // `connect()` resolves once the read commands are written, not once anything comes back. At
    // that instant there is no identity and no reading to open a session with, and an empty
    // session row would be a fabrication.
    harness = harnessFor()

    await harness.recorder.drain()

    expect(harness.recorder.state.sessionId).toBeNull()
    expect(await harness.store.listSessions()).toHaveLength(0)
  })

  it('opens on the first pack sample', async () => {
    harness = harnessFor()
    harness.recorder.notePack(battery())
    await harness.recorder.drain()

    expect(harness.recorder.state.sessionId).not.toBeNull()
    expect(harness.recorder.state.packSamples).toBe(1)
    expect(await harness.store.listSessions()).toHaveLength(1)
  })

  it('opens on a solar advertisement alone, because a solar-only watch is a watch', async () => {
    harness = harnessFor()
    harness.recorder.noteSolar(solarReading(), SOLAR_RSSI)
    await harness.recorder.drain()

    expect(harness.recorder.state.solarSamples).toBe(1)
    const [listing] = await harness.store.listSessions()
    expect(listing.record.groupKey).toBe('pack:unidentified')
  })

  it('opens with a first entry saying so', async () => {
    harness = harnessFor()
    drivePack(MIN_SESSION_SAMPLES + 1)
    harness.recorder.finish('user-disconnect')
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    expect(listing.record.entries[0]).toEqual({
      at: SAMPLE_EPOCH,
      kind: 'begin',
      level: 'neutral',
      text: 'Session begins',
    })
  })

  it('records nothing whatsoever when the browser cannot keep an archive', async () => {
    harness = harnessFor(new MemoryHistoryStore({ availability: { usable: false, reason: 'no-indexeddb' } }))

    drivePack(20)
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    // The store here still stores; only its availability says no. That is the only way to prove
    // the recorder refused rather than wrote and lost it.
    expect(harness.recorder.state.sessionId).toBeNull()
    expect(await harness.store.listSessions()).toHaveLength(0)
  })
})

describe('the two sample gates', () => {
  it('admits one row a second per stream and drops the rest', async () => {
    harness = harnessFor()
    harness.recorder.notePack(battery({ current: -1 }))
    harness.advance(400)
    harness.recorder.notePack(battery({ current: -2 }))
    harness.advance(400)
    harness.recorder.notePack(battery({ current: -3 }))
    harness.advance(400)
    harness.recorder.notePack(battery({ current: -4 }))
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    // Rows at 0 ms and 1200 ms; the two inside the interval are gate-dropped, not averaged in.
    expect((await harness.packRows()).map((row) => row.currentA)).toEqual([-1, -4])
  })

  it('runs the two gates independently, so one radio cannot silence the other', async () => {
    harness = harnessFor()
    harness.recorder.notePack(battery())
    harness.advance(500)
    harness.recorder.noteSolar(solarReading(), SOLAR_RSSI)
    harness.advance(500)
    harness.recorder.notePack(battery())
    harness.advance(500)
    harness.recorder.noteSolar(solarReading(), SOLAR_RSSI)
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    expect(harness.recorder.state.packSamples).toBe(2)
    expect(harness.recorder.state.solarSamples).toBe(2)
  })

  it('admits a row at exactly the interval', async () => {
    harness = harnessFor()
    harness.recorder.notePack(battery())
    harness.advance(SAMPLE_INTERVAL_MS)
    harness.recorder.notePack(battery())
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    expect(harness.recorder.state.packSamples).toBe(2)
  })
})

describe('chunks', () => {
  it('seals at capacity and carries on into the next one', async () => {
    harness = harnessFor()
    drivePack(CHUNK_CAPACITY + 5)
    await harness.recorder.drain()

    const stored = await harness.store.readSession(harness.sessionId())
    expect(stored?.pack.map((chunk) => chunk.seq)).toEqual([0, 1])
    expect(stored?.pack[0].length).toBe(CHUNK_CAPACITY)
    expect(stored?.pack[0].sealed).toBe(true)
    // Only the seal moved the counter; the open tail has told it nothing yet.
    expect((await harness.store.usage()).totalSamples).toBe(CHUNK_CAPACITY)
  })

  it('seals early past the span bound, so an offset can never wrap', async () => {
    harness = harnessFor()
    harness.recorder.notePack(battery())
    harness.advance(MAX_CHUNK_SPAN_MS / 2)
    harness.recorder.notePack(battery())
    harness.advance(MAX_CHUNK_SPAN_MS / 2 + 1_000)
    harness.recorder.notePack(battery())
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    const stored = await harness.store.readSession(harness.sessionId())
    expect(stored?.pack.map((chunk) => chunk.length)).toEqual([2, 1])
  })

  it('says how far the wall clock drifted from the clock the offsets are measured against', async () => {
    harness = harnessFor()
    harness.recorder.notePack(battery())
    harness.advance(SAMPLE_INTERVAL_MS)
    harness.stepWallClock(3_600_000)
    harness.recorder.notePack(battery())
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    const stored = await harness.store.readSession(harness.sessionId())
    expect(stored?.pack[0].wallDriftMs).toBe(3_600_000)
  })
})

describe('naming the pack', () => {
  it('patches a session that was already open, because frame order is the BMS’s business', async () => {
    // Device info is requested first, but nothing enforces that it arrives first, and a decode
    // failure is swallowed. So the session opens unnamed and is named when the frame turns up.
    harness = harnessFor()
    drivePack(4)
    await harness.recorder.drain()
    expect((await harness.store.listSessions())[0].record.packDeviceKey).toBeNull()

    harness.recorder.identify(deviceInfo(), 'JK-B2A8S20P')
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    expect(listing.record.packDeviceKey).toBe('jk:DEMO00000000001')
    expect(listing.record.groupKey).toBe('jk:DEMO00000000001')
    expect(listing.label).toBe('JK_B2A8S20P · …0001')
  })

  it('splits the session when a different pack turns up on it', async () => {
    // Two banks and one controller is an ordinary boat. A silent relabel would hand one bank's
    // amp-hours to the other with nothing on screen to say so.
    harness = harnessFor()
    harness.recorder.identify(deviceInfo(), null)
    drivePack(MIN_SESSION_SAMPLES + 2)
    const first = harness.sessionId()

    harness.recorder.identify(deviceInfo({ serialNumber: 'DEMO00000000002' }), null)
    drivePack(MIN_SESSION_SAMPLES + 2)
    const second = harness.sessionId()
    harness.recorder.finish('user-disconnect')
    await harness.recorder.drain()

    expect(second).not.toBe(first)
    const listings = await harness.store.listSessions()
    expect(listings).toHaveLength(2)
    expect(listings.map((listing) => listing.record.endReason).sort()).toEqual([
      'device-changed',
      'user-disconnect',
    ])
  })

  it('says nothing new when the same pack identifies itself twice', async () => {
    harness = harnessFor()
    harness.recorder.identify(deviceInfo(), null)
    drivePack(4)
    const opened = harness.sessionId()

    harness.recorder.identify(deviceInfo(), null)

    expect(harness.recorder.state.sessionId).toBe(opened)
  })

  it('writes a device row the archive can group under', async () => {
    harness = harnessFor()
    harness.recorder.identify(deviceInfo(), null)
    drivePack(4)
    await harness.recorder.drain()

    const [device] = await harness.store.listDevices()
    expect(device.key).toBe('jk:DEMO00000000001')
    expect(device.defaultLabel).toBe('JK_B2A8S20P · …0001')
    expect(device.userLabel).toBeNull()
    expect(device.sessionCount).toBe(1)
  })

  it('names the controller from the digest of its advertisement key', async () => {
    harness = harnessFor()
    drivePack(4)
    harness.recorder.identifySolar('victron:3f9a17c40b2e', 0xa057)
    driveSolar(2)
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    const solar = (await harness.store.listDevices()).find((device) => device.kind === 'solar')
    expect(solar?.key).toBe('victron:3f9a17c40b2e')
    expect(solar?.defaultLabel).toBe('SmartSolar · 0xa057')
  })
})

describe('a pack link that goes away mid-watch', () => {
  it('keeps recording the controller into the same session', async () => {
    // A session is one continuous recording period bounded by the radios, not by the pack link.
    // The solar rows across the gap are exactly the rows the live sampler throws away for want of
    // a battery snapshot.
    harness = harnessFor()
    drivePack(6)
    const id = harness.sessionId()

    harness.recorder.endPackStream(battery({ current: -7.7 }), 'link-lost')
    driveSolar(6)
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    expect(harness.recorder.state.sessionId).toBe(id)
    expect(await harness.solarRows(id)).toHaveLength(6)
    const [listing] = await harness.store.listSessions()
    expect(listing.record.finalBattery?.current).toBe(-7.7)
  })

  it('stops the last snapshot standing in for a pack that is no longer reporting', async () => {
    // Without this the house figure would be computed against a frozen current all night, and the
    // coverage would claim both radios were reporting throughout.
    harness = harnessFor()
    drivePack(6)

    harness.recorder.endPackStream(battery(), 'link-lost')
    driveSolar(6)
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    expect(listing.record.coverage.map((run) => run.kind)).toContain('solar-only')
  })

  it('marks the hole when the pack comes back, and keeps the same session', async () => {
    harness = harnessFor()
    drivePack(6)
    const id = harness.sessionId()
    harness.recorder.endPackStream(battery(), 'link-lost')
    // The last row landed one interval before the clock stands now, so this is 45 s of silence.
    harness.advance(45_000 - SAMPLE_INTERVAL_MS)

    drivePack(6)
    harness.recorder.finish('user-disconnect')
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    expect(listing.record.id).toBe(id)
    const gap = listing.record.entries.find((entry) => entry.kind === 'gap')
    expect(gap?.text).toBe('No samples for 45 s — the BMS dropped')
  })

  it('starts a new chunk sequence for the pack rather than reopening the sealed one', async () => {
    harness = harnessFor()
    drivePack(6)
    const id = harness.sessionId()
    harness.recorder.endPackStream(battery(), 'stalled')
    harness.advance(45_000)
    drivePack(6)
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    const stored = await harness.store.readSession(id)
    expect(stored?.pack.map((chunk) => chunk.seq)).toEqual([0, 1])
    expect(stored?.pack[0].sealed).toBe(true)
  })
})

describe('a controller that goes quiet', () => {
  it('is not a session end, and its rows resume when it comes back', async () => {
    harness = harnessFor()
    drivePack(3)
    driveSolar(3)
    const id = harness.sessionId()

    harness.recorder.endSolarStream()
    drivePack(3)
    expect(harness.recorder.state.sessionId).toBe(id)

    driveSolar(3)
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    expect(await harness.solarRows(id)).toHaveLength(6)
  })

  it('stops stamping the last reading, so the coverage becomes pack-only', async () => {
    harness = harnessFor()
    for (let index = 0; index < 4; index += 1) {
      harness.recorder.noteSolar(solarReading(), SOLAR_RSSI)
      harness.recorder.notePack(battery())
      harness.advance(SAMPLE_INTERVAL_MS)
    }
    harness.recorder.endSolarStream()
    drivePack(6)
    harness.recorder.finish('user-disconnect')
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    expect(listing.record.coverage.map((run) => run.kind)).toEqual(['both', 'pack-only'])
  })
})

describe('finishing', () => {
  it('closes the row, marks how it ended, and resolves the drain', async () => {
    harness = harnessFor()
    drivePack(MIN_SESSION_SAMPLES + 2)

    harness.recorder.finish('link-lost')
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    expect(listing.record.state).toBe('closed')
    expect(listing.record.endReason).toBe('link-lost')
    expect(harness.recorder.state.sessionId).toBeNull()
  })

  it('is idempotent and never resurrects what it already closed', async () => {
    harness = harnessFor()
    drivePack(MIN_SESSION_SAMPLES + 2)

    harness.recorder.finish('user-disconnect')
    harness.recorder.finish('stalled')
    await harness.recorder.drain()

    const listings = await harness.store.listSessions()
    expect(listings).toHaveLength(1)
    expect(listings[0].record.endReason).toBe('user-disconnect')
  })

  it('deletes a watch too short to be one, rather than keeping a row of noise', async () => {
    harness = harnessFor()
    drivePack(MIN_SESSION_SAMPLES - 1)

    harness.recorder.finish('user-disconnect')
    await harness.recorder.drain()

    expect(await harness.store.listSessions()).toHaveLength(0)
    expect((await harness.store.usage()).totalSamples).toBe(0)
  })

  it('marks the deepest state of charge where it happened, not where it was noticed', async () => {
    harness = harnessFor()
    drivePack(12, (index) => ({ stateOfCharge: index === 4 ? 41 : 61 }))

    harness.recorder.finish('user-disconnect')
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    const deepest = listing.record.entries.find((entry) => entry.kind === 'deepest')
    expect(deepest?.text).toBe('Deepest — 41%')
    expect(deepest?.at).toBe(SAMPLE_EPOCH + 4 * SAMPLE_INTERVAL_MS)
    expect(listing.record.entries.at(-1)?.kind).toBe('end')
  })

  it('says in the owner’s words why the watch ended', async () => {
    harness = harnessFor()
    drivePack(MIN_SESSION_SAMPLES + 2)

    harness.recorder.finish('user-disconnect')
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    expect(listing.record.entries.at(-1)?.text).toBe('Session ends — you disconnected')
  })

  it('lets go of an open session on dispose without inventing an ending for it', async () => {
    // A recorder torn down mid-recording has learned nothing about how the session ended. The
    // stale-heartbeat sweep closes it 'abandoned' on the next load, which is what happened.
    harness = harnessFor()
    drivePack(MIN_SESSION_SAMPLES + 2)

    harness.recorder.dispose()
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    expect(listing.record.state).toBe('open')
    expect(listing.record.endReason).toBeNull()
  })
})

describe('the annunciator’s own log', () => {
  it('keeps the headline exactly as it read at the time', async () => {
    harness = harnessFor()
    drivePack(4)
    harness.recorder.noteStatus('warning', 'Low charge — 20% remaining. Charge the bank.')
    drivePack(4)
    harness.recorder.noteStatus('good', 'No active faults')
    drivePack(4)
    harness.recorder.finish('user-disconnect')
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    const kinds = listing.record.entries.map((entry) => entry.kind)
    expect(kinds).toContain('fault')
    expect(kinds).toContain('cleared')
    expect(listing.record.entries.find((entry) => entry.kind === 'fault')?.text).toBe(
      'Low charge — 20% remaining. Charge the bank.',
    )
  })

  it('says nothing when nothing changed', async () => {
    harness = harnessFor()
    drivePack(4)
    harness.recorder.noteStatus('warning', 'Cell imbalance')
    harness.recorder.noteStatus('warning', 'Cell imbalance')
    drivePack(8)
    harness.recorder.finish('user-disconnect')
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    expect(listing.record.entries.filter((entry) => entry.kind === 'fault')).toHaveLength(1)
  })

  it('records a fault that was already standing when the session opened', async () => {
    // The status watch only fires on a change, so nothing else would ever record it.
    harness = harnessFor()
    harness.recorder.noteStatus('serious', 'MOSFET 82 °C')
    drivePack(MIN_SESSION_SAMPLES + 2)
    harness.recorder.finish('user-disconnect')
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    expect(listing.record.entries[1]).toMatchObject({ kind: 'fault', text: 'MOSFET 82 °C' })
  })
})

describe('an archive that will not take the write', () => {
  const quota = (): DOMException => new DOMException('no room', 'QuotaExceededError')

  it('keeps the rows and retries, rather than giving up on the first refusal', async () => {
    harness = harnessFor()
    drivePack(12)
    harness.store.failNextCommitWith(quota())

    harness.recorder.endPackStream(battery(), 'user')
    await harness.recorder.drain()

    expect(harness.recorder.state.failure).toBe('quota-exhausted')
    expect(harness.recorder.state.droppedChunks).toBe(0)

    // The next checkpoint retries the same chunk, and this time the store takes it.
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    expect(harness.recorder.state.droppedChunks).toBe(0)
    expect((await harness.store.usage()).totalSamples).toBe(12)
  })

  it('gives the chunk up after the second refusal and draws the hole as a hole', async () => {
    // Five lost minutes beat a recorder that stops recording.
    harness = harnessFor()
    drivePack(12)
    harness.store.failNextCommitWith(quota())
    harness.recorder.endPackStream(battery(), 'user')
    await harness.recorder.drain()

    harness.store.failNextCommitWith(quota())
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    expect(harness.recorder.state.droppedChunks).toBe(1)
    expect((await harness.store.usage()).totalSamples).toBe(0)

    // The recorder appends nothing further after a refusal, so the hole reaches the row when the
    // session closes — which is the next write there is.
    harness.recorder.finish('user-disconnect')
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    expect(listing.record.droppedChunks).toBe(1)
    expect(listing.record.entries.some((entry) => entry.text.includes('could not be stored'))).toBe(true)
  })

  it('appends nothing further once the archive has refused, and the instruments carry on', async () => {
    harness = harnessFor()
    drivePack(12)
    harness.store.failNextCommitWith(quota())
    harness.recorder.endPackStream(battery(), 'user')
    await harness.recorder.drain()

    const before = harness.recorder.state.packSamples
    harness.recorder.beginPackStream()
    drivePack(10)
    await harness.recorder.drain()

    expect(harness.recorder.state.packSamples).toBe(before)
  })

  it('never throws back into the radio callback, whatever the store does', async () => {
    // A BLE notification handler that raises is a lost frame at best and a dropped link at worst.
    harness = harnessFor()
    drivePack(12)
    harness.store.failNextCommitWith(new Error('something nobody predicted'))

    expect(() => harness.recorder.checkpoint()).not.toThrow()
    await expect(harness.recorder.drain()).resolves.toBeUndefined()
    expect(() => harness.recorder.notePack(battery())).not.toThrow()
  })

  it('opens a fresh session continuing the one another tab closed underneath it', async () => {
    harness = harnessFor()
    drivePack(12)
    const lost = harness.sessionId()
    await harness.recorder.drain()

    // The row is gone; the commit is refused with no storage failure to name, which is the only
    // remaining explanation.
    await harness.store.deleteSession(lost)
    harness.recorder.checkpoint()
    await harness.recorder.drain()
    expect(harness.recorder.state.sessionId).toBeNull()

    drivePack(12)
    await harness.recorder.drain()

    const [listing] = await harness.store.listSessions()
    expect(listing.record.id).not.toBe(lost)
    expect(listing.record.continues).toBe(lost)
  })
})

describe('the write chain', () => {
  it('orders a commit behind the open it never awaited', async () => {
    // `connectBms` touches the recorder on the line before `requestDevice`, so nothing on the
    // observation path may be awaited. Ordering comes from the chain instead.
    harness = harnessFor()
    harness.store.delayNextOpenBy(20)

    harness.recorder.notePack(battery())
    harness.advance(SAMPLE_INTERVAL_MS)
    harness.recorder.notePack(battery())
    harness.recorder.checkpoint()
    await harness.recorder.drain()

    const stored = await harness.store.readSession(harness.sessionId())
    expect(stored?.pack[0].length).toBe(2)
  })

  it('resolves the drain even when nothing was ever recorded', async () => {
    harness = harnessFor()

    await expect(harness.recorder.drain()).resolves.toBeUndefined()
  })
})

describe('the zombie guard', () => {
  it('closes a session nothing has been observed on', async () => {
    // Without it, a session opened by a stray frame during a connect() that then threw would stay
    // open forever — heartbeating, immune to recovery, and protected from eviction by the very
    // heartbeat that proves nothing is watching it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    harness = harnessFor()
    drivePack(MIN_SESSION_SAMPLES + 2)

    harness.advance(SESSION_IDLE_TIMEOUT_MS)
    vi.advanceTimersByTime(CHECKPOINT_INTERVAL_MS)
    vi.useRealTimers()
    await harness.recorder.drain()

    expect(harness.recorder.state.sessionId).toBeNull()
    const [listing] = await harness.store.listSessions()
    expect(listing.record.endReason).toBe('stalled')
  })

  it('leaves a session alone while frames are still arriving', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    harness = harnessFor()
    drivePack(MIN_SESSION_SAMPLES + 2)
    const id = harness.sessionId()

    // One interval has already passed since the last snapshot, so this stops a second short.
    harness.advance(SESSION_IDLE_TIMEOUT_MS - 2 * SAMPLE_INTERVAL_MS)
    vi.advanceTimersByTime(CHECKPOINT_INTERVAL_MS)
    vi.useRealTimers()
    await harness.recorder.drain()

    expect(harness.recorder.state.sessionId).toBe(id)
  })
})

describe('warnings', () => {
  const imbalance = (level: Fault['level'], detail: string): Fault[] => [
    { level, title: 'Cell imbalance', detail },
  ]

  it('records an escalation of the same fault as a second row at the higher level', async () => {
    harness = harnessFor()
    harness.recorder.notePack(battery()) // opens a session
    harness.recorder.noteWarnings(imbalance('warning', '20 mV'), warningSnapshot(), SAMPLE_EPOCH)
    harness.recorder.noteWarnings(imbalance('serious', '55 mV'), warningSnapshot(), SAMPLE_EPOCH + 1_000)
    await harness.recorder.drain()

    const warnings = await harness.store.listWarnings()
    expect(warnings.map((warning) => warning.level).sort()).toEqual(['serious', 'warning'])
  })

  it('writes one row while a fault stands at the same level', async () => {
    harness = harnessFor()
    harness.recorder.notePack(battery())
    for (let index = 0; index < 4; index += 1) {
      harness.recorder.noteWarnings(imbalance('warning', '20 mV'), warningSnapshot(), SAMPLE_EPOCH + index * 1_000)
    }
    await harness.recorder.drain()

    expect(await harness.store.listWarnings()).toHaveLength(1)
  })

  it('records afresh after a fault clears and returns', async () => {
    harness = harnessFor()
    harness.recorder.notePack(battery())
    harness.recorder.noteWarnings(imbalance('warning', 'x'), warningSnapshot(), SAMPLE_EPOCH)
    harness.recorder.noteWarnings([], warningSnapshot(), SAMPLE_EPOCH + 1_000) // clears
    harness.recorder.noteWarnings(imbalance('warning', 'x'), warningSnapshot(), SAMPLE_EPOCH + 2_000) // returns
    await harness.recorder.drain()

    expect(await harness.store.listWarnings()).toHaveLength(2)
  })
})
