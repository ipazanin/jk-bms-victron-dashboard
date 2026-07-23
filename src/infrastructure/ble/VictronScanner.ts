/**
 * Passive listener for Victron "Instant Readout" advertisements.
 *
 * We never connect to the charge controller. It broadcasts continuously and we decrypt what it
 * says. `keepRepeatedDevices` must be true, or the browser suppresses every advertisement after
 * the first one and the display freezes on a stale reading.
 *
 * Marinas are full of Victron hardware, all advertising under company id 0x02E1. The key-check
 * byte is what separates your controller from your neighbour's; the shared processor returns a
 * foreign-device signal for anything that fails it.
 *
 * This drives the browser's own radio. `requestLEScan` is unreliable on some desktop platforms —
 * on macOS Chrome it opens its prompt and then never delivers an advertisement — which is what
 * `BridgeSolarScan` exists to work around.
 */

import { parseAdvertisementKey } from '../../domain/solar/advertisement'
import { VICTRON_COMPANY_ID } from '../../domain/solar/types'
import { SolarAdvertisementProcessor } from './solarScan'
import type { SolarScan, VictronHandlers } from './solarScan'

export type { SolarScan, VictronHandlers } from './solarScan'

export class VictronScanner implements SolarScan {
  private scan: BluetoothLEScan | null = null
  private readonly processor: SolarAdvertisementProcessor

  constructor(handlers: VictronHandlers = {}) {
    this.processor = new SolarAdvertisementProcessor(handlers)
  }

  get scanning(): boolean {
    return this.scan?.active === true
  }

  /** Call from a user gesture. requestLEScan is awaited before any other async work. */
  async start(keyHex: string): Promise<void> {
    // Idempotent: a second start must not orphan the first scan or its stale timer.
    this.stop()
    // Validate the key before the permission prompt: a malformed key should fail loudly without
    // ever raising the browser's scan dialog. begin() parses it again, which is cheap.
    parseAdvertisementKey(keyHex)

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

    // After requestLEScan resolves, so the key import cannot spend the click's transient activation
    // ahead of it. The listener goes on last, once the processor is ready to decode.
    await this.processor.begin(keyHex)
    navigator.bluetooth.addEventListener('advertisementreceived', this.handleAdvertisement)
  }

  stop(): void {
    // Advance the generation so a decode already in flight is dropped when it resolves, and does
    // not resurrect a stale 'live' reading after the user has stopped.
    this.processor.end()
    navigator.bluetooth?.removeEventListener('advertisementreceived', this.handleAdvertisement)
    this.scan?.stop()
    this.scan = null
  }

  private readonly handleAdvertisement = (event: Event): void => {
    const advertisement = event as BluetoothAdvertisingEvent
    const view = advertisement.manufacturerData.get(VICTRON_COMPANY_ID)
    if (!view) return

    const payload = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    this.processor.ingest(payload, advertisement.rssi ?? 0)
  }
}
