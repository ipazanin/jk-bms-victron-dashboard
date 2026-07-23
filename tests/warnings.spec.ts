// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTelemetry } from '../src/application/telemetry'
import type { Telemetry } from '../src/application/telemetry'
import { battery, solarReading } from './support/samples'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { fakeBmsLink, fakeSolarScan } from './support/fakeRadios'
import type { FakeBmsLink, FakeSolarScan } from './support/fakeRadios'

// The warning path from end to end: a live fault, the recorder writing it once with the readings
// behind it, and a Map standing in for the archive.

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

describe('capturing a warning with its data', () => {
  it('writes a fault the instant it stands, with the readings behind it', async () => {
    await telemetry.connectBms()
    bms.emitSnapshot(battery({ mosfetTemperature: 72, current: -90.5, stateOfCharge: 61 }))
    await telemetry.drain()

    const warnings = await store.listWarnings()
    expect(warnings).toHaveLength(1)
    expect(warnings[0].title).toBe('MOSFET hot')
    expect(warnings[0].level).toBe('serious')
    expect(warnings[0].snapshot.mosfetTemperatureC).toBe(72)
    expect(warnings[0].snapshot.packCurrentA).toBe(-90.5)
    expect(warnings[0].snapshot.stateOfCharge).toBe(61)
  })

  it('keeps the solar readings beside a warning when both radios are live', async () => {
    await telemetry.startSolar(ADVERTISEMENT_KEY)
    await telemetry.connectBms()
    solar.emitReading(solarReading({ pvPower: 140, batteryCurrent: 5.2, chargeState: 'float' }))
    bms.emitSnapshot(battery({ mosfetTemperature: 72 }))
    await telemetry.drain()

    const [warning] = await store.listWarnings()
    expect(warning.snapshot.pvPowerW).toBe(140)
    expect(warning.snapshot.solarBatteryCurrentA).toBe(5.2)
    expect(warning.snapshot.solarChargeState).toBe('float')
  })

  it('writes one row while a fault stands, not one a second', async () => {
    await telemetry.connectBms()
    for (let index = 0; index < 4; index += 1) {
      bms.emitSnapshot(battery({ mosfetTemperature: 72 }))
      clock += 1000
    }
    await telemetry.drain()

    expect(await store.listWarnings()).toHaveLength(1)
  })

  it('records a fresh row when a fault clears and returns', async () => {
    await telemetry.connectBms()
    bms.emitSnapshot(battery({ mosfetTemperature: 72 })) // fires
    // Past FAULT_OFF_DELAY_MS (10 s), so the latch genuinely releases rather than riding a brief dip.
    clock += 11_000
    bms.emitSnapshot(battery({ mosfetTemperature: 30 })) // clears
    clock += 1000
    bms.emitSnapshot(battery({ mosfetTemperature: 72 })) // fires again
    await telemetry.drain()

    const warnings = await store.listWarnings()
    expect(warnings).toHaveLength(2)
    expect(warnings.map((warning) => warning.seq).sort()).toEqual([0, 1])
  })

  it('records an escalation as its own warning', async () => {
    await telemetry.connectBms()
    bms.emitSnapshot(battery({ mosfetTemperature: 60 })) // MOSFET warm (warning)
    clock += 1000
    bms.emitSnapshot(battery({ mosfetTemperature: 82 })) // MOSFET over temperature (critical)
    await telemetry.drain()

    const warnings = await store.listWarnings()
    expect(warnings.map((warning) => warning.title).sort()).toEqual([
      'MOSFET over temperature',
      'MOSFET warm',
    ])
  })

  it('records nothing while browsing a stored session rather than living one', async () => {
    // A fault re-derived from an hours-old snapshot must not be written as if it were happening now.
    await telemetry.connectBms()
    bms.emitSnapshot(battery({ mosfetTemperature: 72 }))
    await telemetry.disconnectBms()
    await telemetry.drain()
    const before = (await store.listWarnings()).length

    // Nothing new is emitted; the disconnect settled to remembered, which is not 'live'.
    expect(telemetry.source.value).not.toBe('live')
    expect((await store.listWarnings()).length).toBe(before)
  })
})
