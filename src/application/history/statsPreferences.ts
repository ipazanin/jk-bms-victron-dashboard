import type { DeviceKey, TimeWindow } from '../../domain/history/types'
import { storageKey } from '../storageKey'
import type { RangeKind } from './statsRange'

const STORAGE_KEY = 'shunt.statsPreferences'

export interface StatsPreferences {
  readonly range: RangeKind
  readonly custom: TimeWindow | null
  readonly pack: DeviceKey | null
}

export function loadStatsPreferences(): StatsPreferences {
  const defaults: StatsPreferences = { range: 'week', custom: null, pack: null }
  try {
    const raw = localStorage.getItem(storageKey(STORAGE_KEY))
    if (raw === null) return defaults
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1) {
      return defaults
    }
    const stored = parsed as Record<string, unknown>
    const custom = readCustomWindow(stored.custom)
    return {
      range:
        isRangeKind(stored.range) && (stored.range !== 'custom' || custom !== null)
          ? stored.range
          : 'week',
      custom,
      pack: typeof stored.pack === 'string' && stored.pack.length > 0 ? stored.pack : null,
    }
  } catch {
    return defaults
  }
}

export function saveStatsPreferences(preferences: StatsPreferences): void {
  try {
    localStorage.setItem(storageKey(STORAGE_KEY), JSON.stringify({ version: 1, ...preferences }))
  } catch {
    // Browsing the archive remains available when the browser refuses preference storage.
  }
}

function isRangeKind(range: unknown): range is RangeKind {
  return (
    range === 'day' || range === 'week' || range === 'month' || range === 'all' || range === 'custom'
  )
}

function readCustomWindow(custom: unknown): TimeWindow | null {
  if (typeof custom !== 'object' || custom === null || !('from' in custom) || !('to' in custom)) {
    return null
  }
  return isDate(custom.from) && isDate(custom.to) ? { from: custom.from, to: custom.to } : null
}

function isDate(timestamp: unknown): timestamp is number {
  return typeof timestamp === 'number' && Number.isFinite(new Date(timestamp).getTime())
}
