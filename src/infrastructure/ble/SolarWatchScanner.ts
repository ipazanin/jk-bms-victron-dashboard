import { browserPageActivity } from '../../application/pageActivity'
import type { PageActivity } from '../../application/pageActivity'
import { parseAdvertisementKey } from '../../domain/solar/advertisement'
import { SOLAR_TUNNEL_SERVICE } from '../../domain/solar/tunnel/session'
import { VICTRON_COMPANY_ID } from '../../domain/solar/types'
import { watchAdvertisementsSupported } from './capabilities'
import { permittedDevice } from './permittedDevice'
import type { PermittedDeviceRefusals } from './permittedDevice'
import { ReconnectRefusedError } from './ReconnectRefusedError'
import { awaitSolarOperation, SolarAdvertisementProcessor } from './solarScan'
import type { SolarScan, VictronHandlers } from './solarScan'

const FIRST_REARM_MS = 3_000
const REARM_GROWTH = 2
const REARM_CEILING_MS = 30_000
const REARM_CHECK_MS = 1_000
const REARM_BUDGET = 4
const REARM_BUDGET_WINDOW_MS = 30_000

const NO_WATCH_ROUTE =
  'This browser cannot watch Bluetooth advertisements. ' +
  'Enable chrome://flags/#enable-experimental-web-platform-features and reload.'

function permittedDevicesListable(): boolean {
  const bluetooth = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined
  return bluetooth !== undefined && typeof bluetooth.getDevices === 'function'
}

const WATCH_REFUSALS: PermittedDeviceRefusals = {
  cannotListPermitted: 'This browser cannot start the watch without the chooser. Press Connect solar.',
  wouldNotListPermitted: 'This browser would not list its permitted devices. Press Connect solar.',
  permissionGone:
    'This browser no longer has permission for the last controller. Press Connect solar to pick it again.',
}

async function permittedController(deviceId: string | null): Promise<BluetoothDevice> {
  if (deviceId === null) {
    throw new ReconnectRefusedError(
      'permission-gone',
      'This browser has not been shown the controller yet. Press Connect solar and pick it from the list.',
    )
  }
  return permittedDevice(deviceId, WATCH_REFUSALS)
}

function watchChooserOptions(): RequestDeviceOptions {
  return {
    filters: [{ manufacturerData: [{ companyIdentifier: VICTRON_COMPANY_ID }] }],
    optionalManufacturerData: [VICTRON_COMPANY_ID],
    optionalServices: [SOLAR_TUNNEL_SERVICE],
  }
}

export class SolarWatchScanner implements SolarScan {
  private readonly handlers: VictronHandlers
  private readonly processor: SolarAdvertisementProcessor
  private readonly pageActivity: PageActivity
  private device: BluetoothDevice | null = null
  private watch: AbortController | null = null
  private running = false
  private nextRearmAt = 0
  private rearmGapMs = FIRST_REARM_MS
  private readonly recentRegistrations: number[]
  private silenceTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribeFromPage: (() => void) | null = null
  private watchToken = 0
  private attempt: AbortController | null = null
  private detachAbort: (() => void) | null = null

  constructor(
    handlers: VictronHandlers = {},
    pageActivity: PageActivity = browserPageActivity(),
    recentRegistrations: number[] = [],
  ) {
    this.handlers = handlers
    this.processor = new SolarAdvertisementProcessor(handlers, 'this-controller')
    this.pageActivity = pageActivity
    this.recentRegistrations = recentRegistrations
  }

  get resumeAvailableAt(): number {
    return solarWatchResumeAvailableAt(this.recentRegistrations)
  }

  get scanning(): boolean {
    return this.running
  }

  async start(keyHex: string): Promise<void> {
    this.stop()
    parseAdvertisementKey(keyHex)

    if (typeof navigator.bluetooth?.requestDevice !== 'function' || !watchAdvertisementsSupported()) {
      throw new Error(NO_WATCH_ROUTE)
    }

    const attempt = new AbortController()
    this.attempt = attempt
    try {
      // Keep requestDevice on the user gesture stack, before key import or quota waiting.
      const device = await awaitSolarOperation(navigator.bluetooth.requestDevice(watchChooserOptions()), attempt.signal)
      if (attempt.signal.aborted) return
      await this.watchDevice(device, keyHex, attempt.signal, false)
    } catch (error) {
      if (attempt.signal.aborted) return
      this.stop()
      throw error
    }
  }

  canResume(rememberedDeviceId: string | null): boolean {
    return rememberedDeviceId !== null && this.canEverResume()
  }

  canEverResume(): boolean {
    return watchAdvertisementsSupported() && permittedDevicesListable()
  }

  async resume(keyHex: string, rememberedDeviceId: string | null, signal?: AbortSignal): Promise<void> {
    this.stop()
    if (signal?.aborted) throw new DOMException('Solar scan cancelled.', 'AbortError')
    parseAdvertisementKey(keyHex)
    if (!watchAdvertisementsSupported()) throw new Error(NO_WATCH_ROUTE)

    const attempt = new AbortController()
    this.attempt = attempt
    const cancel = (): void => {
      if (this.attempt === attempt) this.stop()
    }
    signal?.addEventListener('abort', cancel, { once: true })
    this.detachAbort = () => signal?.removeEventListener('abort', cancel)
    try {
      const device = await awaitSolarOperation(permittedController(rememberedDeviceId), attempt.signal)
      if (attempt.signal.aborted) return
      await this.watchDevice(device, keyHex, attempt.signal, true)
    } catch (error) {
      if (attempt.signal.aborted) return
      this.stop()
      throw error
    } finally {
      if (signal?.aborted) throw new DOMException('Solar scan cancelled.', 'AbortError')
    }
  }

  private async watchDevice(
    device: BluetoothDevice,
    keyHex: string,
    signal: AbortSignal,
    automatic: boolean,
  ): Promise<void> {
    if (automatic) await this.waitForRegistration(signal)
    if (signal.aborted) return
    await awaitSolarOperation(this.processor.begin(keyHex), signal)
    if (signal.aborted) return

    this.device = device
    device.addEventListener('advertisementreceived', this.handleAdvertisement)
    this.running = true
    await this.arm()
    if (signal.aborted) return

    this.silenceTimer = setInterval(this.checkSilence, REARM_CHECK_MS)
    this.unsubscribeFromPage = this.pageActivity.subscribe(this.handlePageChange)
    this.handlers.onWatchedDevice?.(device.id, device.name ?? null)
  }

  private async waitForRegistration(signal: AbortSignal): Promise<void> {
    let delay = this.resumeAvailableAt - Date.now()
    while (delay > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await awaitSolarOperation(new Promise<void>((resolve) => {
          timer = setTimeout(resolve, delay)
        }), signal)
      } finally {
        clearTimeout(timer)
      }
      if (signal.aborted) return
      delay = this.resumeAvailableAt - Date.now()
    }
  }

  stop(): void {
    this.running = false
    this.watchToken += 1
    this.attempt?.abort()
    this.attempt = null
    this.detachAbort?.()
    this.detachAbort = null
    this.rearmGapMs = FIRST_REARM_MS
    this.processor.end()
    if (this.silenceTimer !== null) {
      clearInterval(this.silenceTimer)
      this.silenceTimer = null
    }
    this.unsubscribeFromPage?.()
    this.unsubscribeFromPage = null
    this.device?.removeEventListener('advertisementreceived', this.handleAdvertisement)
    this.watch?.abort()
    this.watch = null
    this.device = null
  }

  private async arm(): Promise<void> {
    const device = this.device
    if (!device) return

    const token = ++this.watchToken
    const previous = this.watch
    this.watch = new AbortController()
    const askedAt = Date.now()
    this.recentRegistrations.push(askedAt)
    this.nextRearmAt = askedAt + this.rearmGapMs
    this.rearmGapMs = Math.min(this.rearmGapMs * REARM_GROWTH, REARM_CEILING_MS)
    previous?.abort()

    try {
      await awaitSolarOperation(device.watchAdvertisements({ signal: this.watch.signal }), this.watch.signal)
    } catch {
      if (token !== this.watchToken || this.watch?.signal.aborted === true) return
      throw new Error('The Victron watch stopped. Press Connect solar to start it again.')
    }
  }

  private readonly checkSilence = (): void => {
    if (!this.running) return
    if (!this.pageIsInFront()) return
    const now = Date.now()
    if (now < this.nextRearmAt) return
    const allowedAt = this.resumeAvailableAt
    if (allowedAt > now) {
      this.nextRearmAt = allowedAt
      return
    }
    const attempt = this.attempt
    void this.arm().catch((error: Error) => {
      if (this.attempt !== attempt) return
      this.stop()
      this.handlers.onError?.(error)
    })
  }

  private pageIsInFront(): boolean {
    return this.pageActivity.visible() && this.pageActivity.focused()
  }

  private readonly handlePageChange = (): void => {
    if (!this.running || !this.pageIsInFront()) return
    this.restartLadder()
  }

  private restartLadder(): void {
    this.rearmGapMs = FIRST_REARM_MS
    this.nextRearmAt = Date.now() + FIRST_REARM_MS
  }

  private readonly handleAdvertisement = (event: Event): void => {
    const advertisement = event as BluetoothAdvertisingEvent
    this.restartLadder()

    const view = advertisement.manufacturerData.get(VICTRON_COMPANY_ID)
    if (!view) return

    const payload = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    this.processor.ingest(payload, advertisement.rssi ?? 0)
  }
}

// Four registrations per thirty seconds leave conservative headroom for the battery watch.
export function solarWatchResumeAvailableAt(recentRegistrations: number[], now = Date.now()): number {
  while (recentRegistrations.length > 0 && recentRegistrations[0] <= now - REARM_BUDGET_WINDOW_MS) {
    recentRegistrations.shift()
  }
  const spent = recentRegistrations.length
  if (spent < REARM_BUDGET) return 0
  return recentRegistrations[spent - REARM_BUDGET] + REARM_BUDGET_WINDOW_MS
}
