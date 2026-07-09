/**
 * The Victron encryption key lives in this browser's localStorage and nowhere else.
 * It is never sent anywhere: the page has no backend, and the whole site is static.
 */

const KEY_STORAGE = 'victron.advertisementKey'

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
