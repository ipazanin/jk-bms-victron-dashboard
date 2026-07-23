/**
 * The last BMS this browser connected to, remembered so the next visit can reconnect without the
 * chooser. Only the opaque Web Bluetooth id and the advertised name are kept — both are already
 * origin-scoped and local, and the id means nothing to any other site or to the device itself.
 *
 * This is not a `BluetoothDevice`: a handle cannot survive a reload, and the id is all the reconnect
 * path needs to find the device again in `navigator.bluetooth.getDevices()`.
 */

const STORAGE_KEY = 'shunt.lastBmsDevice'

export interface LastDevice {
  readonly id: string
  readonly name: string | null
  readonly at: number
}

export function loadLastDevice(): LastDevice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<LastDevice>
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

export function saveLastDevice(id: string, name: string | null, at: number): void {
  if (id === '') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, name, at }))
  } catch {
    // Private browsing denies storage; the device simply will not be remembered.
  }
}

export function forgetLastDevice(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to clear.
  }
}
