/**
 * Victron "Instant Readout" advertisements read off a chooser-picked device handle.
 *
 * The browser's own `requestLEScan` opens its prompt on macOS and then never delivers an
 * advertisement. `watchAdvertisements` on a single device does deliver there, so this transport
 * trades the scan's device-free listening for a chooser tap — owed once per browser rather than
 * once per page load, as the last paragraph here explains.
 *
 * Two things make it work and neither is optional. `optionalManufacturerData` must name Victron's
 * company id in the chooser options, or the browser withholds `manufacturerData` from every event
 * and the payload arrives empty. And a watch goes quiet after roughly fifteen seconds while
 * `watchingAdvertisements` still reads true, so silence is met by aborting the stalled watch and
 * asking for a new one — the controller re-appears within about a second, indefinitely.
 *
 * That flag is the one thing here never to believe. Chromium tears every advertisement client down
 * when the tab is hidden or the window loses focus and tells only the ones still pending, so an
 * established watch dies in silence with `watchingAdvertisements` still reading true over it. An
 * advertisement arriving is the only evidence a watch is alive, which is why the ladder below is
 * driven by silence and why the page being in front is a condition of arming at all.
 *
 * The handle is held for as long as the scan runs and is never GATT-connected: connecting would
 * stop the controller advertising, which is the one thing this class is for.
 *
 * The chooser tap is owed once and not once a page load. `watchAdvertisements` needs no user
 * gesture on a device this origin is already permitted to talk to, and `getDevices()` turns a
 * remembered id back into that device — so `resume` is the same watch reached without the dialog,
 * and the chooser is left for the press that first has to be told which controller is yours.
 */

import { browserPageActivity } from '../../application/pageActivity'
import type { PageActivity } from '../../application/pageActivity'
import { parseAdvertisementKey } from '../../domain/solar/advertisement'
import { VICTRON_COMPANY_ID } from '../../domain/solar/types'
import { watchAdvertisementsSupported } from './capabilities'
import { ReconnectRefusedError } from './ReconnectRefusedError'
import { SolarAdvertisementProcessor } from './solarScan'
import type { SolarScan, VictronHandlers } from './solarScan'

/**
 * How long a watch may say nothing before it is treated as stalled rather than merely quiet, and
 * how much longer each time the replacement says nothing either.
 *
 * Three seconds first, because a controller in range broadcasts about once a second: three of them
 * missed is a stalled watch and not a pause, and a fresh watch on a controller that is there
 * delivers within about a second of being asked for. That is the common failure and it is worth
 * answering quickly. An empty berth is answered by waiting longer each time, up to half a minute,
 * because nothing there is going to change inside three seconds.
 *
 * The growth pays for itself in an empty berth, but it is not what holds the quota: the ladder only
 * ever climbs in silence, and an arriving advertisement puts it back on the first rung. The budget
 * below is what holds it.
 */
const FIRST_REARM_MS = 3_000
const REARM_GROWTH = 2
const REARM_CEILING_MS = 30_000
/** How often the ladder's deadline is compared against the clock. */
const REARM_CHECK_MS = 1_000
/**
 * The quota, kept as a rolling budget over the registrations actually spent.
 *
 * Android allows an app five BLE scan registrations per rolling thirty seconds and throttles the
 * sixth in silence — `BluetoothLeScanner` returns without reporting anything and without posting
 * SCAN_FAILED_SCANNING_TOO_FREQUENTLY — so a blackholed re-arm is indistinguishable from an empty
 * room, and a loop over quota silences itself precisely when it is trying hardest. Every
 * `watchAdvertisements()` call is one registration.
 *
 * Pacing alone cannot promise that. Left to the ladder the arithmetic reads well — armed at t=0 and
 * nothing ever arriving, re-arms fall at 3, 9, 21, 45 and every thirty seconds thereafter, four in
 * the busiest window — but it is conditioned on total silence. A controller at the edge of range is
 * heard every few seconds and not every second, and each of those arrivals is proof the watch is
 * alive and so puts the ladder back on its three-second rung. That is an ordinary berth, and it
 * would ask for a fresh watch every three seconds forever. So the bound is enforced where it is
 * stated rather than inferred from a cadence: a re-arm that would be one registration too many
 * inside the window waits until the oldest of them ages out of it.
 *
 * Four rather than five, because the pack's own sighting watch registers on the same radio. The two
 * do not simply add — Chromium keeps one discovery session for every `watchAdvertisements` client
 * in a document, so a re-arm reaches the platform scanner only when the watch it replaces was the
 * last client standing — and the slot left free is the margin for the times it is.
 *
 * A press of the owner's own is counted but never deferred: an answer to a gesture that arrived
 * half a minute later would be no answer. And the record outlives stop(), because the platform's
 * window does not restart just because this page did.
 */
const REARM_BUDGET = 4
const REARM_BUDGET_WINDOW_MS = 30_000

const NO_WATCH_ROUTE =
  'This browser cannot watch Bluetooth advertisements. ' +
  'Enable chrome://flags/#enable-experimental-web-platform-features and reload.'

/** Whether `getDevices()` exists at all, which is what a resume turns a remembered id in through. */
function permittedDevicesListable(): boolean {
  const bluetooth = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined
  return bluetooth !== undefined && typeof bluetooth.getDevices === 'function'
}

/**
 * The remembered controller's handle, or a refusal naming which permission answer stopped us.
 *
 * These are the two questions the pack's own reconnect asks, in the controller's words, and the
 * distinction matters here for the same reason it does there: a device missing from `getDevices()`
 * says nothing whatever about range. The list is what this origin is permitted to talk to, so an
 * absence is permission gone and one chooser tap fixes it, where no amount of patience would.
 */
async function permittedController(deviceId: string | null): Promise<BluetoothDevice> {
  if (deviceId === null) {
    throw new ReconnectRefusedError(
      'permission-gone',
      'This browser has not been shown the controller yet. Press Connect solar and pick it from the list.',
    )
  }
  const bluetooth = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined
  if (!bluetooth || typeof bluetooth.getDevices !== 'function') {
    throw new ReconnectRefusedError(
      'browser-cannot-rejoin',
      'This browser cannot start the watch without the chooser. Press Connect solar.',
    )
  }
  let permitted: readonly BluetoothDevice[]
  try {
    permitted = await bluetooth.getDevices()
  } catch {
    throw new ReconnectRefusedError(
      'browser-cannot-rejoin',
      'This browser would not list its permitted devices. Press Connect solar.',
    )
  }
  const device = permitted.find((candidate) => candidate.id === deviceId)
  if (!device) {
    throw new ReconnectRefusedError(
      'permission-gone',
      'This browser no longer has permission for the last controller. Press Connect solar to pick it again.',
    )
  }
  return device
}

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
  private readonly pageActivity: PageActivity
  private device: BluetoothDevice | null = null
  private watch: AbortController | null = null
  private running = false
  /** When the ladder's next re-arm falls due, and the wait it will have served when it does. */
  private nextRearmAt = 0
  private rearmGapMs = FIRST_REARM_MS
  /**
   * When each `watchAdvertisements()` of the recent past was asked for, which is what the budget is
   * counted over. Pruned as it is read, so it holds at most a window's worth.
   */
  private recentRegistrations: number[] = []
  private silenceTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribeFromPage: (() => void) | null = null
  /** Mirrors JkBmsClient's attachToken: a re-arm superseded by stop() must not resurrect. */
  private watchToken = 0
  /**
   * The same guard one level up. `start` parks on the chooser for as long as the user takes to
   * answer it, and Cancel is on screen throughout — a stop() during that wait must not be undone
   * when Allow finally resolves the promise, or the scanner comes back with nothing able to reach
   * it and every advertisement is reported twice.
   */
  private startToken = 0

  constructor(handlers: VictronHandlers = {}, pageActivity: PageActivity = browserPageActivity()) {
    this.handlers = handlers
    // One chooser-picked handle and nothing else, so an advertisement that will not decode here
    // is this boat's controller saying something about itself.
    this.processor = new SolarAdvertisementProcessor(handlers, 'this-controller')
    this.pageActivity = pageActivity
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
      throw new Error(NO_WATCH_ROUTE)
    }

    const token = this.startToken
    const device = await navigator.bluetooth.requestDevice(watchChooserOptions())
    // Nothing is on the instance yet, so a stop() during the chooser leaves nothing to undo.
    if (token !== this.startToken) return

    await this.watchDevice(device, keyHex, token)
  }

  canResume(rememberedDeviceId: string | null): boolean {
    return (
      rememberedDeviceId !== null && watchAdvertisementsSupported() && permittedDevicesListable()
    )
  }

  /**
   * The same watch, reached without the chooser. No gesture is needed and none is spent, so unlike
   * `start` this path is free to await whatever it likes before the radio is touched.
   */
  async resume(keyHex: string, rememberedDeviceId: string | null): Promise<void> {
    this.stop()
    parseAdvertisementKey(keyHex)

    if (!watchAdvertisementsSupported()) throw new Error(NO_WATCH_ROUTE)

    const token = this.startToken
    const device = await permittedController(rememberedDeviceId)
    if (token !== this.startToken) return

    await this.watchDevice(device, keyHex, token)
  }

  /**
   * Everything both routes do once a device is in hand, which is all of it bar how the handle was
   * come by. The key is imported here rather than ahead of the device, so on the chooser path it
   * cannot spend the click's transient activation before `requestDevice` has asked for it. The
   * listener goes on last, once the processor is ready to decode.
   */
  private async watchDevice(device: BluetoothDevice, keyHex: string, token: number): Promise<void> {
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
    // The browser takes its time bringing a watch up and Stop is on screen throughout. A stop()
    // that landed in that window has already torn all of this down, so there is nothing left to
    // undo — but pacing a scan nobody has, or naming the controller as one worth going back to,
    // would put back the very thing the press asked to be rid of.
    if (token !== this.startToken) return

    this.silenceTimer = setInterval(this.checkSilence, REARM_CHECK_MS)
    this.unsubscribeFromPage = this.pageActivity.subscribe(this.handlePageChange)
    // Reported only once a watch has genuinely come up on this handle. The id is permission rather
    // than presence, so nothing waits for the controller to speak — but a device this browser
    // could not watch is not one worth going back to without the chooser.
    this.handlers.onWatchedDevice?.(device.id, device.name ?? null)
  }

  stop(): void {
    // Advance the generation so a decode already in flight is dropped when it resolves, and bump
    // the tokens so an arm() still waiting on the browser, or a start() still waiting on the
    // chooser, unwinds instead of resurrecting the scan.
    this.running = false
    this.watchToken += 1
    this.startToken += 1
    // A fresh scan on this instance is owed the quick first rung, not whatever the last one had
    // climbed to over an afternoon in an empty berth.
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
    // Give the fresh watch this rung's whole silence window before it can be judged stalled, and
    // stand the next rung up behind it. Stamped here rather than on the reply, because the browser
    // takes its own time saying yes and that time is the watch's, not the ladder's.
    const askedAt = Date.now()
    this.recentRegistrations.push(askedAt)
    this.nextRearmAt = askedAt + this.rearmGapMs
    this.rearmGapMs = Math.min(this.rearmGapMs * REARM_GROWTH, REARM_CEILING_MS)
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
    // Chromium has already destroyed this watch — hidden tab or unfocused window, both, silently —
    // and it will destroy the next one as fast as we ask for it. Asking anyway spends a scan
    // registration nothing can reach, and on Android spends it out of the same quota the owner
    // will need the moment they come back.
    if (!this.pageIsInFront()) return
    const now = Date.now()
    if (now < this.nextRearmAt) return
    // Due, but the window may already be full. Deferring to the moment it is not is the whole of
    // the bound, and the only place it is decided: the ladder's deadline is pulled back to the
    // first rung by every arriving advertisement and by the page coming to the front, so nothing
    // about the cadence alone can promise the quota is kept.
    const allowedAt = this.nextRegistrationAllowedAt(now)
    if (allowedAt > now) {
      this.nextRearmAt = allowedAt
      return
    }
    // Off the user's own call stack, so a re-arm failure has no caller to reject to.
    void this.arm().catch((error: Error) => this.handlers.onError?.(error))
  }

  /**
   * When the budget has room for another registration: now, unless the window is already full, in
   * which case it is the moment the oldest registration still inside it ages out.
   */
  private nextRegistrationAllowedAt(now: number): number {
    this.recentRegistrations = this.recentRegistrations.filter((moment) => moment > now - REARM_BUDGET_WINDOW_MS)
    const spent = this.recentRegistrations.length
    if (spent < REARM_BUDGET) return now
    return this.recentRegistrations[spent - REARM_BUDGET] + REARM_BUDGET_WINDOW_MS
  }

  private pageIsInFront(): boolean {
    return this.pageActivity.visible() && this.pageActivity.focused()
  }

  /**
   * The page went away or came back. Only the coming back is acted on, and only by putting the
   * ladder back on its first rung: the watch this scanner is holding was destroyed the moment the
   * window lost focus, whatever `watchingAdvertisements` still claims, so an owner returning to a
   * scan that had climbed to the ceiling would sit in front of a dead watch for half a minute.
   *
   * The deadline is set from now rather than pulled back to it, so a window being dragged about
   * cannot ask for watches faster than the ladder's first rung allows — and the budget is what
   * holds even that to something the platform will honour.
   */
  private readonly handlePageChange = (): void => {
    if (!this.running || !this.pageIsInFront()) return
    this.restartLadder()
  }

  /** Back to the quick first rung, with its whole wait ahead of it. */
  private restartLadder(): void {
    this.rearmGapMs = FIRST_REARM_MS
    this.nextRearmAt = Date.now() + FIRST_REARM_MS
  }

  private readonly handleAdvertisement = (event: Event): void => {
    const advertisement = event as BluetoothAdvertisingEvent
    // Reset before the company-id check: any advertisement at all proves the watch is alive, while
    // only a decoded one proves the controller is. The processor's own staleness clock answers that
    // second question, and conflating them would set the re-arm loop fighting it.
    this.restartLadder()

    const view = advertisement.manufacturerData.get(VICTRON_COMPANY_ID)
    if (!view) return

    const payload = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    this.processor.ingest(payload, advertisement.rssi ?? 0)
  }
}
