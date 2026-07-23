/**
 * The last device logbook this browser read, kept so it can be reviewed off the boat.
 *
 * The events carry seconds-since-first-power-on, not wall clock, so the pack's uptime at the moment
 * of the read is stored beside them: boot ≈ fetched − uptime, and each event's real date follows.
 * When the uptime was not known, the reader falls back to elapsed time rather than inventing a date.
 */

import type { LogbookEvent } from '../domain/bms/logbook'

const STORAGE_KEY = 'shunt.logbook'

export interface StoredLogbook {
  readonly fetchedAt: number
  /** The pack's uptime in seconds when the log was read, or null if it was not yet known. */
  readonly uptimeSecondsAtFetch: number | null
  readonly events: readonly LogbookEvent[]
}

export function loadLogbook(): StoredLogbook | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<StoredLogbook>
    if (typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.events)) return null
    const events = parsed.events.filter(
      (event): event is LogbookEvent =>
        typeof event?.secondsSinceBoot === 'number' &&
        typeof event.code === 'number' &&
        typeof event.label === 'string',
    )
    return {
      fetchedAt: parsed.fetchedAt,
      uptimeSecondsAtFetch:
        typeof parsed.uptimeSecondsAtFetch === 'number' ? parsed.uptimeSecondsAtFetch : null,
      events,
    }
  } catch {
    return null
  }
}

export function saveLogbook(logbook: StoredLogbook): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(logbook))
  } catch {
    // Private browsing denies storage; the logbook simply will not persist.
  }
}

export function forgetLogbook(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to clear.
  }
}

/**
 * The wall-clock time of an event, or null when the boot instant is unknown. Boot is derived once
 * from the stored uptime; a null uptime means the reader shows elapsed-since-boot instead.
 */
export function eventWallTime(logbook: StoredLogbook, event: LogbookEvent): number | null {
  if (logbook.uptimeSecondsAtFetch === null) return null
  const bootAt = logbook.fetchedAt - logbook.uptimeSecondsAtFetch * 1000
  return bootAt + event.secondsSinceBoot * 1000
}
