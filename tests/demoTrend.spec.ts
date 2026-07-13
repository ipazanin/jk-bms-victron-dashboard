// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTelemetry } from '../src/application/telemetry'
import { DemoSource } from '../src/infrastructure/demo/DemoSource'

// telemetry.ts and its DemoSource are module-level singletons, so these tests run against
// shared state and reset it between each, as tests/telemetry.spec.ts does. DemoSource caches
// the timeline after its first load, so every test serves the SAME recording — one crafted so
// its first sample exercises both behaviours under test at once.

// Pack charging at 10 A while the controller delivers only 2 A means an unmeasured source
// (alternator, shore) is on the bus: house = solar − pack = 2 − 10 = −8 A, far past the
// plausibility floor, so the recorded house load must be a gap. pvPower stays a real number.
const battery = {
  cellVoltages: [3.4, 3.4, 3.4, 3.4],
  cellResistances: [0.05, 0.05, 0.05, 0.05],
  averageCellVoltage: 3.4,
  packVoltage: 13.6,
  current: 10,
  power: 136,
  stateOfCharge: 90,
  remainingCapacity: 280,
  nominalCapacity: 315,
  cycleCount: 4,
  cycledCapacity: 1200,
  mosfetTemperature: 30,
  temperatureSensor1: 27,
  temperatureSensor2: 27,
  chargingEnabled: true,
  dischargingEnabled: true,
  uptimeSeconds: 1000,
}

const TIMELINE = {
  device: { model: 'DEMO', hardwareVersion: '1', softwareVersion: '1', serialNumber: 'DEMO', uptimeSeconds: 1, powerOnCount: 1 },
  // Long enough that no second tick fires while a synchronous test runs.
  intervalSeconds: 3600,
  samples: [
    {
      t: 0,
      battery,
      solar: { chargeState: 'float', chargerError: 0, batteryVoltage: 13.5, batteryCurrent: 2, pvPower: 151, yieldTodayKwh: 1.0, loadCurrent: null },
    },
    {
      t: 3600,
      battery: { ...battery, current: -2 },
      solar: { chargeState: 'float', chargerError: 0, batteryVoltage: 13.5, batteryCurrent: 1, pvPower: 99, yieldTodayKwh: 1.0, loadCurrent: null },
    },
  ],
}

function serve(timeline: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => timeline })),
  )
}

let telemetry: ReturnType<typeof useTelemetry>

beforeEach(() => {
  telemetry = useTelemetry()
  telemetry.forgetRemembered()
  localStorage.clear()
  serve(TIMELINE)
})

afterEach(async () => {
  await telemetry.stopDemo()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('demo trend recording', () => {
  it("records the first point with this tick's pv power, not null and not a lagging value", async () => {
    await telemetry.startDemo(true)

    expect(telemetry.history).toHaveLength(1)
    expect(telemetry.history[0].pvPower).toBe(TIMELINE.samples[0].solar.pvPower)
    expect(telemetry.history[0].pvPower).not.toBeNull()
  })

  it('records house power as a gap when the load is implausible, keeping pv power', async () => {
    await telemetry.startDemo(true)

    expect(telemetry.history[0].housePower).toBeNull()
    expect(telemetry.history[0].pvPower).not.toBeNull()
  })
})

describe('DemoSource callback order', () => {
  it('delivers onSolar before onSnapshot so the snapshot reads this tick’s solar', async () => {
    serve(TIMELINE)
    const order: string[] = []
    const demo = new DemoSource({
      onDeviceInfo: () => order.push('device'),
      onSolar: () => order.push('solar'),
      onSnapshot: () => order.push('snapshot'),
    })

    await demo.start(true)
    demo.stop()

    expect(order).toContain('solar')
    expect(order.indexOf('solar')).toBeLessThan(order.indexOf('snapshot'))
  })
})
