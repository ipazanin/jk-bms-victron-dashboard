/**
 * Daily energy, folded from the app's own recordings.
 *
 * The JK-BMS keeps no per-day energy history of its own — only the event logbook and lifetime
 * counters — so a daily view can only be built from what this browser recorded. Each session's
 * ledger is already the exact integral of its samples, cached on the row, so bucketing by local day
 * and summing costs one pass over the list and reads no chunk.
 *
 * A session that crosses local midnight is attributed whole to the day it began. Splitting it at the
 * boundary would mean re-integrating its chunks, and the ledger the recorder folded cannot be split
 * — only combined. The day a watch started is the honest, cheap answer, and the row says its span.
 */

import type { SessionRecord } from '../../domain/history/types'
import { sessionDurationMs } from './historyBrowser'

export interface DailyTotal {
  /** Local midnight of the day, in wall-clock milliseconds. */
  readonly day: number
  readonly sessions: number
  readonly recordedMs: number
  /** Net amp-hours through the pack across the day's counted windows. Signed; positive is charge. */
  readonly packAh: number
  /** Amp-hours the controller delivered. */
  readonly solarAh: number
  /** Watt-hours out to the boat: house = solar − pack, integrated. */
  readonly houseWh: number
  /** Floor on unmeasured charge across foreign windows, in amp-hours. */
  readonly foreignAhFloor: number
  /** Lowest state of charge the day reached, or null when no pack sample was counted. */
  readonly deepestSoc: number | null
  readonly pvPeakW: number | null
}

interface MutableDay {
  day: number
  sessions: number
  recordedMs: number
  packAh: number
  solarAh: number
  houseWh: number
  foreignAhFloor: number
  deepestSoc: number | null
  pvPeakW: number | null
}

export function startOfLocalDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Days newest first, each folding every session that began on it. */
export function dailyTotals(records: readonly SessionRecord[], now: number): DailyTotal[] {
  const byDay = new Map<number, MutableDay>()

  for (const record of records) {
    const day = startOfLocalDay(record.startedAt)
    const bucket =
      byDay.get(day) ??
      {
        day,
        sessions: 0,
        recordedMs: 0,
        packAh: 0,
        solarAh: 0,
        houseWh: 0,
        foreignAhFloor: 0,
        deepestSoc: null,
        pvPeakW: null,
      }

    const ledger = record.ledger
    bucket.sessions += 1
    bucket.recordedMs += sessionDurationMs(record, now)
    bucket.packAh += ledger.packAh
    bucket.solarAh += ledger.solarAh
    bucket.houseWh += ledger.houseWh
    bucket.foreignAhFloor += ledger.foreignAhFloor
    bucket.deepestSoc = lowerOf(bucket.deepestSoc, ledger.stateOfChargeMin)
    bucket.pvPeakW = higherOf(bucket.pvPeakW, ledger.pvPowerPeakW)

    byDay.set(day, bucket)
  }

  return [...byDay.values()].sort((left, right) => right.day - left.day)
}

function lowerOf(current: number | null, next: number | null): number | null {
  if (next === null) return current
  if (current === null) return next
  return Math.min(current, next)
}

function higherOf(current: number | null, next: number | null): number | null {
  if (next === null) return current
  if (current === null) return next
  return Math.max(current, next)
}
