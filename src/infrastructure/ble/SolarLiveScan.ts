/**
 * Picks the route this browser reads live solar by, and re-picks it on every press.
 *
 * A browser that offers both routes takes the watch, always. Only the watch survives a reload: it
 * holds a chooser-granted device that `getDevices` hands back, so the page can come up listening
 * again without a press. `requestLEScan` can do neither — it needs a fresh user gesture for every
 * start, and it cannot filter on manufacturer data, so it hears every beacon in the marina and
 * sorts them in the page. It stays as the route for browsers that expose scanning but not
 * `watchAdvertisements`, and for nothing else.
 *
 * A resume goes through the same choice, which is what makes the answer to "can this page come
 * back on its own" a question about the route rather than about the last time it was pressed.
 */

import { detectCapabilities } from './capabilities'
import { SolarWatchScanner } from './SolarWatchScanner'
import { VictronScanner } from './VictronScanner'
import type { BleCapabilities } from './capabilities'
import type { SolarLiveTransport, SolarScan, VictronHandlers } from './solarScan'

export class SolarLiveScan implements SolarScan {
  private readonly handlers: VictronHandlers
  private readonly capabilities: BleCapabilities
  private active: SolarScan | null = null

  constructor(handlers: VictronHandlers = {}) {
    this.handlers = handlers
    this.capabilities = detectCapabilities()
  }

  get scanning(): boolean {
    return this.active?.scanning === true
  }

  /** Deliberately not async, for the reason `reachForRadio` gives. */
  start(keyHex: string): Promise<void> {
    return this.reachForRadio().start(keyHex)
  }

  /** Whether the route this browser would take can come up on its own, given what is remembered. */
  canResume(rememberedDeviceId: string | null): boolean {
    return this.transportFor(this.chooseTransport()).canResume(rememberedDeviceId)
  }

  /**
   * The same route, asked whether it has a way back at all. A browser with nothing but the scan
   * answers no however long it is left alone, which is the whole of what a page holding no
   * remembered controller has to go on.
   */
  canEverResume(): boolean {
    return this.transportFor(this.chooseTransport()).canEverResume()
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
    this.active = this.transportFor(this.chooseTransport())
    return this.active
  }

  /**
   * A radio of the named kind. `canResume` asks one of these without ever starting it, which costs
   * nothing: a scanner touches no radio until it is told to.
   */
  private transportFor(transport: SolarLiveTransport): SolarScan {
    return transport === 'watch'
      ? new SolarWatchScanner(this.handlers)
      : new VictronScanner(this.handlers)
  }

  /**
   * The watch wherever this browser has one, because it is the only route that comes back up
   * without a press. The scan is what a browser exposing scanning alone is left with, and it is
   * also where a browser with neither route goes, so the flag-hint error stays in one place.
   */
  private chooseTransport(): SolarLiveTransport {
    return this.capabilities.canWatchAdvertisements ? 'watch' : 'scan'
  }
}
