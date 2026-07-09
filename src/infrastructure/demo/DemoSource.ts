/**
 * Replays a recorded passage of real telemetry so the page works without hardware.
 *
 * The recording is genuine, captured from a 4S LiFePO4 house bank under a cycling fridge
 * compressor, and it crosses zero current repeatedly — so the reconciliation hero is seen
 * in both the charging and discharging regime. Identity fields are demo placeholders.
 */

import type { BatterySnapshot, DeviceInfo } from '../../domain/bms/types'
import type { ChargeState, SolarReading } from '../../domain/solar/types'

interface TimelineSample {
  t: number
  battery: Omit<BatterySnapshot, 'cellDelta' | 'highestCell' | 'lowestCell'>
  solar?: {
    chargeState: string
    chargerError: number
    batteryVoltage: number
    batteryCurrent: number
    pvPower: number
    yieldTodayKwh: number
    loadCurrent: number | null
  }
}

interface Timeline {
  device: DeviceInfo
  intervalSeconds: number
  samples: TimelineSample[]
}

export interface DemoHandlers {
  onSnapshot?: (snapshot: BatterySnapshot) => void
  onSolar?: (reading: SolarReading) => void
  onDeviceInfo?: (info: DeviceInfo) => void
}

function withDerivedFields(battery: TimelineSample['battery']): BatterySnapshot {
  const voltages = battery.cellVoltages
  const highest = voltages.reduce((best, value, index) => (value > voltages[best] ? index : best), 0)
  const lowest = voltages.reduce((best, value, index) => (value < voltages[best] ? index : best), 0)
  return {
    ...battery,
    cellDelta: voltages[highest] - voltages[lowest],
    highestCell: highest + 1,
    lowestCell: lowest + 1,
  }
}

export class DemoSource {
  private timeline: Timeline | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private cursor = 0
  private withSolar = true
  private readonly handlers: DemoHandlers

  constructor(handlers: DemoHandlers = {}) {
    this.handlers = handlers
  }

  get running(): boolean {
    return this.timer !== null
  }

  /** `withSolar: false` replays the battery alone, to exercise the degraded page. */
  async start(withSolar = true): Promise<void> {
    this.withSolar = withSolar
    if (!this.timeline) {
      const response = await fetch(`${import.meta.env.BASE_URL}demo-timeline.json`)
      if (!response.ok) throw new Error('Could not load the demo recording.')
      this.timeline = (await response.json()) as Timeline
    }

    const timeline = this.timeline
    this.handlers.onDeviceInfo?.(timeline.device)
    this.cursor = 0
    this.emit()
    this.timer = setInterval(() => this.emit(), timeline.intervalSeconds * 1000)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  private emit(): void {
    const timeline = this.timeline
    if (!timeline) return

    const sample = timeline.samples[this.cursor]
    this.cursor = (this.cursor + 1) % timeline.samples.length

    this.handlers.onSnapshot?.(withDerivedFields(sample.battery))

    if (sample.solar && this.withSolar) {
      this.handlers.onSolar?.({
        chargeState: sample.solar.chargeState as ChargeState,
        chargerError: sample.solar.chargerError,
        batteryVoltage: sample.solar.batteryVoltage,
        batteryCurrent: sample.solar.batteryCurrent,
        yieldTodayKwh: sample.solar.yieldTodayKwh,
        pvPower: sample.solar.pvPower,
        loadCurrent: sample.solar.loadCurrent,
      })
    }
  }
}
