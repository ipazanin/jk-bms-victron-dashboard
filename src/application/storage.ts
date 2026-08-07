/**
 * The Victron encryption key lives in this browser's localStorage and nowhere else.
 * It is never sent anywhere: the page has no backend, and the whole site is static.
 *
 * Alongside it sits the route this browser reads the controller by, because a scan that finds
 * nothing only reveals itself fifteen seconds after the press, long past the activation that could
 * have raised a chooser. Remembering the verdict is what lets the next press take the other route.
 */

import type { SolarLiveTransport } from '../infrastructure/ble/solarScan'

const KEY_STORAGE = 'victron.advertisementKey'
const TRANSPORT_STORAGE = 'victron.liveTransport'

export function loadAdvertisementKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? ''
  } catch {
    return ''
  }
}

export function saveAdvertisementKey(key: string): void {
  try {
    localStorage.setItem(KEY_STORAGE, key.trim().toLowerCase())
  } catch {
    // Private browsing denies storage; the key simply will not persist.
  }
}

export function forgetAdvertisementKey(): void {
  try {
    localStorage.removeItem(KEY_STORAGE)
  } catch {
    // Nothing to clear.
  }
}

/** The remembered verdict, or null when this browser has not proven a transport yet. */
export function loadSolarLiveTransport(): SolarLiveTransport | null {
  try {
    const stored = localStorage.getItem(TRANSPORT_STORAGE)
    return stored === 'watch' || stored === 'scan' ? stored : null
  } catch {
    return null
  }
}

export function saveSolarLiveTransport(transport: SolarLiveTransport): void {
  try {
    localStorage.setItem(TRANSPORT_STORAGE, transport)
  } catch {
    // Private browsing denies storage; the verdict simply will not persist.
  }
}
