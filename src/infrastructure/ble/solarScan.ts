/**
 * The solar radio port and the machinery every solar radio shares.
 *
 * Two things implement `SolarScan`: `VictronScanner`, which drives the browser's own
 * `requestLEScan`, and `BridgeSolarScan`, which reads the same advertisements relayed from a
 * native helper over a WebSocket — the escape hatch for macOS, where the browser's scan opens its
 * prompt and then finds nothing. Both hand raw manufacturer payloads to one
 * `SolarAdvertisementProcessor`, so the decrypt, the key check, the identity-once rule and the
 * staleness demotion are written once and cannot drift between the two paths.
 */

import {
  decodeSolarAdvertisement,
  importAdvertisementKey,
  parseAdvertisementKey,
  readAdvertisementModelId,
} from '../../domain/solar/advertisement'
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
  onForeignDevice?: () => void
  onStale?: () => void
  /**
   * The model id of the controller this scan is decoding, once per scan. We never connect, so
   * there is no serial and no device-info exchange: this number is the whole of what the unit
   * says about itself, and the only thing a recording can name it by.
   */
  onIdentity?: (modelId: number) => void
  onError?: (error: Error) => void
}

/**
 * The solar radio as the layers above it see one. Both concrete scanners are nominal — their
 * private fields mean no object literal could ever be typed as one — which is what lets a fake
 * stand in their place in a spec.
 */
export interface SolarScan {
  readonly scanning: boolean
  start(keyHex: string): Promise<void>
  stop(): void
}

/**
 * The decode-and-dispatch core, fed one manufacturer payload at a time by whatever transport owns
 * the radio. It holds the key, the AES key, the staleness clock and the generation counter that
 * drops a decode belonging to a scan that has since stopped — the parts that are subtle enough
 * that two copies would eventually disagree.
 */
export class SolarAdvertisementProcessor {
  private readonly handlers: VictronHandlers
  private key: Uint8Array | null = null
  private cryptoKey: CryptoKey | null = null
  private generation = 0
  private lastReadingAt = 0
  private staleNotified = false
  private identityReported = false
  private running = false
  private staleTimer: ReturnType<typeof setInterval> | null = null

  constructor(handlers: VictronHandlers) {
    this.handlers = handlers
  }

  get active(): boolean {
    return this.running
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
      .then((reading) => {
        // The decrypt is genuinely async. If end() (or a fresh begin) ran while it was in flight,
        // this decode belongs to a scan that no longer exists — drop it rather than report a
        // reading or a foreign device against the current session.
        if (generation !== this.generation) return
        if (!reading) {
          this.handlers.onForeignDevice?.()
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
        this.handlers.onReading?.(reading, rssi)
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
