/**
 * What this browser can actually do, so the UI can degrade honestly instead of
 * offering buttons that throw.
 *
 * GATT ships unflagged in Chromium. Advertisement scanning does not: it exists only on
 * Chrome for Android and macOS, behind chrome://flags/#enable-experimental-web-platform-features.
 * Firefox has no implementation at all and Mozilla's standards position is negative, so
 * no flag will ever help there. Safari ships nothing, which is why iOS needs Bluefy.
 */

export interface BleCapabilities {
  readonly hasBluetooth: boolean
  readonly secureContext: boolean
  readonly canConnect: boolean
  /** getDevices() exists, so a previously-permitted pack can be reconnected without the chooser. */
  readonly canReconnect: boolean
  readonly canScan: boolean
  readonly hasSubtleCrypto: boolean
}

export function detectCapabilities(): BleCapabilities {
  const secureContext = typeof window !== 'undefined' && window.isSecureContext === true
  const bluetooth = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined
  const hasBluetooth = typeof bluetooth === 'object' && bluetooth !== null

  return {
    hasBluetooth,
    secureContext,
    canConnect: hasBluetooth && typeof bluetooth!.requestDevice === 'function',
    canReconnect: hasBluetooth && typeof bluetooth!.getDevices === 'function',
    canScan: hasBluetooth && typeof bluetooth!.requestLEScan === 'function',
    hasSubtleCrypto: typeof globalThis.crypto?.subtle?.decrypt === 'function',
  }
}

/** Whether a Bluetooth radio exists and is switched on. Null means the browser won't say. */
export async function adapterAvailable(): Promise<boolean | null> {
  const bluetooth = navigator.bluetooth
  if (!bluetooth) return false
  if (typeof bluetooth.getAvailability !== 'function') return null
  try {
    return await bluetooth.getAvailability()
  } catch {
    return null
  }
}

/** Re-reads availability whenever the user toggles the radio. Returns an unsubscribe. */
export function watchAdapter(onChange: (available: boolean | null) => void): () => void {
  const bluetooth = navigator.bluetooth
  if (!bluetooth || typeof bluetooth.addEventListener !== 'function') return () => undefined

  const handler = (): void => {
    void adapterAvailable().then(onChange)
  }
  bluetooth.addEventListener('availabilitychanged', handler)
  return () => bluetooth.removeEventListener('availabilitychanged', handler)
}
