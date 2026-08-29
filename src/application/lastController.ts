/**
 * The Victron controller this browser last watched, remembered so the next visit can put the watch
 * back up without the chooser. Only the opaque Web Bluetooth id and the advertised name are kept —
 * both are already origin-scoped and local, and the id means nothing to any other site or to the
 * controller itself.
 *
 * It is the pack's `lastDevice` for the other radio, and it is remembered for the same reason:
 * `watchAdvertisements` needs no user gesture on a device this origin already has permission for,
 * so an id is the whole difference between a solar link that costs a chooser tap on every page load
 * and one that comes up by itself.
 *
 * The encryption key is not in here and must never be. It lives where it always has, in
 * `storage.ts`, and this record is only ever about which handle to ask for.
 */

import { storageKey } from './storageKey'

const STORAGE_KEY = 'shunt.lastSolarController'

export interface LastController {
  readonly id: string
  readonly name: string | null
  readonly at: number
}

export function loadLastController(): LastController | null {
  try {
    const raw = localStorage.getItem(storageKey(STORAGE_KEY))
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<LastController>
    if (typeof parsed.id !== 'string' || parsed.id === '') return null
    return {
      id: parsed.id,
      name: typeof parsed.name === 'string' ? parsed.name : null,
      at: typeof parsed.at === 'number' ? parsed.at : 0,
    }
  } catch {
    return null
  }
}

export function saveLastController(id: string, name: string | null, at: number): void {
  if (id === '') return
  try {
    localStorage.setItem(storageKey(STORAGE_KEY), JSON.stringify({ id, name, at }))
  } catch {
    // Private browsing denies storage; the controller simply will not be remembered.
  }
}

export function forgetLastController(): void {
  try {
    localStorage.removeItem(storageKey(STORAGE_KEY))
  } catch {
    // Nothing to clear.
  }
}
