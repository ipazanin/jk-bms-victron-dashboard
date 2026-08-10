/**
 * What the app is told this browser can do, and whether it is told the radio is on.
 *
 * Every disabled button, every requirements row and two whole halves of the Connect page are
 * decided by these nine booleans and one tri-state, and on a real machine most of them are facts
 * about the machine: a browser without the experimental flag reports no scan whatever is running
 * inside it. So the fake forces the seven that describe a Bluetooth radio and leaves the two that
 * describe the host — a secure context and a crypto implementation — as they really are.
 *
 * The overrides are kept as a partial of the real capability type rather than as a shorter profile
 * of the interesting flags. All nine stay reachable for free that way, including the three that a
 * fake radio makes inert, which is what stops a later reader adding a second control for one of
 * them.
 *
 * They are persisted because they cannot be applied in place: the capability set is read once when
 * telemetry is built and handed to the templates as a plain object, so a change that rewrote it
 * would show a page claiming something the running app is not doing. It survives the reload
 * instead, and the reload is what applies it. The adapter is the exception and is pushed live,
 * because that is what it is on real hardware too.
 */

import { detectCapabilities } from '../capabilities'
import type { BleCapabilities, BleEnvironment } from '../capabilities'

/** Only a build serving playback radios ever reads this, so the key carries no shared name. */
const OVERRIDE_STORAGE = 'shunt.fakeBleCapabilities'

/**
 * What a browser reports when every route to a Bluetooth device works. `scanKnownSilent` is false
 * among them deliberately: it says the scan resolves and then delivers nothing, which is a
 * statement about a platform and not a capability to hold on.
 */
const EVERY_ROUTE_WORKS: Partial<BleCapabilities> = {
  hasBluetooth: true,
  canConnect: true,
  canReconnect: true,
  canScan: true,
  canWatchAdvertisements: true,
  scanKnownSilent: false,
  canListenSolar: true,
}

const CAPABILITY_NAMES: readonly (keyof BleCapabilities)[] = [
  'hasBluetooth',
  'secureContext',
  'canConnect',
  'canReconnect',
  'canScan',
  'canWatchAdvertisements',
  'scanKnownSilent',
  'canListenSolar',
  'hasSubtleCrypto',
]

/**
 * Read one member at a time rather than trusted whole. The stored text outlives the build that
 * wrote it, and a member that has since been renamed would otherwise arrive as an extra key that
 * the spread quietly puts back into a capability set nothing reads.
 */
function storedOverrides(): Partial<BleCapabilities> {
  try {
    const raw = localStorage.getItem(OVERRIDE_STORAGE)
    if (raw === null) return {}
    const claimed = JSON.parse(raw) as Record<string, unknown>
    if (typeof claimed !== 'object' || claimed === null) return {}

    const overrides: { -readonly [Name in keyof BleCapabilities]?: boolean } = {}
    for (const name of CAPABILITY_NAMES) {
      const value = claimed[name]
      if (typeof value === 'boolean') overrides[name] = value
    }
    return overrides
  } catch {
    return {}
  }
}

export class FakeBleEnvironment implements BleEnvironment {
  readonly capabilities: BleCapabilities
  private overridden: Partial<BleCapabilities>
  private adapter: boolean | null = true
  private readonly listeners = new Set<(available: boolean | null) => void>()

  constructor() {
    this.overridden = storedOverrides()
    this.capabilities = { ...detectCapabilities(), ...EVERY_ROUTE_WORKS, ...this.overridden }
  }

  /** What the next load will report. Not what the running app is using — that is `capabilities`. */
  get overrides(): Partial<BleCapabilities> {
    return this.overridden
  }

  /**
   * A browser with no Bluetooth at all is never reported on, not reported as off: the caller's
   * tri-state stays unknown, so the UI can say this browser will not answer instead of blaming a
   * radio that was never there. That is the real environment's rule, and it is the one state the
   * live tri-state reaches only by coincidence.
   */
  watchAdapter(onChange: (available: boolean | null) => void): () => void {
    if (!this.capabilities.hasBluetooth) return () => undefined
    this.listeners.add(onChange)
    onChange(this.adapter)
    return () => {
      this.listeners.delete(onChange)
    }
  }

  /** The radio was switched on, switched off, or the browser stopped saying. */
  pushAdapter(available: boolean | null): void {
    this.adapter = available
    for (const listener of this.listeners) listener(available)
  }

  /** Merges over what is already stored, so one control moves one flag. Takes effect on reload. */
  override(overrides: Partial<BleCapabilities>): void {
    this.overridden = { ...this.overridden, ...overrides }
    this.persist()
  }

  clearOverrides(): void {
    this.overridden = {}
    this.persist()
  }

  private persist(): void {
    try {
      localStorage.setItem(OVERRIDE_STORAGE, JSON.stringify(this.overridden))
    } catch {
      // Private browsing denies storage; the overrides simply will not survive the reload.
    }
  }
}
