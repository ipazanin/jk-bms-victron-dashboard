/**
 * Picks the route this browser reads live solar by, and re-picks it on every press.
 *
 * Feature detection alone cannot choose a route: macOS Chrome exposes `requestLEScan`, resolves
 * it, and then delivers nothing forever. On macOS the silence is a known platform fact, so a
 * browser with both routes and no remembered verdict starts on the watch — one press, one
 * chooser, no scanning-permission prompt. Elsewhere the test is behavioural: the silence takes
 * fifteen seconds to show itself and by then the click's transient activation is long spent, so
 * no chooser can be raised inside the failing press; the verdict is remembered and applied to the
 * next one, and the user reads a sentence in the solar banner telling them to press again.
 *
 * The flag is self-correcting in the other direction too: any reading or foreign device that ever
 * lands on the scan path clears it, so an Android user whose controller merely happened to be
 * asleep is not pushed onto the chooser for good.
 */

import { loadSolarLiveTransport, saveSolarLiveTransport } from '../../application/storage'
import { detectCapabilities } from './capabilities'
import { SolarWatchScanner } from './SolarWatchScanner'
import { VictronScanner } from './VictronScanner'
import type { BleCapabilities } from './capabilities'
import type { SolarLiveTransport, SolarScan, VictronHandlers } from './solarScan'

/**
 * Names the button that is actually on screen. The scan is still up when this is raised, so the
 * panel reads "Stop solar" — telling the user to press Connect solar would point at a control that
 * is not rendered until they have stopped.
 */
const SILENT_SCAN_NOTICE =
  'The browser’s scan found nothing. Press Stop solar, then Connect solar, and pick the controller from the list.'

export class SolarLiveScan implements SolarScan {
  private readonly handlers: VictronHandlers
  private readonly capabilities: BleCapabilities
  private readonly relay: VictronHandlers
  private active: SolarScan | null = null
  private activeTransport: SolarLiveTransport = 'scan'
  private heardAnything = false

  constructor(handlers: VictronHandlers = {}) {
    this.handlers = handlers
    this.capabilities = detectCapabilities()
    this.relay = {
      onReading: (reading, rssi) => {
        this.noteRadioHeard()
        this.handlers.onReading?.(reading, rssi)
      },
      onForeignDevice: () => {
        this.noteRadioHeard()
        this.handlers.onForeignDevice?.()
      },
      onStale: () => {
        this.noteSilence()
        this.handlers.onStale?.()
      },
      onIdentity: (modelId) => this.handlers.onIdentity?.(modelId),
      onError: (error) => this.handlers.onError?.(error),
    }
  }

  get scanning(): boolean {
    return this.active?.scanning === true
  }

  /**
   * Deliberately not async. Everything ahead of the child's own `start` is synchronous, so the
   * click's transient activation reaches `requestDevice` intact.
   */
  start(keyHex: string): Promise<void> {
    this.stop()
    this.heardAnything = false
    this.activeTransport = this.chooseTransport()
    this.active =
      this.activeTransport === 'watch'
        ? new SolarWatchScanner(this.relay)
        : new VictronScanner(this.relay)
    return this.active.start(keyHex)
  }

  stop(): void {
    this.active?.stop()
    this.active = null
  }

  private chooseTransport(): SolarLiveTransport {
    const { canScan, canWatchAdvertisements, scanKnownSilent } = this.capabilities
    if (canScan && !canWatchAdvertisements) return 'scan'
    if (!canScan && canWatchAdvertisements) return 'watch'
    if (canScan && canWatchAdvertisements) {
      // A remembered verdict is this browser's own evidence and outranks the platform default;
      // absent one, a platform whose scan is known silent goes straight to the chooser instead of
      // spending the user's first press proving it.
      return loadSolarLiveTransport() ?? (scanKnownSilent ? 'watch' : 'scan')
    }
    // Neither route exists: hand it to the scanner so the flag-hint error stays in one place.
    return 'scan'
  }

  private noteRadioHeard(): void {
    // Once per attempt, not once per advertisement: this runs on every payload the radio hears,
    // and the verdict below is a synchronous localStorage write.
    if (this.heardAnything) return
    this.heardAnything = true
    // A scan that hears anything at all is working, whatever the last verdict said.
    if (this.activeTransport === 'scan') saveSolarLiveTransport('scan')
  }

  private noteSilence(): void {
    if (this.activeTransport !== 'scan' || this.heardAnything) return
    if (!this.capabilities.canWatchAdvertisements) return
    saveSolarLiveTransport('watch')
    this.handlers.onError?.(new Error(SILENT_SCAN_NOTICE))
    // The scan is left running on purpose: if the controller was merely out of range, a later
    // advertisement still lands and clears the verdict again.
  }
}
