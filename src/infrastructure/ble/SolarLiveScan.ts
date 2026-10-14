import { detectCapabilities } from './capabilities'
import { SolarWatchScanner, solarWatchResumeAvailableAt } from './SolarWatchScanner'
import { VictronScanner } from './VictronScanner'
import type { BleCapabilities } from './capabilities'
import type { SolarLiveTransport, SolarScan, VictronHandlers } from './solarScan'

export class SolarLiveScan implements SolarScan {
  private readonly handlers: VictronHandlers
  private readonly capabilities: BleCapabilities
  private readonly recentRegistrations: number[] = []
  private active: SolarScan | null = null

  constructor(handlers: VictronHandlers = {}) {
    this.handlers = handlers
    this.capabilities = detectCapabilities()
  }

  get resumeAvailableAt(): number {
    return this.chooseTransport() === 'watch' ? solarWatchResumeAvailableAt(this.recentRegistrations) : 0
  }

  get scanning(): boolean {
    return this.active?.scanning === true
  }

  start(keyHex: string): Promise<void> {
    return this.reachForRadio().start(keyHex)
  }

  canResume(rememberedDeviceId: string | null): boolean {
    return this.transportFor(this.chooseTransport()).canResume(rememberedDeviceId)
  }

  canEverResume(): boolean {
    return this.transportFor(this.chooseTransport()).canEverResume()
  }

  resume(keyHex: string, rememberedDeviceId: string | null, signal?: AbortSignal): Promise<void> {
    return this.reachForRadio().resume(keyHex, rememberedDeviceId, signal)
  }

  stop(): void {
    this.active?.stop()
    this.active = null
  }

  private reachForRadio(): SolarScan {
    this.stop()
    this.active = this.transportFor(this.chooseTransport())
    return this.active
  }

  private transportFor(transport: SolarLiveTransport): SolarScan {
    return transport === 'watch'
      ? new SolarWatchScanner(this.handlers, undefined, this.recentRegistrations)
      : new VictronScanner(this.handlers)
  }

  private chooseTransport(): SolarLiveTransport {
    return this.capabilities.canWatchAdvertisements ? 'watch' : 'scan'
  }
}
