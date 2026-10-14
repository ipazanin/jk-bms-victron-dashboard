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
const SOLAR_STALE_TIMEOUT_MS = 15_000

export interface VictronHandlers {
  onReading?: (reading: SolarReading, rssi: number) => void
  onUnreadable?: (
    rejection: SolarAdvertisementRejection,
    heardFrom: SolarAdvertisementSource,
  ) => void
  onStale?: () => void
  onIdentity?: (modelId: number) => void
  onWatchedDevice?: (deviceId: string, deviceName: string | null) => void
  onError?: (error: Error) => void
}

export interface SolarScan {
  readonly scanning: boolean
  /** Earliest automatic resume time in epoch milliseconds, or zero when no wait is needed. */
  readonly resumeAvailableAt: number
  start(keyHex: string): Promise<void>
  canResume(rememberedDeviceId: string | null): boolean
  canEverResume(): boolean
  resume(keyHex: string, rememberedDeviceId: string | null, signal?: AbortSignal): Promise<void>
  stop(): void
}

export type SolarLiveTransport = 'scan' | 'watch'

export class SolarAdvertisementProcessor {
  private readonly handlers: VictronHandlers
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

  async begin(keyHex: string): Promise<void> {
    const key = parseAdvertisementKey(keyHex)
    this.end()
    const generation = this.generation
    const cryptoKey = await importAdvertisementKey(key)
    if (generation !== this.generation) return
    this.cryptoKey = cryptoKey
    this.key = key
    this.lastReadingAt = Date.now()
    this.staleNotified = false
    this.identityReported = false
    this.running = true
    this.staleTimer = setInterval(this.checkStale, SOLAR_STALE_CHECK_MS)
  }

  ingest(payload: Uint8Array, rssi: number): void {
    if (!this.key || !this.cryptoKey) return
    const generation = this.generation
    const modelId = readAdvertisementModelId(payload)

    void decodeSolarAdvertisement(payload, this.key, this.cryptoKey)
      .then((outcome) => {
        if (generation !== this.generation) return
        if (!outcome.decoded) {
          this.handlers.onUnreadable?.(outcome.rejection, this.source)
          return
        }
        this.lastReadingAt = Date.now()
        this.staleNotified = false
        if (modelId !== null && !this.identityReported) {
          this.identityReported = true
          this.handlers.onIdentity?.(modelId)
        }
        this.handlers.onReading?.(outcome.reading, rssi)
      })
      .catch((error: Error) => {
        if (generation === this.generation) this.handlers.onError?.(error)
      })
  }

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

// Native Bluetooth promises can stay pending after cancellation.
export function awaitSolarOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => reject(new DOMException('Solar scan cancelled.', 'AbortError'))
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}
