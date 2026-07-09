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

export interface VictronHandlers {
  onReading?: (reading: SolarReading, rssi: number) => void
  onForeignDevice?: () => void
  onError?: (error: Error) => void
}

export class VictronScanner {
  private scan: BluetoothLEScan | null = null
  private key: Uint8Array | null = null
  private cryptoKey: CryptoKey | null = null
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
    navigator.bluetooth.addEventListener('advertisementreceived', this.handleAdvertisement)
  }

  stop(): void {
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

    void decodeSolarAdvertisement(payload, this.key, this.cryptoKey)
      .then((reading) => {
        if (!reading) {
          this.handlers.onForeignDevice?.()
          return
        }
        this.handlers.onReading?.(reading, advertisement.rssi ?? 0)
      })
      .catch((error: Error) => this.handlers.onError?.(error))
  }
}
