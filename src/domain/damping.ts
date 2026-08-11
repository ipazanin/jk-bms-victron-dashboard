/**
 * The figures a reader watches, as distinct from the samples an instrument draws.
 *
 * A bar and a band answer "what is the bus doing this instant" and are drawn from raw samples,
 * because that is the measurement. A watt figure answers a different question — how fast energy is
 * leaving, so how long the bank lasts — and that is a rate. Dividing an instant into an hour-long
 * question is the same error `project` refuses to make: on a boat whose fridge, autopilot and
 * windlass cycle through zero, the latest sample is a rate for nobody.
 *
 * So the readout is the window's time-weighted mean, and every derived figure is built from the
 * damped inputs rather than damped after the fact. `boat = solar − pack` subtracts two radios that
 * are never sampled at the same instant; taking each side's mean first cancels that timing error,
 * where filtering the difference afterwards would average it in.
 *
 * The second half of the job is cadence. A ten-second mean recomputed on every frame still rewrites
 * its last digit forever, so a published readout is held until it is worth replacing — either the
 * repaint interval has passed or the bus has genuinely moved. Held means the same object is handed
 * back, so a `shallowRef` carrying it does not even notify.
 *
 * Nothing here is ever recorded. The archive and the remembered snapshot take raw samples, on the
 * rule telemetry states: what is stored is what the radios said.
 */

import { TrailingWindow } from './reach'

/**
 * The window the readouts are meant over. A minute outlasts every load cycle on this boat, and it
 * is the shortest span an aperture can honestly print without falling back to seconds. The live
 * signal is not lost to it: the ammeter below draws its bars from raw samples, so a load switching
 * on is on screen immediately even while the watt figure is still walking towards it.
 */
export const READOUT_WINDOW_MS = 60_000

/** The floor on how often a figure may be rewritten, absent a real change on the bus. */
export const REPAINT_INTERVAL_MS = 5_000

/**
 * A move worth interrupting the repaint interval for, as a fraction of the figure standing. A
 * windlass or a fridge compressor drags the mean past this within a few seconds of switching, so a
 * genuine event reaches the screen well before the window has caught up with it; noise never does.
 */
const SIGNIFICANT_FRACTION = 0.25

/** Absolute floors, so a figure resting near zero cannot trip the fraction on nothing. */
const SIGNIFICANT_CURRENT_A = 1
const SIGNIFICANT_VOLTAGE_V = 0.15
const SIGNIFICANT_POWER_W = 20

export interface BusReadout {
  readonly packCurrentA: number
  readonly packVoltageV: number
  /** Null while no controller is delivering, which is not the same as a controller delivering zero. */
  readonly solarCurrentA: number | null
  readonly pvPowerW: number | null
  /** The window behind the figures, so a renderer can print the aperture it is showing. */
  readonly spanMs: number
  /** When this readout was published — not when it was last recomputed. */
  readonly at: number
}

/**
 * One window per input plus the cadence gate, kept together because the members have to be
 * published as a set: `boat = solar − pack` stops reconciling the moment one side is refreshed
 * and the other is not.
 */
export class BusReadoutMeter {
  private readonly packCurrent = new TrailingWindow(READOUT_WINDOW_MS)
  private readonly packVoltage = new TrailingWindow(READOUT_WINDOW_MS)
  private readonly solarCurrent = new TrailingWindow(READOUT_WINDOW_MS)
  private readonly pvPower = new TrailingWindow(READOUT_WINDOW_MS)
  private held: BusReadout | null = null

  observe(
    at: number,
    packCurrentA: number,
    packVoltageV: number,
    solarCurrentA: number | null,
    pvPowerW: number | null,
  ): void {
    this.packCurrent.observe(at, packCurrentA)
    this.packVoltage.observe(at, packVoltageV)
    if (solarCurrentA !== null) this.solarCurrent.observe(at, solarCurrentA)
    if (pvPowerW !== null) this.pvPower.observe(at, pvPowerW)
  }

  /**
   * The readout in force. The same object is returned while the gate holds, so a caller storing it
   * in a `shallowRef` repaints only when something is actually replaced.
   */
  read(at: number): BusReadout | null {
    const current = this.packCurrent.read(at)
    const voltage = this.packVoltage.read(at)
    // No pack means no readout at all: every figure on the card is either the pack's or derived
    // against its voltage, and there is nothing to hold from a window that has aged out.
    if (current === null || voltage === null) {
      this.held = null
      return null
    }

    const solar = this.solarCurrent.read(at)
    const pv = this.pvPower.read(at)
    const candidate: BusReadout = {
      packCurrentA: current.net,
      packVoltageV: voltage.net,
      solarCurrentA: solar?.net ?? null,
      pvPowerW: pv?.net ?? null,
      spanMs: current.spanMs,
      at,
    }

    if (this.held !== null && !worthReplacing(this.held, candidate)) return this.held
    this.held = candidate
    return candidate
  }

  clear(): void {
    this.packCurrent.clear()
    this.packVoltage.clear()
    this.solarCurrent.clear()
    this.pvPower.clear()
    this.held = null
  }
}

/**
 * A radio arriving or falling silent is a change of what the card can claim rather than a change of
 * degree, so it publishes immediately whatever the interval says.
 */
function worthReplacing(held: BusReadout, candidate: BusReadout): boolean {
  if (candidate.at - held.at >= REPAINT_INTERVAL_MS) return true
  if ((held.solarCurrentA === null) !== (candidate.solarCurrentA === null)) return true
  if ((held.pvPowerW === null) !== (candidate.pvPowerW === null)) return true

  return (
    moved(held.packCurrentA, candidate.packCurrentA, SIGNIFICANT_CURRENT_A) ||
    moved(held.packVoltageV, candidate.packVoltageV, SIGNIFICANT_VOLTAGE_V) ||
    moved(held.solarCurrentA ?? 0, candidate.solarCurrentA ?? 0, SIGNIFICANT_CURRENT_A) ||
    moved(held.pvPowerW ?? 0, candidate.pvPowerW ?? 0, SIGNIFICANT_POWER_W)
  )
}

function moved(held: number, candidate: number, floor: number): boolean {
  return Math.abs(candidate - held) > Math.max(floor, Math.abs(held) * SIGNIFICANT_FRACTION)
}
