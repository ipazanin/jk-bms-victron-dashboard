/**
 * The Victron encryption key lives in this browser's localStorage and nowhere else.
 * It is never sent anywhere: the page has no backend, and the whole site is static.
 */

import { storageKey } from './storageKey'

const KEY_STORAGE = 'victron.advertisementKey'

/**
 * The name a browser once recorded which radio route it read the controller by under. The route is
 * decided from what the browser can do now, so anything left here is read by nothing — but it was
 * shipped, so a browser that has run this page before is still holding one.
 */
const SUPERSEDED_TRANSPORT_STORAGE = 'victron.liveTransport'

export function loadAdvertisementKey(): string {
  try {
    return localStorage.getItem(storageKey(KEY_STORAGE)) ?? ''
  } catch {
    return ''
  }
}

export function saveAdvertisementKey(key: string): void {
  try {
    localStorage.setItem(storageKey(KEY_STORAGE), key.trim().toLowerCase())
  } catch {
    // Private browsing denies storage; the key simply will not persist.
  }
}

export function forgetAdvertisementKey(): void {
  try {
    localStorage.removeItem(storageKey(KEY_STORAGE))
  } catch {
    // Nothing to clear.
  }
}

/**
 * Drops the entry no code reads any more. Called once as the page comes up rather than from
 * anything that runs per reading, so the removal costs one call however long the page is left open.
 */
export function forgetSupersededSolarLiveTransport(): void {
  try {
    localStorage.removeItem(storageKey(SUPERSEDED_TRANSPORT_STORAGE))
  } catch {
    // Private browsing denies storage; there was nothing there to clear either.
  }
}
