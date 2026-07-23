/**
 * What the pack has been doing lately, as opposed to what it is doing this instant.
 *
 * Three of the page's claims cannot be answered by a single sample. A scale driven by the instant
 * breathes; a runtime measured in hours, divided out of a current that reverses every two seconds,
 * is false twice a minute; and a cell spread compared against a fixed threshold cannot tell
 * imbalance from wiring. All three want a window, and a window is state.
 *
 * State read inside a lazy computed becomes a function of how many times Vue chose to evaluate it,
 * which varies with what is mounted. So every window, every latch and every previous-verdict flag
 * lives here, is advanced by exactly one call, and is read afterwards as a plain ref.
 *
 * Nothing here reads a clock. `at` arrives from the caller, which is what lets a spec drive a ten
 * second off-delay or a six hour slope hold without a timer.
 *
 * The dependency runs one way only: this module reads snapshots and writes its own refs, and never
 * writes a telemetry ref. So no windowed, corrected or latched number can reach `recordSample`, a
 * `TrendPoint` or a `RememberedSession`. What is archived is what the radios said.
 */

import { shallowRef } from 'vue'
import type { ShallowRef } from 'vue'

import type { BatterySnapshot } from '../domain/bms/types'
import { SLOPE_HOLD_MS, STEP_EXCLUSION_A, deviationsMv, gradeBalance, theilSen } from '../domain/cellBalance'
import type { BalanceSample, BalanceVerdict } from '../domain/cellBalance'
import { project } from '../domain/dcBus'
import type { Projection } from '../domain/dcBus'
import { TrailingWindow } from '../domain/reach'
import type { Reach } from '../domain/reach'
import type { SolarReading } from '../domain/solar/types'
// Type-only: Fault is erased at build, so this leaves no runtime import edge back into
// telemetry.ts, which imports this module for its values.
import type { Fault } from './telemetry'

/** The ammeter's reach band and every axis ladder. Long enough to hold a load cycle, short enough
 *  that the band still describes now. */
export const REACH_WINDOW_MS = 30_000

/** A runtime projection is an integral, so its basis is a far longer window than any mark's. */
export const PROJECTION_WINDOW_MS = 300_000

/** The cell fit needs enough current variety to separate two terms, which takes minutes. */
export const BALANCE_WINDOW_MS = 120_000

/**
 * A fault stays in the list this long after its condition stops being true, keeping the detail it
 * last carried. Asymmetric on purpose: an annunciation is never delayed on the way in, and never
 * allowed to flicker away on the way out.
 */
export const FAULT_OFF_DELAY_MS = 10_000

/** Fraction of the trigger the spread must fall under before the imbalance warning clears. */
const IMBALANCE_CLEAR_FRACTION = 0.8

export interface Observations {
  /** Null whenever no sample has arrived inside the window, which is not the same as zero. */
  readonly packReach: Readonly<ShallowRef<Reach | null>>
  readonly solarReach: Readonly<ShallowRef<Reach | null>>
  /** Reach of the largest cell deviation from the pack mean, in millivolts. */
  readonly cellReach: Readonly<ShallowRef<Reach | null>>
  readonly balance: Readonly<ShallowRef<BalanceVerdict | null>>
  /** Amps of pack-current span across the window the balance verdict was graded over. */
  readonly balanceSwingA: Readonly<ShallowRef<number>>
  readonly projection: Readonly<ShallowRef<Projection | null>>

  /** The one feed. Everything above is recomputed from it, in the caller's own time. */
  observe(snapshot: BatterySnapshot, solar: SolarReading | null, at: number): void
  /**
   * Whether the cell spread should be annunciated, asserting at the trigger and clearing at four
   * fifths of it. It advances the latch, so one evaluation must call it exactly once.
   */
  imbalanceAsserted(spreadMv: number, triggerMv: number): boolean
  /** The candidate list plus whatever is still inside its off-delay, standing faults first. */
  latchFaults(candidates: readonly Fault[], at: number): Fault[]
  clear(): void
}

/**
 * One set of windows per telemetry. They are per-instance rather than module-level because two
 * telemetries alive at once — which is what a spec file is — would otherwise share a fault latch
 * and one pack would inherit another's verdict.
 */
export function createObservations(): Observations {
  const packCurrent = new TrailingWindow(REACH_WINDOW_MS)
  const solarCurrent = new TrailingWindow(REACH_WINDOW_MS)
  const cellDeviation = new TrailingWindow(REACH_WINDOW_MS)
  const projectionCurrent = new TrailingWindow(PROJECTION_WINDOW_MS)

  const packReach = shallowRef<Reach | null>(null)
  const solarReach = shallowRef<Reach | null>(null)
  const cellReach = shallowRef<Reach | null>(null)
  const balance = shallowRef<BalanceVerdict | null>(null)
  const balanceSwingA = shallowRef(0)
  const projection = shallowRef<Projection | null>(null)

  /** The balance fit needs whole samples rather than one number, so it keeps its own window. */
  let balanceSamples: BalanceSample[] = []
  let heldResistances: readonly number[] | null = null
  let heldResistancesAt = 0
  let holding = false
  let imbalanceStanding = false
  const offDelay = new Map<string, { readonly fault: Fault; readonly lastTrueAt: number }>()

  function observe(snapshot: BatterySnapshot, solar: SolarReading | null, at: number): void {
    packCurrent.observe(at, snapshot.current)
    projectionCurrent.observe(at, snapshot.current)
    // The solar window rides the snapshot clock deliberately: the ammeter draws the house load as
    // the span between the two tips against one shared axis, so both reaches have to be taken
    // across the same instants or the span would bracket two different windows.
    if (solar?.batteryCurrent != null) solarCurrent.observe(at, solar.batteryCurrent)

    const deviations = deviationsMv(snapshot.cellVoltages)
    if (deviations.length > 0) {
      cellDeviation.observe(at, largestMagnitudeOf(deviations))
      balanceSamples.push({
        at,
        current: snapshot.current,
        deviationsMv: deviations,
        cellDelta: snapshot.cellDelta,
      })
      const cutoff = at - BALANCE_WINDOW_MS
      let first = 0
      while (first < balanceSamples.length && balanceSamples[first].at < cutoff) first += 1
      if (first > 0) balanceSamples = balanceSamples.slice(first)
    }

    packReach.value = packCurrent.read(at)
    solarReach.value = solarCurrent.read(at)
    cellReach.value = cellDeviation.read(at)

    if (heldResistances !== null && at - heldResistancesAt > SLOPE_HOLD_MS) heldResistances = null
    const verdict = gradeBalance(balanceSamples, heldResistances)
    // A positive pair count means this window identified the slopes itself, so they are worth
    // keeping for a later window that cannot.
    if (verdict.kind === 'fitted' && verdict.pairs > 0) {
      const identified = identifyResistances(balanceSamples)
      if (identified !== null) {
        heldResistances = identified
        heldResistancesAt = at
      }
    }
    balance.value = verdict
    balanceSwingA.value = currentSwingOf(balanceSamples)

    const projected = project(snapshot, projectionCurrent.read(at), holding)
    holding = projected.kind === 'holding'
    projection.value = projected
  }

  function imbalanceAsserted(spreadMv: number, triggerMv: number): boolean {
    imbalanceStanding = imbalanceStanding
      ? spreadMv >= triggerMv * IMBALANCE_CLEAR_FRACTION
      : spreadMv >= triggerMv
    return imbalanceStanding
  }

  function latchFaults(candidates: readonly Fault[], at: number): Fault[] {
    const standing = new Set<string>()
    for (const candidate of candidates) {
      standing.add(candidate.title)
      offDelay.set(candidate.title, { fault: candidate, lastTrueAt: at })
    }

    const lingering: Fault[] = []
    for (const [title, held] of offDelay) {
      if (standing.has(title)) continue
      if (at - held.lastTrueAt >= FAULT_OFF_DELAY_MS) {
        offDelay.delete(title)
        continue
      }
      lingering.push(held.fault)
    }
    // Standing faults first, so a fault on its way out can never take the headline from one that
    // is still true.
    return [...candidates, ...lingering]
  }

  function clear(): void {
    packCurrent.clear()
    solarCurrent.clear()
    cellDeviation.clear()
    projectionCurrent.clear()
    balanceSamples = []
    heldResistances = null
    heldResistancesAt = 0
    holding = false
    imbalanceStanding = false
    offDelay.clear()

    packReach.value = null
    solarReach.value = null
    cellReach.value = null
    balance.value = null
    balanceSwingA.value = 0
    projection.value = null
  }

  return {
    packReach,
    solarReach,
    cellReach,
    balance,
    balanceSwingA,
    projection,
    observe,
    imbalanceAsserted,
    latchFaults,
    clear,
  }
}

/**
 * The slopes this window identifies, or null when it cannot.
 *
 * `gradeBalance` grades a window; it does not hand back the fit it used. So the slopes worth
 * holding are identified here from the same exported primitives and under the same step guard —
 * a frame captured across a current step is dropped because its sequential cell scan may not be
 * simultaneous with its current reading.
 */
function identifyResistances(samples: readonly BalanceSample[]): number[] | null {
  const last = samples[samples.length - 1]
  const cellCount = last?.deviationsMv.length ?? 0
  if (cellCount === 0) return null

  const steady = samples.filter(
    (sample, index) =>
      index > 0 &&
      sample.deviationsMv.length === cellCount &&
      Math.abs(sample.current - samples[index - 1].current) <= STEP_EXCLUSION_A,
  )
  if (steady.length === 0) return null

  const resistances: number[] = []
  for (let cell = 0; cell < cellCount; cell += 1) {
    const fit = theilSen(steady.map((sample) => [sample.current, sample.deviationsMv[cell]] as const))
    if (fit === null) return null
    resistances.push(fit.resistance)
  }
  return resistances
}

/** The pack-current span the fit had to work with, which is what makes a slope believable. */
function currentSwingOf(samples: readonly BalanceSample[]): number {
  if (samples.length === 0) return 0
  let low = samples[0].current
  let high = samples[0].current
  for (const sample of samples) {
    if (sample.current < low) low = sample.current
    if (sample.current > high) high = sample.current
  }
  return high - low
}

function largestMagnitudeOf(values: readonly number[]): number {
  let largest = 0
  for (const value of values) {
    const magnitude = Math.abs(value)
    if (magnitude > largest) largest = magnitude
  }
  return largest
}
