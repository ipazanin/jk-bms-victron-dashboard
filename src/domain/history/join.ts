/**
 * Putting the two recorded streams back together on read, and thinning them to a drawable width.
 *
 * The radios are stored separately and deliberately. They are independent instruments on
 * independent clocks, and a single joined row would have to invent one of its halves every time
 * the other one spoke first — the invented half then looks exactly like a measurement forever
 * after. So the join happens here, against a bound that is written down: a reading stands in for
 * a neighbouring instant only while it is younger than the bound the caller passes. Past that the
 * half is null, and null is drawn as a hole. Nothing in this file carries a value forward to fill
 * one, and nothing infers a reading a radio did not send.
 *
 * The same refusal governs the timeline itself. A sample describes the instant it was taken, not
 * the span after it, so two rows further apart than MAX_SAMPLE_GAP_MS say nothing about what
 * happened between them: no trace, no integral and no coverage run crosses that span.
 *
 * Whether a paired row's house figure is *plausible* is not decided here. The noise floor that
 * separates a real house load from an unmeasured charger belongs to dcBus, and a second copy of it
 * would let the archive and the live instrument withhold on different rules.
 */

import { reachOf } from '../reach'
import type { Reach, Sample } from '../reach'
import type { PackSample, SolarSample, TimeWindow } from './types'

/**
 * Milliseconds. Both streams are gated to one row a second, so a healthy pairing is a fraction of
 * a second old; three intervals absorb Bluetooth jitter and a missed advertisement without letting
 * a stale reading stand in for a live one. This is deliberately far tighter than the scanner's own
 * fifteen-second demotion: that is how long a link stays worth watching, whereas a value held here
 * becomes integrated charge in the ledger.
 */
export const MAX_PAIRING_AGE_MS = 3_000

/**
 * Milliseconds. Longer than the BMS's own stall timeout, which is the shorter of the two links'
 * patience — a stream silent for this long is not jittering, it has stopped reporting. The span
 * between two rows this far apart is unknown, and is drawn and integrated as unknown.
 */
export const MAX_SAMPLE_GAP_MS = 8_000

/**
 * One instant on the merged timeline. Either half is null when that radio said nothing recent
 * enough to speak for this instant.
 */
export interface PairedSample {
  readonly at: number
  readonly pack: PackSample | null
  readonly solar: SolarSample | null
}

/** One downsampled stream: a reach per column, plus the spans it is not entitled to draw across. */
export interface Track {
  /** One entry per column, in order. Null where this stream put no sample in that column. */
  readonly columns: readonly (Reach | null)[]
  /** Spans where the stream reported nothing for longer than the gap bound. Never bridged. */
  readonly gaps: readonly TimeWindow[]
}

export interface Tracks {
  readonly window: TimeWindow
  /** Column i spans window.from + i·columnMs to window.from + (i + 1)·columnMs. */
  readonly columnMs: number
  readonly pack: Track
  readonly solar: Track
  /**
   * The reach of the per-sample difference. Differencing the pack and solar bands instead would
   * describe a house load no sample ever carried, and it goes wrong hardest exactly where the
   * load was spikiest — which is the part of the day worth looking at.
   */
  readonly house: Track
}

/**
 * Merges two ascending streams onto one timeline: one row per instant either radio reported, each
 * row carrying the other radio's most recent reading while that reading is inside the bound.
 *
 * Both inputs must be ascending in `at`. Duplicate stamps within one stream collapse to the last
 * of them, which is what a re-checkpointed tail produces.
 */
export function pairSamples(
  pack: readonly PackSample[],
  solar: readonly SolarSample[],
  maxPairingAgeMs: number,
): readonly PairedSample[] {
  const paired: PairedSample[] = []
  let packIndex = 0
  let solarIndex = 0
  let heldPack: PackSample | null = null
  let heldSolar: SolarSample | null = null

  while (packIndex < pack.length || solarIndex < solar.length) {
    const nextPackAt = packIndex < pack.length ? pack[packIndex].at : Number.POSITIVE_INFINITY
    const nextSolarAt = solarIndex < solar.length ? solar[solarIndex].at : Number.POSITIVE_INFINITY
    const at = Math.min(nextPackAt, nextSolarAt)

    while (packIndex < pack.length && pack[packIndex].at === at) {
      heldPack = pack[packIndex]
      packIndex += 1
    }
    while (solarIndex < solar.length && solar[solarIndex].at === at) {
      heldSolar = solar[solarIndex]
      solarIndex += 1
    }

    paired.push({
      at,
      pack: heldPack !== null && at - heldPack.at <= maxPairingAgeMs ? heldPack : null,
      solar: heldSolar !== null && at - heldSolar.at <= maxPairingAgeMs ? heldSolar : null,
    })
  }

  return paired
}

/**
 * Buckets an ascending run of paired samples into a fixed number of columns.
 *
 * Each column keeps the full reach of what fell inside it rather than one representative value:
 * at four hundred columns a twelve-hour session puts a hundred-odd samples in every column, and a
 * single-sample current spike is the thing most worth not losing. The trace is drawn through the
 * reach's time-weighted `net` and the band through `low` and `high`, so a quiet hour reads as a
 * line and a busy one reads as a ribbon.
 */
export function deriveTracks(
  samples: readonly PairedSample[],
  window: TimeWindow,
  columns: number,
): Tracks {
  const columnCount = Math.max(1, Math.floor(columns))
  const span = window.to - window.from
  const columnMs = span > 0 ? span / columnCount : 0

  const pack = emptyFold(columnCount)
  const solar = emptyFold(columnCount)
  const house = emptyFold(columnCount)

  if (columnMs > 0) {
    for (const sample of samples) {
      if (sample.at < window.from || sample.at > window.to) continue
      const column = Math.min(columnCount - 1, Math.floor((sample.at - window.from) / columnMs))
      const packCurrent = sample.pack === null ? null : sample.pack.currentA
      const solarCurrent = solarCurrentOf(sample)

      if (packCurrent !== null) record(pack, column, sample.at, packCurrent)
      if (solarCurrent !== null) record(solar, column, sample.at, solarCurrent)
      if (packCurrent !== null && solarCurrent !== null) {
        record(house, column, sample.at, solarCurrent - packCurrent)
      }
    }
  }

  return {
    window,
    columnMs,
    pack: sealTrack(pack, window),
    solar: sealTrack(solar, window),
    house: sealTrack(house, window),
  }
}

/** Amps the controller delivered, or null when the advertisement carried no battery current. */
export function solarCurrentOf(sample: PairedSample): number | null {
  return sample.solar === null ? null : sample.solar.batteryCurrentA
}

interface TrackFold {
  readonly columns: Sample[][]
  readonly instants: number[]
}

function emptyFold(columnCount: number): TrackFold {
  return { columns: Array.from({ length: columnCount }, () => []), instants: [] }
}

function record(fold: TrackFold, column: number, at: number, value: number): void {
  fold.columns[column].push({ at, value })
  fold.instants.push(at)
}

function sealTrack(fold: TrackFold, window: TimeWindow): Track {
  return { columns: fold.columns.map(reachOf), gaps: gapsOf(fold.instants, window) }
}

/**
 * The window's edges count as boundaries, so a stream that fell silent before the window ended
 * carries its silence to the end rather than trailing off into an unmarked flat line, and a stream
 * that never reported at all is one gap the width of the window.
 */
function gapsOf(instants: readonly number[], window: TimeWindow): TimeWindow[] {
  const gaps: TimeWindow[] = []
  let previous = window.from
  for (const at of instants) {
    if (at - previous > MAX_SAMPLE_GAP_MS) gaps.push({ from: previous, to: at })
    previous = at
  }
  if (window.to - previous > MAX_SAMPLE_GAP_MS) gaps.push({ from: previous, to: window.to })
  return gaps
}
