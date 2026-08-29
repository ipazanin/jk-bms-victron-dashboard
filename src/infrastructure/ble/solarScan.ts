/**
 * The solar radio port and the machinery every solar radio shares.
 *
 * `SolarLiveScan` is what the app wires: it owns no radio itself and picks between the two browser
 * routes on every press — `VictronScanner`, which drives `requestLEScan`, and `SolarWatchScanner`,
 * which watches one chooser-picked device, because the scan opens its prompt on macOS and then
 * finds nothing. `BridgeSolarScan` is a fourth implementation, reading the same advertisements
 * relayed from a native helper over a WebSocket, reached only via `?bridge=`.
 *
 * Every transport hands raw manufacturer payloads to one `SolarAdvertisementProcessor`, so the
 * decrypt, the key check, the identity-once rule and the staleness demotion are written once and
 * cannot drift between the routes.
 */

import {
  decodeSolarAdvertisement,
  importAdvertisementKey,
  parseAdvertisementKey,
  readAdvertisementModelId,
} from '../../domain/solar/advertisement'
import type { SolarAdvertisementRejection } from '../../domain/solar/SolarAdvertisementRejection'
import type { SolarAdvertisementSource } from '../../domain/solar/SolarAdvertisementSource'
import type { SolarReading } from '../../domain/solar/types'

const SOLAR_STALE_CHECK_MS = 3_000
/**
 * A Victron controller broadcasts roughly once a second while awake and in range. This much
 * silence means it has gone to sleep (sunset) or drifted out of range, so the last reading is no
 * longer current and must stop being presented as live. This only demotes; the transport keeps
 * running — the controller may wake or come back.
 */
const SOLAR_STALE_TIMEOUT_MS = 15_000

export interface VictronHandlers {
  onReading?: (reading: SolarReading, rssi: number) => void
  /**
   * An advertisement that reached the decoder and did not come out of it as a reading, with the
   * reason it did not and whose it could have been. Reported every time rather than once, so a
   * reason that changes — a key pasted afresh, Instant Readout switched back on — is the one the
   * page is showing.
   *
   * The source travels with it because only the transport knows it, and the same rejection means
   * the owner's own key on a radio that hears one controller and the boat next door on one that
   * hears the marina.
   */
  onUnreadable?: (
    rejection: SolarAdvertisementRejection,
    heardFrom: SolarAdvertisementSource,
  ) => void
  onStale?: () => void
  /**
   * The model id of the controller this scan is decoding, once per scan. We never connect, so
   * there is no serial and no device-info exchange: this number is the whole of what the unit
   * says about itself, and the only thing a recording can name it by.
   */
  onIdentity?: (modelId: number) => void
  /**
   * The handle this scan is watching, reported as soon as it is in hand — what the chooser
   * answered on a press, and the same device found again on a resume. Only the watch route has one
   * to report: the browser's own scan listens to the whole marina without ever naming a device,
   * and the bridge listens to whatever the helper heard.
   *
   * It is what makes the next page load gesture-free, so it is reported once the watch is up and
   * long before a single advertisement has decoded: the id is a fact about permission, and waiting
   * for the controller to speak would be waiting for the wrong thing.
   */
  onWatchedDevice?: (deviceId: string, deviceName: string | null) => void
  onError?: (error: Error) => void
}

/**
 * The solar radio as the layers above it see one. Both concrete scanners are nominal — their
 * private fields mean no object literal could ever be typed as one — which is what lets a fake
 * stand in their place in a spec.
 */
export interface SolarScan {
  readonly scanning: boolean
  /** Call from a user gesture: every browser route raises a native prompt of some kind. */
  start(keyHex: string): Promise<void>
  /**
   * Whether this transport could come up again on its own, given whatever controller this browser
   * remembers. Asked rather than assumed, because the three routes answer it differently and only
   * the transport knows which one it is: the watch needs a remembered id and gets in without a
   * gesture, the browser's own scan needs its permission prompt however much it remembers, and the
   * bridge is a WebSocket that needs neither.
   *
   * It is a question about the route and nothing else. Whether there is a controller worth going
   * back to — and whether the owner has just said stop — is the caller's, and a route that needs
   * no handle must never be read as one with something to return to.
   */
  canResume(rememberedDeviceId: string | null): boolean
  /**
   * Start again with no chooser and no user gesture, on a controller this origin is already
   * permitted to talk to. Only worth calling where `canResume` says so; elsewhere it rejects
   * saying which of the two — the transport or the permission — is in the way.
   */
  resume(keyHex: string, rememberedDeviceId: string | null): Promise<void>
  stop(): void
}

/**
 * Which route this browser reads live solar by. 'scan' is the browser's own `requestLEScan`;
 * 'watch' is one chooser-picked device watched for advertisements, which is what macOS needs.
 * Remembered between presses because the scan's failure — silence — only shows itself long after
 * the click that could have raised a chooser.
 */
export type SolarLiveTransport = 'scan' | 'watch'

/**
 * The decode-and-dispatch core, fed one manufacturer payload at a time by whatever transport owns
 * the radio. It holds the key, the AES key, the staleness clock and the generation counter that
 * drops a decode belonging to a scan that has since stopped — the parts that are subtle enough
 * that two copies would eventually disagree.
 */
export class SolarAdvertisementProcessor {
  private readonly handlers: VictronHandlers
  /** Whose advertisements this transport can hear, which every rejection is reported against. */
  private readonly source: SolarAdvertisementSource
  private key: Uint8Array | null = null
  private cryptoKey: CryptoKey | null = null
  private generation = 0
  private lastReadingAt = 0
  private staleNotified = false
  private identityReported = false
  private running = false
  private staleTimer: ReturnType<typeof setInterval> | null = null

  constructor(handlers: VictronHandlers, source: SolarAdvertisementSource) {
    this.handlers = handlers
    this.source = source
  }

  /**
   * Parse and import the key, then arm the staleness clock. Async because importing the AES key
   * is — so call it once the transport is up, never before the transport's own first await, or on
   * the browser path it would spend the click's transient activation ahead of the `requestLEScan`
   * that needs it.
   */
  async begin(keyHex: string): Promise<void> {
    const key = parseAdvertisementKey(keyHex)
    this.cryptoKey = await importAdvertisementKey(key)
    this.key = key
    this.generation += 1
    this.lastReadingAt = Date.now()
    this.staleNotified = false
    this.identityReported = false
    this.running = true
    this.staleTimer = setInterval(this.checkStale, SOLAR_STALE_CHECK_MS)
  }

  /** One Victron manufacturer payload (the bytes after the company id) and the rssi it arrived at. */
  ingest(payload: Uint8Array, rssi: number): void {
    if (!this.key || !this.cryptoKey) return
    const generation = this.generation
    const modelId = readAdvertisementModelId(payload)

    void decodeSolarAdvertisement(payload, this.key, this.cryptoKey)
      .then((outcome) => {
        // The decrypt is genuinely async. If end() (or a fresh begin) ran while it was in flight,
        // this decode belongs to a scan that no longer exists — drop it rather than report a
        // reading or a rejection against the current session.
        if (generation !== this.generation) return
        if (!outcome.decoded) {
          this.handlers.onUnreadable?.(outcome.rejection, this.source)
          return
        }
        this.lastReadingAt = Date.now()
        this.staleNotified = false
        // Named after the key check and never before it: every Victron in the marina broadcasts a
        // model id, and only the ones that decrypt under this key are the user's controller. Once
        // per scan, because the unit on the other end of a scan cannot change.
        if (modelId !== null && !this.identityReported) {
          this.identityReported = true
          this.handlers.onIdentity?.(modelId)
        }
        this.handlers.onReading?.(outcome.reading, rssi)
      })
      .catch((error: Error) => this.handlers.onError?.(error))
  }

  /** Advance the generation so an in-flight decode is dropped, stop the clock, forget the key. */
  end(): void {
    this.stopStaleTimer()
    this.generation += 1
    this.running = false
    this.key = null
    this.cryptoKey = null
  }

  private readonly checkStale = (): void => {
    if (!this.running || this.staleNotified) return
    if (Date.now() - this.lastReadingAt < SOLAR_STALE_TIMEOUT_MS) return
    this.staleNotified = true
    this.handlers.onStale?.()
  }

  private stopStaleTimer(): void {
    if (this.staleTimer !== null) {
      clearInterval(this.staleTimer)
      this.staleTimer = null
    }
  }
}
