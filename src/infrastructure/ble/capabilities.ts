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
 * macOS. So the two are separate probes, and `canListenSolar` is their union narrowed by the
 * platform: the honest answer to "can this browser read the controller live by some route".
 *
 * The platform is part of that answer because feature detection cannot see the whole of it. On
 * Linux both APIs are present, both resolve, and neither ever fires — so a page trusting detection
 * alone would offer the solar controls on the one desktop where they can never work.
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
   * Whether this platform's browser ever hands an advertisement to a page at all.
   *
   * False on Linux and nowhere else. BlueZ reports advertisement data through a four-argument
   * raw-EIR overload that `WebBluetoothServiceImpl` does not implement, so the observer never
   * fires: neither route delivers, and no flag, permission or amount of range changes it. Both
   * APIs are still present there, which is exactly why this has to be asked separately — feature
   * detection alone would offer a controller that can never be read.
   */
  readonly platformDeliversAdvertisements: boolean
  /** A route exists and this platform delivers on it, so the solar UI is worth offering at all. */
  readonly canListenSolar: boolean
  readonly hasSubtleCrypto: boolean
}

/**
 * What the browser can do and whether its radio is on, as one dependency rather than two direct
 * reads of `navigator`. The pair decides every disabled button and every requirements row, and
 * taking them as a port is the only way a caller can stand in for a browser it is not running in.
 */
export interface BleEnvironment {
  readonly capabilities: BleCapabilities
  /** Reports availability once straight away, then on every toggle. Returns an unsubscribe. */
  watchAdapter(onChange: (available: boolean | null) => void): () => void
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
 * Which host this is, to the extent the answer changes what solar can do here.
 *
 * One platform is named because only one behaves differently: Linux delivers nothing by either
 * route, ever. Every other host — Windows, macOS, ChromeOS, Android — is one answer, implemented,
 * and nothing here claims more than that.
 *
 * `userAgentData` is Chromium-only and absent from lib.dom, but Web Bluetooth only exists in
 * Chromium, so it is the honest probe; the deprecated `navigator.platform` is the fallback for
 * builds without it. The fallback has to work harder, because `navigator.platform` reports
 * "Linux armv8l" on Android and "Linux x86_64" on ChromeOS, where advertisements do arrive — so the
 * word Linux is only believed once the user agent has ruled both of those out.
 */
type HostPlatform = 'linux' | 'elsewhere'

function hostPlatform(): HostPlatform {
  if (typeof navigator === 'undefined') return 'elsewhere'
  const reported = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
  if (reported !== undefined) return reported === 'Linux' ? 'linux' : 'elsewhere'
  const platform = navigator.platform ?? ''
  if (platform.startsWith('Linux') && !/Android|CrOS/.test(navigator.userAgent ?? '')) return 'linux'
  return 'elsewhere'
}

export function detectCapabilities(): BleCapabilities {
  const secureContext = typeof window !== 'undefined' && window.isSecureContext === true
  const bluetooth = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined
  const hasBluetooth = typeof bluetooth === 'object' && bluetooth !== null
  const canScan = hasBluetooth && typeof bluetooth!.requestLEScan === 'function'
  const canWatchAdvertisements =
    hasBluetooth && typeof bluetooth!.requestDevice === 'function' && watchAdvertisementsSupported()
  const platformDeliversAdvertisements = hostPlatform() !== 'linux'

  return {
    hasBluetooth,
    secureContext,
    canConnect: hasBluetooth && typeof bluetooth!.requestDevice === 'function',
    canReconnect: hasBluetooth && typeof bluetooth!.getDevices === 'function',
    canScan,
    canWatchAdvertisements,
    platformDeliversAdvertisements,
    canListenSolar: platformDeliversAdvertisements && (canScan || canWatchAdvertisements),
    hasSubtleCrypto: typeof globalThis.crypto?.subtle?.decrypt === 'function',
  }
}

/**
 * Whether the radio is switched on. Null means the browser won't say — it takes the radio it was
 * handed rather than reading `navigator` again, so the caller's guard is the only one needed.
 */
async function adapterAvailable(bluetooth: Bluetooth): Promise<boolean | null> {
  if (typeof bluetooth.getAvailability !== 'function') return null
  try {
    return await bluetooth.getAvailability()
  } catch {
    return null
  }
}

/**
 * Reports availability at once and re-reads it whenever the user toggles the radio. Returns an
 * unsubscribe.
 *
 * A browser with no Bluetooth at all is never reported on, not reported as off: the caller's
 * tri-state stays unknown, so the UI can say this browser will not answer instead of blaming a
 * radio that was never there.
 */
function watchAdapter(onChange: (available: boolean | null) => void): () => void {
  const bluetooth = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined
  if (!bluetooth) return () => undefined

  const reportAvailability = (): void => {
    void adapterAvailable(bluetooth).then(onChange)
  }
  reportAvailability()
  if (typeof bluetooth.addEventListener !== 'function') return () => undefined

  bluetooth.addEventListener('availabilitychanged', reportAvailability)
  return () => bluetooth.removeEventListener('availabilitychanged', reportAvailability)
}

/** The environment as this browser really is. */
export function browserBleEnvironment(): BleEnvironment {
  return { capabilities: detectCapabilities(), watchAdapter }
}
