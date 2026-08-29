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
 * The flag is self-correcting in the other direction too: any advertisement at all that lands on
 * the scan path clears it — one that would not decode included, because hearing a neighbour still
 * proves the scan delivers — so an Android user whose controller merely happened to be asleep is
 * not pushed onto the chooser for good.
 *
 * A resume goes through the same choice. Only the watch can come up without a gesture, but a
 * browser that has proven its own scan works keeps it: the route is decided by the evidence and
 * then asked whether it can resume, never the other way round.
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
      onUnreadable: (rejection, heardFrom) => {
        this.noteRadioHeard()
        this.handlers.onUnreadable?.(rejection, heardFrom)
      },
      onStale: () => {
        this.noteSilence()
        this.handlers.onStale?.()
      },
      onIdentity: (modelId) => this.handlers.onIdentity?.(modelId),
      onWatchedDevice: (deviceId, deviceName) =>
        this.handlers.onWatchedDevice?.(deviceId, deviceName),
      onError: (error) => this.handlers.onError?.(error),
    }
  }

  get scanning(): boolean {
    return this.active?.scanning === true
  }

  /** Deliberately not async, for the reason `reachForRadio` gives. */
  start(keyHex: string): Promise<void> {
    return this.reachForRadio().start(keyHex)
  }

  /**
   * Whether the route this browser would take can come up on its own.
   *
   * The verdict outranks the ability to resume, which is why this asks the same question `start`
   * does rather than looking for any route that could. A browser whose own scan has been proven to
   * work is not moved onto the chooser's transport by the back door — the price of a gesture-free
   * link is not worth paying in a route this browser has evidence against.
   */
  canResume(rememberedDeviceId: string | null): boolean {
    return this.transportFor(this.chooseTransport()).canResume(rememberedDeviceId)
  }

  resume(keyHex: string, rememberedDeviceId: string | null): Promise<void> {
    return this.reachForRadio().resume(keyHex, rememberedDeviceId)
  }

  stop(): void {
    this.active?.stop()
    this.active = null
  }

  /**
   * Picks the route afresh, hands back the radio for it and holds it as the active one. Everything
   * ahead of the child's own call is synchronous, so a press's transient activation reaches
   * `requestDevice` intact.
   */
  private reachForRadio(): SolarScan {
    this.stop()
    this.heardAnything = false
    this.activeTransport = this.chooseTransport()
    this.active = this.transportFor(this.activeTransport)
    return this.active
  }

  /**
   * A radio of the named kind. `canResume` asks one of these without ever starting it, which costs
   * nothing: a scanner touches no radio until it is told to.
   */
  private transportFor(transport: SolarLiveTransport): SolarScan {
    return transport === 'watch' ? new SolarWatchScanner(this.relay) : new VictronScanner(this.relay)
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
