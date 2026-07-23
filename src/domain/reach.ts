/**
 * A trailing window over raw samples, and the reach — lowest, highest and latest — across it.
 *
 * The instruments need two different things from the same signal. A bar wants the latest sample,
 * because that is the measurement. A scale, a band or a projection wants the recent envelope,
 * because a quantity that swings through zero every two seconds cannot be described by whichever
 * instant happened to arrive last.
 *
 * Both edges of a reach are samples a radio actually reported. Nothing here averages a value that
 * is then presented as a reading: `net` is a rate and is only ever consumed as one.
 */

export interface Sample {
  readonly at: number
  readonly value: number
}

export interface Reach {
  readonly low: number
  readonly high: number
  readonly latest: number
  /** Time-weighted mean over the window. A rate — never presented as a reading. */
  readonly net: number
  readonly count: number
  readonly spanMs: number
}

export function reachOf(samples: readonly Sample[]): Reach | null {
  if (samples.length === 0) return null

  let low = samples[0].value
  let high = samples[0].value
  for (const sample of samples) {
    if (sample.value < low) low = sample.value
    if (sample.value > high) high = sample.value
  }

  const first = samples[0]
  const last = samples[samples.length - 1]
  return {
    low,
    high,
    latest: last.value,
    net: netRate(samples),
    count: samples.length,
    spanMs: last.at - first.at,
  }
}

/**
 * Trapezoid rule. For anything that accumulates — a time to full, an amp-hour — this is the
 * correct rate rather than a calmer instant: a load swinging plus and minus five amps moves
 * almost no net charge, however loud any single sample looks.
 */
function netRate(samples: readonly Sample[]): number {
  const last = samples[samples.length - 1]
  const duration = last.at - samples[0].at
  if (duration <= 0) return last.value

  let area = 0
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const current = samples[index]
    area += ((previous.value + current.value) / 2) * (current.at - previous.at)
  }
  return area / duration
}

/**
 * A bounded window aged against the wall clock rather than against the newest sample.
 *
 * Ageing on read is what stops a band standing as a claim about "the last 30 seconds" over frames
 * that are minutes old: when the link goes quiet the window empties and `read` returns null,
 * which is the same refusal VictronScanner makes when advertisements stop arriving.
 */
export class TrailingWindow {
  private samples: Sample[] = []
  private readonly windowMs: number

  constructor(windowMs: number) {
    this.windowMs = windowMs
  }

  observe(at: number, value: number): void {
    // A non-finite reading is an absent one. Admitting it would poison low, high and net at once.
    if (!Number.isFinite(value)) return
    this.samples.push({ at, value })
    this.prune(at)
  }

  read(now: number): Reach | null {
    this.prune(now)
    return reachOf(this.samples)
  }

  clear(): void {
    this.samples = []
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    let first = 0
    while (first < this.samples.length && this.samples[first].at < cutoff) first += 1
    if (first > 0) this.samples = this.samples.slice(first)
  }
}
