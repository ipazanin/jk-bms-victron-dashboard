/**
 * What this browser can actually do, so the UI can degrade honestly instead of
 * offering buttons that throw.
 *
 * GATT ships unflagged in Chromium. Advertisement scanning does not: it exists only on
 * Chrome for Android and macOS, behind chrome://flags/#enable-experimental-web-platform-features.
 * Firefox has no implementation at all and Mozilla's standards position is negative, so
 * no flag will ever help there. Safari ships nothing, which is why iOS needs Bluefy.
 *
 * `watchAdvertisements` sits behind that same flag, but unlike the scan it actually delivers on
 * macOS. So the two are separate probes and `canListenSolar` is the union: the honest answer to
 * "can this browser read the controller live by some route".
 */

export interface BleCapabilities {
  readonly hasBluetooth: boolean
  readonly secureContext: boolean
  readonly canConnect: boolean
  /** getDevices() exists, so a previously-permitted pack can be reconnected without the chooser. */
  readonly canReconnect: boolean
  readonly canScan: boolean
  /** A chooser-picked device can be watched for advertisements — the route that works on macOS. */
  readonly canWatchAdvertisements: boolean
  /**
   * The scan API exists here but is known never to deliver an advertisement, so a browser with
   * both routes should start on the watch. True on macOS, where Chrome resolves `requestLEScan`
   * and then stays silent forever.
   */
  readonly scanKnownSilent: boolean
  /** Either route exists, so the solar UI is worth offering at all. */
  readonly canListenSolar: boolean
  readonly hasSubtleCrypto: boolean
}

/**
 * `@types/web-bluetooth` declares the `BluetoothDevice` interface but no value of that name, so
 * the prototype has to be reached through `globalThis`.
 */
export function watchAdvertisementsSupported(): boolean {
  const deviceClass = (globalThis as { BluetoothDevice?: { prototype: object } }).BluetoothDevice
  return deviceClass !== undefined && 'watchAdvertisements' in deviceClass.prototype
}

/**
 * `userAgentData` is Chromium-only and absent from lib.dom, but Web Bluetooth only exists in
 * Chromium, so it is the honest probe here; the deprecated `navigator.platform` is the fallback
 * for older builds.
 */
function runsOnMacos(): boolean {
  if (typeof navigator === 'undefined') return false
  const agentPlatform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
  if (agentPlatform !== undefined) return agentPlatform === 'macOS'
  return navigator.platform.startsWith('Mac')
}

export function detectCapabilities(): BleCapabilities {
  const secureContext = typeof window !== 'undefined' && window.isSecureContext === true
  const bluetooth = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined
  const hasBluetooth = typeof bluetooth === 'object' && bluetooth !== null
  const canScan = hasBluetooth && typeof bluetooth!.requestLEScan === 'function'
  const canWatchAdvertisements =
    hasBluetooth && typeof bluetooth!.requestDevice === 'function' && watchAdvertisementsSupported()

  return {
    hasBluetooth,
    secureContext,
    canConnect: hasBluetooth && typeof bluetooth!.requestDevice === 'function',
    canReconnect: hasBluetooth && typeof bluetooth!.getDevices === 'function',
    canScan,
    canWatchAdvertisements,
    scanKnownSilent: canScan && runsOnMacos(),
    canListenSolar: canScan || canWatchAdvertisements,
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
