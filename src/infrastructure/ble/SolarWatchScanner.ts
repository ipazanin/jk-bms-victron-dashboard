/**
 * Victron "Instant Readout" advertisements read off a chooser-picked device handle.
 *
 * The browser's own `requestLEScan` opens its prompt on macOS and then never delivers an
 * advertisement. `watchAdvertisements` on a single device does deliver there, so this transport
 * trades the scan's device-free listening for one chooser tap per page load.
 *
 * Two things make it work and neither is optional. `optionalManufacturerData` must name Victron's
 * company id in the chooser options, or the browser withholds `manufacturerData` from every event
 * and the payload arrives empty. And a watch goes quiet after roughly fifteen seconds while
 * `watchingAdvertisements` still reads true, so silence is met by aborting the stalled watch and
 * asking for a new one — the controller re-appears within about a second, indefinitely.
 *
 * The handle is held for as long as the scan runs and is never GATT-connected: connecting would
 * stop the controller advertising, which is the one thing this class is for.
 */

import { parseAdvertisementKey } from '../../domain/solar/advertisement'
import { VICTRON_COMPANY_ID } from '../../domain/solar/types'
import { watchAdvertisementsSupported } from './capabilities'
import { SolarAdvertisementProcessor } from './solarScan'
import type { SolarScan, VictronHandlers } from './solarScan'

/** How long a watch may say nothing before we treat it as stalled rather than merely quiet. */
const WATCH_SILENCE_MS = 5_000
const WATCH_CHECK_MS = 1_000

/**
 * The company-id filter is what finds this controller among a marina full of Victron hardware;
 * `optionalManufacturerData` is what makes its payload survive into the event. No optional
 * services: this path never connects, so asking for the tunnel would be asking for permission we
 * must never use.
 */
function watchChooserOptions(): RequestDeviceOptions {
  return {
    filters: [{ manufacturerData: [{ companyIdentifier: VICTRON_COMPANY_ID }] }],
    optionalManufacturerData: [VICTRON_COMPANY_ID],
  }
}

export class SolarWatchScanner implements SolarScan {
  private readonly handlers: VictronHandlers
  private readonly processor: SolarAdvertisementProcessor
  private device: BluetoothDevice | null = null
  private watch: AbortController | null = null
  private running = false
  private lastAdvertisementAt = 0
  private silenceTimer: ReturnType<typeof setInterval> | null = null
  /** Mirrors JkBmsClient's attachToken: a re-arm superseded by stop() must not resurrect. */
  private watchToken = 0
  /**
   * The same guard one level up. `start` parks on the chooser for as long as the user takes to
   * answer it, and Cancel is on screen throughout — a stop() during that wait must not be undone
   * when Allow finally resolves the promise, or the scanner comes back with nothing able to reach
   * it and every advertisement is reported twice.
   */
  private startToken = 0

  constructor(handlers: VictronHandlers = {}) {
    this.handlers = handlers
    this.processor = new SolarAdvertisementProcessor(handlers)
  }

  get scanning(): boolean {
    return this.running
  }

  /** Call from a user gesture. requestDevice is awaited before any other async work. */
  async start(keyHex: string): Promise<void> {
    // Idempotent: a second start must not orphan the first watch, its listener or its timer.
    this.stop()
    // Validate the key before the chooser: a malformed key should fail loudly without ever
    // raising the browser's device dialog. begin() parses it again, which is cheap.
    parseAdvertisementKey(keyHex)

    if (typeof navigator.bluetooth?.requestDevice !== 'function' || !watchAdvertisementsSupported()) {
      throw new Error(
        'This browser cannot watch Bluetooth advertisements. ' +
          'Enable chrome://flags/#enable-experimental-web-platform-features and reload.',
      )
    }

    const token = this.startToken
    const device = await navigator.bluetooth.requestDevice(watchChooserOptions())
    // Nothing is on the instance yet, so a stop() during the chooser leaves nothing to undo.
    if (token !== this.startToken) return

    // After the chooser resolves, so the key import cannot spend the click's transient activation
    // ahead of it. The listener goes on last, once the processor is ready to decode.
    await this.processor.begin(keyHex)
    if (token !== this.startToken) {
      // begin() armed the staleness clock, so this one does need undoing.
      this.processor.end()
      return
    }

    this.device = device
    device.addEventListener('advertisementreceived', this.handleAdvertisement)
    this.running = true

    // A rejection here has already torn the scanner down; letting it out keeps the caller from
    // reporting a watch that is not up.
    await this.arm()
    this.silenceTimer = setInterval(this.checkSilence, WATCH_CHECK_MS)
  }

  stop(): void {
    // Advance the generation so a decode already in flight is dropped when it resolves, and bump
    // the tokens so an arm() still waiting on the browser, or a start() still waiting on the
    // chooser, unwinds instead of resurrecting the scan.
    this.running = false
    this.watchToken += 1
    this.startToken += 1
    this.processor.end()
    if (this.silenceTimer !== null) {
      clearInterval(this.silenceTimer)
      this.silenceTimer = null
    }
    this.device?.removeEventListener('advertisementreceived', this.handleAdvertisement)
    this.watch?.abort()
    this.watch = null
    this.device = null
  }

  /**
   * Replace the current watch with a fresh one. The new controller is installed before the old one
   * is aborted, so the rejection this distinguishes is unambiguously ours rather than the browser's.
   *
   * A genuine failure throws after a full teardown: half a scanner — a live listener, a live
   * interval and a held device handle with nothing watching — is worse than none, and nothing above
   * this class calls stop() on an error.
   */
  private async arm(): Promise<void> {
    const device = this.device
    if (!device) return

    const token = ++this.watchToken
    const previous = this.watch
    this.watch = new AbortController()
    // Give the fresh watch a full silence window before it can be judged stalled.
    this.lastAdvertisementAt = Date.now()
    previous?.abort()

    try {
      await device.watchAdvertisements({ signal: this.watch.signal })
    } catch {
      if (token !== this.watchToken || this.watch?.signal.aborted === true) return
      this.stop()
      throw new Error('The Victron watch stopped. Press Connect solar to start it again.')
    }
  }

  private readonly checkSilence = (): void => {
    if (!this.running) return
    if (Date.now() - this.lastAdvertisementAt < WATCH_SILENCE_MS) return
    // Off the user's own call stack, so a re-arm failure has no caller to reject to.
    void this.arm().catch((error: Error) => this.handlers.onError?.(error))
  }

  private readonly handleAdvertisement = (event: Event): void => {
    const advertisement = event as BluetoothAdvertisingEvent
    // Stamped before the company-id check: any advertisement at all proves the watch is alive,
    // while only a decoded one proves the controller is. The processor's own staleness clock
    // answers that second question, and conflating them would set the re-arm loop fighting it.
    this.lastAdvertisementAt = Date.now()

    const view = advertisement.manufacturerData.get(VICTRON_COMPANY_ID)
    if (!view) return

    const payload = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    this.processor.ingest(payload, advertisement.rssi ?? 0)
  }
}
