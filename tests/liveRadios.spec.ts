// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTelemetry } from '../src/application/telemetry'
import type { Telemetry } from '../src/application/telemetry'
import { battery, solarReading } from './support/samples'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { fakeBmsLink, fakeSolarScan } from './support/fakeRadios'
import type { FakeBmsLink, FakeSolarScan } from './support/fakeRadios'

// The whole application layer with both radios faked and a Map behind the archive, which is the
// only level at which the two streams meeting one timeline can be asserted at all.

const ADVERTISEMENT_KEY = '0123456789abcdef0123456789abcdef'

let clock = 0
let telemetry: Telemetry
let bms: FakeBmsLink
let solar: FakeSolarScan
let store: MemoryHistoryStore
let session = 0

beforeEach(() => {
  localStorage.clear()
  clock = Date.now()
  session = 0
  bms = fakeBmsLink()
  solar = fakeSolarScan()
  store = new MemoryHistoryStore({ now: () => clock })
  telemetry = createTelemetry({
    createBmsLink: bms.create,
    createSolarScan: solar.create,
    historyStore: () => store,
    now: () => clock,
    monotonic: () => clock,
    newId: () => `session-${(session += 1)}`,
  })
})

afterEach(async () => {
  telemetry.dispose()
  await telemetry.drain()
  store.close()
  localStorage.clear()
})

describe('two radios feeding one trend', () => {
  it("records the tick's own pv power when the solar reading leads the snapshot", () => {
    // A solar advertisement claims no interval slot of its own — a sample always pairs a pack
    // current with the solar of that same instant — so the snapshot that follows inside the same
    // second is the one that records, carrying THIS tick's PV power rather than a lagging one.
    solar.emitReading(solarReading({ pvPower: 151 }))
    bms.emitSnapshot(battery())

    expect(telemetry.history).toHaveLength(1)
    expect(telemetry.history[0].pvPower).toBe(151)
  })

  it('records house power as a gap when the load is implausible, keeping pv power', () => {
    // The pack is charging at 10 A while the controller delivers only 2 A, so an unmeasured
    // source is on the bus: house = 2 − 10 = −8 A, far past the plausibility floor. The trace is
    // recorded as a hole rather than as a fabricated number, and pvPower stays a real reading.
    solar.emitReading(solarReading({ batteryCurrent: 2, batteryVoltage: 13.6, pvPower: 151 }))
    bms.emitSnapshot(battery({ current: 10, packVoltage: 13.6 }))

    expect(telemetry.history[0].housePower).toBeNull()
    expect(telemetry.history[0].pvPower).toBe(151)
  })
})

describe('what the recorder is told', () => {
  function driveSeconds(count: number, withSolar = false): void {
    for (let index = 0; index < count; index += 1) {
      if (withSolar) solar.emitReading(solarReading())
      bms.emitSnapshot(battery())
      clock += 1000
    }
  }

  it('opens a session on a solar advertisement alone', async () => {
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    solar.emitReading(solarReading())
    await telemetry.drain()

    expect(telemetry.recording.value.sessionId).not.toBeNull()
    expect(telemetry.recording.value.solarSamples).toBe(1)
    expect(await store.listSessions()).toHaveLength(1)
  })

  it('opens nothing when a link goes live and no frame ever arrives', async () => {
    await telemetry.connectBms()
    await telemetry.drain()

    expect(telemetry.bmsState.value).toBe('live')
    expect(telemetry.recording.value.sessionId).toBeNull()
    expect(await store.listSessions()).toHaveLength(0)
  })

  it('records nothing at all while a scan runs with no archive to write to', async () => {
    telemetry.dispose()
    telemetry = createTelemetry({
      createBmsLink: bms.create,
      createSolarScan: solar.create,
      historyStore: () => null,
      now: () => clock,
      monotonic: () => clock,
      newId: () => 'session',
    })

    await telemetry.startSolar(ADVERTISEMENT_KEY)
    solar.emitReading(solarReading())
    await telemetry.drain()

    expect(telemetry.recording.value.sessionId).toBeNull()
  })

  it('keeps one session across a BMS drop while the scan is still up', async () => {
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await telemetry.connectBms()
    driveSeconds(12, true)
    const opened = telemetry.recording.value.sessionId
    expect(opened).not.toBeNull()

    bms.emitDisconnect('dropped')
    solar.emitReading(solarReading())
    clock += 1000
    solar.emitReading(solarReading())
    await telemetry.drain()

    // The pack link went away; the watch did not. Solar rows carry on into the same session.
    expect(telemetry.recording.value.sessionId).toBe(opened)
    expect(await store.listSessions()).toHaveLength(1)
  })

  it('produces two sessions when the BMS drops with solar idle', async () => {
    await telemetry.connectBms()
    driveSeconds(12)
    bms.emitDisconnect('dropped')
    await telemetry.drain()

    await telemetry.connectBms()
    driveSeconds(12)
    await telemetry.disconnectBms()
    await telemetry.drain()

    expect(await store.listSessions()).toHaveLength(2)
  })

  it('checkpoints on a stale controller without ending the session', async () => {
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await telemetry.connectBms()
    driveSeconds(12, true)
    const opened = telemetry.recording.value.sessionId

    solar.emitStale()
    await telemetry.drain()

    expect(telemetry.solarState.value).toBe('listening')
    expect(telemetry.recording.value.sessionId).toBe(opened)
  })

  it('closes with the reason the radios gave', async () => {
    await telemetry.connectBms()
    driveSeconds(12)
    await telemetry.disconnectBms()
    await telemetry.drain()

    const [listing] = await store.listSessions()
    expect(listing.record.state).toBe('closed')
    expect(listing.record.endReason).toBe('user-disconnect')
  })

  it('closes as stalled when the BMS goes quiet rather than dropping', async () => {
    await telemetry.connectBms()
    driveSeconds(12)
    bms.emitDisconnect('stalled')
    await telemetry.drain()

    const [listing] = await store.listSessions()
    expect(listing.record.endReason).toBe('stalled')
  })

  it('names the pack from the device-info frame, whenever it arrives', async () => {
    await telemetry.connectBms()
    driveSeconds(12)
    bms.emitDeviceInfo({
      model: 'JK_B2A8S20P',
      hardwareVersion: '19H',
      softwareVersion: '19.10',
      serialNumber: 'DEMO00000000001',
      uptimeSeconds: 4_481_077,
      powerOnCount: 37,
    })
    await telemetry.disconnectBms()
    await telemetry.drain()

    const [listing] = await store.listSessions()
    expect(listing.record.packDeviceKey).toBe('jk:DEMO00000000001')
    expect(listing.label).toBe('JK_B2A8S20P · …0001')
  })
})
