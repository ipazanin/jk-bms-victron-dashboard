/**
 * Telling cell imbalance apart from cell wiring.
 *
 * A large spread between the highest and lowest cell has more than one cause, and only one of
 * them is imbalance:
 *
 *   - State-of-charge divergence. Cells holding different charge at the same terminal voltage.
 *     Constant with current. This is what imbalance means, and the only part a balancer can fix.
 *   - Path resistance. Each cell's internal plus busbar plus lead resistance differs, so under
 *     current its terminal moves by I·ΔR against the pack mean. Proportional to current, gone at
 *     rest, and no balancer touches it. A cell reading −7 mV at rest and −13 mV at −5 A is
 *     carrying 1.2 mΩ more than its neighbours; that is a terminal to check, not a cell to
 *     balance.
 *
 * Comparing the raw spread against a fixed threshold cannot distinguish them, so on a bus whose
 * load cycles it alarms on wiring and calls it imbalance. Fitting each cell's deviation against
 * pack current separates the two directly: the intercept is the load-independent offset in
 * millivolts, and the slope is millivolts per amp, which is milliohms.
 *
 * Note that `BatterySnapshot.cellResistances` is NOT the resistance in this formula. The BMS
 * measures that through its balance leads at milliamps, and reports tens of milliohms; series
 * resistance that large would move every terminal by hundreds of millivolts under load, which no
 * captured frame shows. A correction built on that field would be wrong by roughly fifty times
 * and would fail silently.
 */

/** One definition of deviation from the mean, so the ladder and the alarm cannot drift apart. */
export function deviationsMv(cellVoltages: readonly number[]): number[] {
  if (cellVoltages.length === 0) return []
  const mean = cellVoltages.reduce((total, value) => total + value, 0) / cellVoltages.length
  return cellVoltages.map((voltage) => (voltage - mean) * 1000)
}

/**
 * Amps. The BMS reports one pack-current field alongside a sequential per-cell ADC scan taken
 * over the same frame. When the load steps part-way through that scan, cells read before the step
 * are compared against cells read after it, and the common-mode step lands in the spread as if it
 * were divergence.
 *
 * Whether any given step lands mid-scan is not observable from outside, so this is a conservative
 * guard rather than a diagnosis: frames captured across a step are dropped because they *may* be
 * skewed, not because they are known to be. In the recorded timeline the largest steps mostly
 * carry an ordinary spread, so exclusion costs a little data and assumes nothing.
 */
export const STEP_EXCLUSION_A = 1.0

/** Amps. A pair closer together than this yields a slope with unusable leverage; it is skipped. */
export const MIN_PAIR_SEPARATION_A = 2.0

/** Fewer surviving pairs than this and the slope is not identified, so none is claimed. */
export const MIN_PAIRS = 12

/** Ohms. Beyond build variation for a 4S pack with busbars — worth checking terminal torque. */
export const JOINT_WARNING = 0.003

/** Ohms. Tens of watts at one connection, at the currents this pack actually sees. */
export const JOINT_SERIOUS = 0.006

/** A fitted slope describes the wiring, which changes over hours rather than seconds. */
export const SLOPE_HOLD_MS = 6 * 3_600_000

export interface BalanceSample {
  readonly at: number
  readonly current: number
  readonly deviationsMv: readonly number[]
  /** Volts, straight from the snapshot. Only used for the uncorrected fallback. */
  readonly cellDelta: number
}

export interface CellFit {
  /** Millivolts. Load-independent offset — the balancer's quantity. */
  readonly offsetMv: number
  /** Ohms. Path resistance relative to the pack mean — the terminal's quantity. */
  readonly resistance: number
}

export type BalanceVerdict =
  | {
      readonly kind: 'fitted'
      /** Millivolts of genuine state-of-charge divergence, with the load term removed. */
      readonly balanceSpreadMv: number
      /** Ohms between the best- and worst-connected cell. */
      readonly jointSpread: number
      /** One-based, for display. */
      readonly worstJointCell: number
      readonly lowestOffsetCell: number
      readonly pairs: number
      readonly at: number
    }
  | {
      /** The load has not varied enough to identify a slope, and none is held. */
      readonly kind: 'uncorrected'
      readonly rawSpreadMv: number
      readonly current: number
    }

/**
 * Theil–Sen: the median of pairwise slopes, then the median residual as the intercept.
 *
 * Least squares would be wrong here. A skewed frame that survives the step filter is a genuine
 * outlier, and a mean of slopes lets one of them drag the intercept and manufacture a divergence
 * that is not there. Taking the median selects a slope the pack actually exhibited between two
 * frames rather than averaging across measurements.
 */
export function theilSen(
  points: readonly (readonly [current: number, deviationMv: number])[],
): (CellFit & { readonly pairs: number }) | null {
  const slopes: number[] = []
  for (let earlier = 0; earlier < points.length; earlier += 1) {
    for (let later = earlier + 1; later < points.length; later += 1) {
      const currentSpan = points[later][0] - points[earlier][0]
      if (Math.abs(currentSpan) < MIN_PAIR_SEPARATION_A) continue
      slopes.push((points[later][1] - points[earlier][1]) / currentSpan)
    }
  }
  if (slopes.length < MIN_PAIRS) return null

  const slopeMvPerAmp = median(slopes)
  const offsetMv = median(points.map(([current, deviation]) => deviation - slopeMvPerAmp * current))
  // Millivolts per amp is milliohms; the thresholds above are in ohms, so convert once, here.
  return { offsetMv, resistance: slopeMvPerAmp / 1000, pairs: slopes.length }
}

/**
 * Grades a pack from a window of samples.
 *
 * `heldResistances` are slopes from the last identified fit, still describing the installation
 * for SLOPE_HOLD_MS. When the present window cannot identify a slope — a boat under a dead-steady
 * load — those held slopes still correct the offsets. Only when nothing has ever been identified
 * does the verdict fall back to 'uncorrected', and the caller then compares the raw spread
 * exactly as it would have without any of this.
 *
 * That fallback direction is the point. An alarm that goes quiet when it cannot measure is worse
 * than a crude one; this degrades to the crude answer and never to silence.
 */
export function gradeBalance(
  samples: readonly BalanceSample[],
  heldResistances: readonly number[] | null,
): BalanceVerdict {
  const last = samples[samples.length - 1]
  const cellCount = last?.deviationsMv.length ?? 0
  if (!last || cellCount === 0) {
    return { kind: 'uncorrected', rawSpreadMv: 0, current: last?.current ?? 0 }
  }

  const uncorrected: BalanceVerdict = {
    kind: 'uncorrected',
    rawSpreadMv: last.cellDelta * 1000,
    current: last.current,
  }

  const steady = samples.filter(
    (sample, index) =>
      index > 0 &&
      sample.deviationsMv.length === cellCount &&
      Math.abs(sample.current - samples[index - 1].current) <= STEP_EXCLUSION_A,
  )
  if (steady.length === 0) return uncorrected

  const fits: (CellFit & { pairs: number })[] = []
  for (let cell = 0; cell < cellCount; cell += 1) {
    const fit = theilSen(steady.map((sample) => [sample.current, sample.deviationsMv[cell]] as const))
    // Every cell sees the same current series, so the pair count is identical across cells:
    // either the window is conditioned enough for all of them or for none.
    if (!fit) break
    fits.push(fit)
  }

  const identified = fits.length === cellCount
  const resistances = identified ? fits.map((fit) => fit.resistance) : heldResistances
  if (!resistances || resistances.length !== cellCount) return uncorrected

  const offsets: number[] = []
  for (let cell = 0; cell < cellCount; cell += 1) {
    offsets.push(
      median(
        steady.map((sample) => sample.deviationsMv[cell] - resistances[cell] * 1000 * sample.current),
      ),
    )
  }

  const worstJoint = resistances.reduce(
    (best, value, index) => (value > resistances[best] ? index : best),
    0,
  )
  const lowestOffset = offsets.reduce((best, value, index) => (value < offsets[best] ? index : best), 0)

  return {
    kind: 'fitted',
    balanceSpreadMv: Math.max(...offsets) - Math.min(...offsets),
    jointSpread: Math.max(...resistances) - Math.min(...resistances),
    worstJointCell: worstJoint + 1,
    lowestOffsetCell: lowestOffset + 1,
    pairs: identified ? fits[0].pairs : 0,
    at: last.at,
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
