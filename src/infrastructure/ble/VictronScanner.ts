import { parseAdvertisementKey } from '../../domain/solar/advertisement'
import { VICTRON_COMPANY_ID } from '../../domain/solar/types'
import { awaitSolarOperation, SolarAdvertisementProcessor } from './solarScan'
import type { SolarScan, VictronHandlers } from './solarScan'

export class VictronScanner implements SolarScan {
  private attempt: AbortController | null = null
  private scan: BluetoothLEScan | null = null
  private readonly processor: SolarAdvertisementProcessor

  constructor(handlers: VictronHandlers = {}) {
    this.processor = new SolarAdvertisementProcessor(handlers, 'anything-in-range')
  }

  get resumeAvailableAt(): number {
    return 0
  }

  get scanning(): boolean {
    return this.scan?.active === true
  }

  async start(keyHex: string): Promise<void> {
    this.stop()
    parseAdvertisementKey(keyHex)

    if (typeof navigator.bluetooth?.requestLEScan !== 'function') {
      throw new Error(
        'This browser cannot scan for Bluetooth advertisements. ' +
          'Enable chrome://flags/#enable-experimental-web-platform-features and reload.',
      )
    }

    const attempt = new AbortController()
    this.attempt = attempt
    // requestLEScan must run before any await consumes the user gesture.
    const requested = navigator.bluetooth.requestLEScan({
      filters: [{ manufacturerData: [{ companyIdentifier: VICTRON_COMPANY_ID }] }],
      keepRepeatedDevices: true,
    }).then((scan) => {
      if (attempt.signal.aborted) scan.stop()
      return scan
    })
    try {
      const scan = await awaitSolarOperation(requested, attempt.signal)
      if (attempt.signal.aborted) return
      this.scan = scan
      await awaitSolarOperation(this.processor.begin(keyHex), attempt.signal)
      if (attempt.signal.aborted) return
      navigator.bluetooth.addEventListener('advertisementreceived', this.handleAdvertisement)
    } catch (error) {
      if (attempt.signal.aborted) return
      this.stop()
      throw error
    }
  }

  canResume(): boolean {
    return false
  }

  canEverResume(): boolean {
    return false
  }

  async resume(): Promise<void> {
    throw new Error(
      'The browser’s own scan cannot be started without a press. Use Connect solar.',
    )
  }

  stop(): void {
    this.attempt?.abort()
    this.attempt = null
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
