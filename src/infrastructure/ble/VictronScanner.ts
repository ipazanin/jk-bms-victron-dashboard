/**
 * Passive listener for Victron "Instant Readout" advertisements.
 *
 * We never connect to the charge controller. It broadcasts continuously and we decrypt
 * what it says. `keepRepeatedDevices` must be true, or the browser suppresses every
 * advertisement after the first one and the display freezes on a stale reading.
 *
 * Marinas are full of Victron hardware, all advertising under company id 0x02E1. The
 * advertisement's key-check byte is what separates your controller from your neighbour's,
 * and `decodeSolarAdvertisement` returns null for anything that fails it.
 */

import {
  decodeSolarAdvertisement,
  importAdvertisementKey,
  parseAdvertisementKey,
} from '../../domain/solar/advertisement'
import { VICTRON_COMPANY_ID } from '../../domain/solar/types'
import type { SolarReading } from '../../domain/solar/types'

const SOLAR_STALE_CHECK_MS = 3_000
/**
 * A Victron controller broadcasts roughly once a second while awake and in range. This much
 * silence means it has gone to sleep (sunset) or drifted out of range, so the last reading
 * is no longer current and must stop being presented as live. The scan keeps running — the
 * controller may wake or come back — so this only demotes; it never stops listening.
 */
const SOLAR_STALE_TIMEOUT_MS = 15_000

export interface VictronHandlers {
  onReading?: (reading: SolarReading, rssi: number) => void
  onForeignDevice?: () => void
  onStale?: () => void
  onError?: (error: Error) => void
}

export class VictronScanner {
  private scan: BluetoothLEScan | null = null
  private key: Uint8Array | null = null
  private cryptoKey: CryptoKey | null = null
  private generation = 0
  private lastReadingAt = 0
  private staleNotified = false
  private staleTimer: ReturnType<typeof setInterval> | null = null
  private readonly handlers: VictronHandlers

  constructor(handlers: VictronHandlers = {}) {
    this.handlers = handlers
  }

  get scanning(): boolean {
    return this.scan?.active === true
  }

  /** Call from a user gesture. requestLEScan is awaited before any other async work. */
  async start(keyHex: string): Promise<void> {
    const key = parseAdvertisementKey(keyHex)

    if (typeof navigator.bluetooth?.requestLEScan !== 'function') {
      throw new Error(
        'This browser cannot scan for Bluetooth advertisements. ' +
          'Enable chrome://flags/#enable-experimental-web-platform-features and reload.',
      )
    }

    this.scan = await navigator.bluetooth.requestLEScan({
      filters: [{ manufacturerData: [{ companyIdentifier: VICTRON_COMPANY_ID }] }],
      keepRepeatedDevices: true,
    })

    this.key = key
    this.cryptoKey = await importAdvertisementKey(key)
    this.generation += 1
    this.lastReadingAt = Date.now()
    this.staleNotified = false
    navigator.bluetooth.addEventListener('advertisementreceived', this.handleAdvertisement)
    this.staleTimer = setInterval(this.checkStale, SOLAR_STALE_CHECK_MS)
  }

  stop(): void {
    this.stopStaleTimer()
    // Advance the generation so a decode already in flight is dropped when it resolves, and
    // does not resurrect a stale 'live' reading after the user has stopped.
    this.generation += 1
    navigator.bluetooth?.removeEventListener('advertisementreceived', this.handleAdvertisement)
    this.scan?.stop()
    this.scan = null
    this.key = null
    this.cryptoKey = null
  }

  private readonly handleAdvertisement = (event: Event): void => {
    const advertisement = event as BluetoothAdvertisingEvent
    const view = advertisement.manufacturerData.get(VICTRON_COMPANY_ID)
    if (!view || !this.key || !this.cryptoKey) return

    const payload = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    const generation = this.generation
    const rssi = advertisement.rssi ?? 0

    void decodeSolarAdvertisement(payload, this.key, this.cryptoKey)
      .then((reading) => {
        // The decrypt is genuinely async. If stop() (or a fresh start) ran while it was in
        // flight, this decode belongs to a scan that no longer exists — drop it rather than
        // report a reading or a foreign device against the current session.
        if (generation !== this.generation) return
        if (!reading) {
          this.handlers.onForeignDevice?.()
          return
        }
        this.lastReadingAt = Date.now()
        this.staleNotified = false
        this.handlers.onReading?.(reading, rssi)
      })
      .catch((error: Error) => this.handlers.onError?.(error))
  }

  private readonly checkStale = (): void => {
    if (!this.scanning || this.staleNotified) return
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
