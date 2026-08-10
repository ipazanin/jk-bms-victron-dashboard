/**
 * Walking a recorded scenario at the pace it was recorded at.
 *
 * A chain of one-shot timers, each armed for the gap to the next frame, rather than one interval.
 * The two radios ran at different rates and neither ran evenly — the pack streams about four times
 * a second with the jitter of a BLE link on it, the controller broadcasts about once — so an
 * interval would have to invent a common tick and would smooth away the very unevenness the
 * dashboard exists to absorb.
 *
 * The two streams are merged as the walk goes rather than up front, because a scenario can be
 * swapped mid-playback and a merged list would have to be rebuilt to do it. Where a pack frame and
 * a reading share an instant the pack goes first: the house load a reading feeds is derived against
 * the battery snapshot of that same moment, and a reading that arrives first has none to pair with.
 *
 * Running and paused are separate states on purpose. Running follows the radios — nothing plays
 * into a link that is not up — and paused is the panel's own transport control, so pausing playback
 * does not disconnect anything and reconnecting does not silently resume a paused walk.
 */

import type { PackFrame } from './fixture/PackFrame'
import type { PlaybackScenario } from './fixture/PlaybackScenario'
import type { SolarFrame } from './fixture/SolarFrame'

export interface PlaybackClockHandlers {
  readonly onPack: (frame: PackFrame) => void
  readonly onSolar: (frame: SolarFrame) => void
  /** The scenario has been walked to its end and starts again from its first frame. */
  readonly onLap: () => void
}

export class PlaybackClock {
  private readonly handlers: PlaybackClockHandlers
  private scenario: PlaybackScenario | null = null
  private packCursor = 0
  private solarCursor = 0
  /**
   * How far the walk has reached, in the scenario's own milliseconds. It goes back by a whole span
   * at each wrap, which is what lets the gap across the seam be measured with the same subtraction
   * as every other gap.
   */
  private positionMs = 0
  private speedMultiplier = 1
  private live = false
  private held = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(handlers: PlaybackClockHandlers) {
    this.handlers = handlers
  }

  /** True while a radio is up and the walk is armed. */
  get running(): boolean {
    return this.live
  }

  get paused(): boolean {
    return this.held
  }

  get speed(): number {
    return this.speedMultiplier
  }

  /** Frames handed over on this lap, and how many the scenario holds in total. */
  get delivered(): number {
    return this.packCursor + this.solarCursor
  }

  get total(): number {
    const scenario = this.scenario
    return scenario === null ? 0 : scenario.pack.length + scenario.solar.length
  }

  /** Loads a scenario and walks it from its first frame, whatever was playing before. */
  play(scenario: PlaybackScenario): void {
    this.scenario = scenario
    this.packCursor = 0
    this.solarCursor = 0
    this.positionMs = 0
    this.arm()
  }

  /** A radio has come up. Continues from wherever the walk had reached. */
  start(): void {
    this.live = true
    this.arm()
  }

  /** The radios have gone. The walk keeps its place, so the boat carries on while nobody listens. */
  stop(): void {
    this.live = false
    this.disarm()
  }

  pause(): void {
    this.held = true
    this.disarm()
  }

  resume(): void {
    this.held = false
    this.arm()
  }

  /** Hands over exactly one frame, whether or not the walk is armed. */
  step(): void {
    this.disarm()
    this.deliverNext()
    this.arm()
  }

  setSpeed(multiplier: number): void {
    if (multiplier <= 0) return
    this.speedMultiplier = multiplier
    this.arm()
  }

  private readonly fire = (): void => {
    this.timer = null
    this.deliverNext()
    this.arm()
  }

  private deliverNext(): void {
    const scenario = this.scenario
    if (scenario === null) return
    const packLeft = this.packCursor < scenario.pack.length
    const solarLeft = this.solarCursor < scenario.solar.length
    if (!packLeft && !solarLeft) return

    const packIsDue =
      packLeft &&
      (!solarLeft || scenario.pack[this.packCursor].atMs <= scenario.solar[this.solarCursor].atMs)
    if (packIsDue) {
      const frame = scenario.pack[this.packCursor]
      this.packCursor += 1
      this.positionMs = frame.atMs
      this.handlers.onPack(frame)
    } else {
      const frame = scenario.solar[this.solarCursor]
      this.solarCursor += 1
      this.positionMs = frame.atMs
      this.handlers.onSolar(frame)
    }

    if (this.packCursor < scenario.pack.length || this.solarCursor < scenario.solar.length) return
    this.packCursor = 0
    this.solarCursor = 0
    this.positionMs -= scenario.spanMs
    this.handlers.onLap()
  }

  private arm(): void {
    this.disarm()
    const scenario = this.scenario
    if (scenario === null || !this.live || this.held) return
    const nextMs = this.nextInstant(scenario)
    if (nextMs === null) return
    this.timer = setTimeout(this.fire, Math.max(0, (nextMs - this.positionMs) / this.speedMultiplier))
  }

  private nextInstant(scenario: PlaybackScenario): number | null {
    const packLeft = this.packCursor < scenario.pack.length
    const solarLeft = this.solarCursor < scenario.solar.length
    if (packLeft && solarLeft) {
      return Math.min(scenario.pack[this.packCursor].atMs, scenario.solar[this.solarCursor].atMs)
    }
    if (packLeft) return scenario.pack[this.packCursor].atMs
    if (solarLeft) return scenario.solar[this.solarCursor].atMs
    return null
  }

  private disarm(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
