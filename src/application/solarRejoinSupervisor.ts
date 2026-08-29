/**
 * Putting the controller's watch back up without being asked, on the same terms the pack rejoins.
 *
 * It is a sibling of `rejoinSupervisor` rather than a second instance of it because the two radios
 * fail differently and so must wait differently. A pack that does not answer leaves the loop with
 * nothing to show for the attempt, which is what the deadline and the token there are for; a watch
 * either comes up or does not, in one call, and a controller that is merely out of range is
 * answered by the watch sitting there listening rather than by trying again. What the two do share
 * is the whole of the schedule — the gates, the ladder, and the page being in front — so the ladder
 * is imported from the pack's supervisor and the page is one object handed to both.
 *
 * Their standing down together is the point of that sharing. The pack's rejoin watches
 * advertisements for a sighting and this watches them for a reading, and two advertisement watches
 * on one adapter is the worst thing this app can ask of a phone's battery. Chromium tears both down
 * the moment the page is hidden or the window loses focus, silently, so a watch left armed behind
 * another window is not a link — it is a radio burning for nothing. When the page goes away the
 * watch goes with it, and comes back when the page does.
 *
 * What decides whether a running scan may be handed back is not who started it but whether this
 * loop can put it up again: the chooser's own watch dies behind another window exactly as an
 * automatic one does, and taking down a scan we could not restore would be the app deciding it knew
 * better. So a route with nothing to come back to — the browser's own scan, which needs its
 * permission prompt however many times it has been answered — is left running and left alone.
 *
 * Nothing in here writes a banner either, for the reason the pack's supervisor does not: a
 * controller asleep at sunset is the ordinary case, not a fault.
 */

import { readonly, ref } from 'vue'

import { ReconnectRefusedError } from '../infrastructure/ble/ReconnectRefusedError'
import type { LastController } from './lastController'
import type { PageActivity } from './pageActivity'
import type { RejoinBlocker } from './RejoinBlocker'
import {
  FIRST_RETRY_MS,
  MINIMUM_GAP_MS,
  RETRY_CEILING_MS,
  RETRY_GROWTH,
} from './rejoinSupervisor'
import type { CancelScheduled, Schedule } from './schedule'

export interface SolarRejoinSupervisorDeps {
  /** The owner's standing answer about going back to the boat, read at every decision. */
  readonly rejoinArmed: () => boolean
  /** Whether the radio is on. Null is the browser refusing to say, which is not a reason to try. */
  readonly adapterOn: () => boolean | null
  readonly rememberedController: () => LastController | null
  /**
   * Whether the key is held. Asked as a question rather than taken as a value, because the key
   * itself has no business leaving the one module that stores it.
   */
  readonly advertisementKeyStored: () => boolean
  /** Whether the route this browser would take could come up with no gesture at all. */
  readonly canResume: (rememberedDeviceId: string | null) => boolean
  /** Whether a scan is already up, or a press is already starting one. */
  readonly solarBusy: () => boolean
  /**
   * One attempt at the remembered controller. Resolves once the watch is armed — which says
   * nothing about the controller being in range, and is not meant to. Rejects with a
   * `ReconnectRefusedError` when the radio was never asked.
   */
  readonly resumeSolar: (rememberedDeviceId: string | null) => Promise<void>
  /** Hands the radio back when the page goes away. Only ever called on a watch that can come back. */
  readonly standDownSolar: () => void
  readonly pageActivity: PageActivity
  readonly schedule: Schedule
  readonly now: () => number
}

export function createSolarRejoinSupervisor(deps: SolarRejoinSupervisorDeps) {
  /** True from the first attempt until the loop has nothing left to do — backoff waits included. */
  const searching = ref(false)
  const blocker = ref<RejoinBlocker | null>(null)

  let running = false
  let unsubscribeFromPage: (() => void) | null = null
  let cancelPendingLook: CancelScheduled | null = null
  /**
   * Which attempt is the current one. A resume that settles after the loop walked away from it
   * carries a stale token and is dropped where it lands, so a watch nobody wants any more cannot
   * flip state under the one that does.
   */
  let attemptToken = 0
  let attemptInFlight = false
  let retryDelayMs = FIRST_RETRY_MS
  let lastAttemptStartedAt = Number.NEGATIVE_INFINITY

  function start(): void {
    if (running) return
    running = true
    unsubscribeFromPage = deps.pageActivity.subscribe(reconsider)
    reconsider()
  }

  /**
   * Hands back the timer and stops watching the page. The radio is left exactly as it is: this is
   * the app going away, and a page being torn down has no business stopping a scan the owner may
   * be reading a number off as it goes.
   */
  function stop(): void {
    if (!running) return
    running = false
    unsubscribeFromPage?.()
    unsubscribeFromPage = null
    standDown()
    blocker.value = null
  }

  /**
   * Something changed that could make an attempt worth making — or worth abandoning. The backoff
   * goes back to its first step, because whatever happened is a better reason to try than the
   * failures that built it up.
   */
  function reconsider(): void {
    retryDelayMs = FIRST_RETRY_MS
    look()
  }

  function look(): void {
    cancelPendingLook?.()
    cancelPendingLook = null
    if (!running) return

    reportBlocker()
    // First and on its own, because it is the one thing here that is not about starting a watch.
    // A page that has gone behind something else cannot hold one, so the radio comes back now
    // rather than at whatever later moment the rest of the gates happen to agree.
    if (!pageIsInFront()) releaseWatchThePageCannotHold()
    if (!mayResume()) {
      standDown()
      return
    }
    if (attemptInFlight) return
    if (deps.solarBusy()) {
      // The radio is somebody else's for the moment — a press putting a watch up, or one already
      // listening. Neither is this loop's to interrupt and neither owes it a word when it is over,
      // so the question is put again shortly rather than parked on a wake-up nobody promised.
      searching.value = false
      cancelPendingLook = deps.schedule(look, MINIMUM_GAP_MS)
      return
    }

    const sinceLastAttempt = deps.now() - lastAttemptStartedAt
    if (sinceLastAttempt < MINIMUM_GAP_MS) {
      // Still on the job, and saying so: the gap is this supervisor pacing itself, not a pause the
      // owner should be shown as having stopped looking.
      searching.value = true
      cancelPendingLook = deps.schedule(look, MINIMUM_GAP_MS - sinceLastAttempt)
      return
    }
    void attemptResume()
  }

  function pageIsInFront(): boolean {
    return deps.pageActivity.visible() && deps.pageActivity.focused()
  }

  function mayResume(): boolean {
    return pageIsInFront() && whatItTakesToResume()
  }

  /**
   * Everything bar the page being in front, which is asked on its own either side of this.
   *
   * Whether there is a controller to go back to is settled here rather than left to the transport.
   * `canResume` answers for the route alone — whether it could come up with no gesture — and the
   * bridge, a WebSocket with no device handle anywhere in it, answers yes whatever the owner has
   * just pressed. Stop solar means forgetting the controller, so this is where that has to bite,
   * and it is the same gate the pack's own supervisor puts on a remembered pack.
   */
  function whatItTakesToResume(): boolean {
    return (
      deps.rejoinArmed() &&
      deps.adapterOn() === true &&
      deps.advertisementKeyStored() &&
      rememberedId() !== null &&
      deps.canResume(rememberedId())
    )
  }

  function rememberedId(): string | null {
    return deps.rememberedController()?.id ?? null
  }

  /**
   * What the owner would have to do about it, when there is anything to be done. A browser holding
   * no key and one that has never been shown a controller are both silent: neither is a fault, and
   * a page that has never watched anything must not open with a complaint about permissions.
   *
   * `permission-gone` is the one answer only an attempt can give, so whatever the last one said
   * stands until an attempt — or a watch that is up, which settles the question by existing — says
   * otherwise.
   */
  function reportBlocker(): void {
    if (!deps.rejoinArmed() || !deps.advertisementKeyStored() || rememberedId() === null) {
      blocker.value = null
      return
    }
    // A blocker is a claim about right now, and a watch that is up or coming up contradicts every
    // one of them. Connect solar is how a lapsed permission is answered and it runs no attempt
    // through here, so without this nothing would ever take the claim back.
    if (deps.solarBusy()) {
      blocker.value = null
      return
    }
    if (!deps.canResume(rememberedId())) {
      blocker.value = 'browser-cannot-rejoin'
      return
    }
    if (deps.adapterOn() === false) {
      blocker.value = 'radio-off'
      return
    }
    if (blocker.value !== 'permission-gone') blocker.value = null
  }

  /**
   * Lets go of whatever is pending without costing anything. Superseding the token is what makes an
   * abandoned attempt harmless when it finally unwinds, and it is also what keeps a deliberate
   * stand-down out of the backoff: this is a gate closing, not the controller refusing.
   */
  function standDown(): void {
    cancelPendingLook?.()
    cancelPendingLook = null
    attemptToken += 1
    attemptInFlight = false
    searching.value = false
  }

  /**
   * The battery measure. A remembered controller on a route that can resume is a watch this loop
   * will have back up within a second of the page returning, so holding it open behind another
   * window buys the owner nothing and costs them the radio. Anything else is left running.
   */
  function releaseWatchThePageCannotHold(): void {
    // Never take what this loop could not give back. An owner who has pressed Disconnect or Stop
    // solar, or a browser holding no key, would be left with a dead solar link and nothing on
    // screen to say why — where a watch left running behind a window is at worst a fiction the
    // platform has already made true.
    if (!whatItTakesToResume()) return
    if (deps.solarBusy()) deps.standDownSolar()
  }

  async function attemptResume(): Promise<void> {
    const token = (attemptToken += 1)
    attemptInFlight = true
    lastAttemptStartedAt = deps.now()
    searching.value = true

    try {
      await deps.resumeSolar(rememberedId())
      if (token !== attemptToken) return
      // The watch is up, which is as far as this loop's business goes: whether the controller is
      // there to hear is the staleness clock's question and it is already asking it.
      searching.value = false
      blocker.value = null
      retryDelayMs = FIRST_RETRY_MS
    } catch (error) {
      // A superseded attempt is one the loop already walked away from, whatever it rejected with:
      // it says nothing about the controller, and it must not lengthen the next wait.
      if (token !== attemptToken) return
      if (error instanceof ReconnectRefusedError) {
        blocker.value = error.refusal
        searching.value = false
        return
      }
      scheduleRetry()
    } finally {
      if (token === attemptToken) attemptInFlight = false
    }
  }

  function scheduleRetry(): void {
    if (!running) {
      // Nothing is watching the page, so nothing will put the question again. Going on saying it is
      // listening would be a promise this loop has no way of keeping.
      searching.value = false
      return
    }
    const delayMs = retryDelayMs
    retryDelayMs = Math.min(retryDelayMs * RETRY_GROWTH, RETRY_CEILING_MS)
    cancelPendingLook?.()
    // `look` and not `reconsider`: a timer running out has learned nothing, so the wait it just
    // served stands and the next one is longer.
    cancelPendingLook = deps.schedule(look, delayMs)
  }

  return {
    searching: readonly(searching),
    blocker: readonly(blocker),
    start,
    stop,
    reconsider,
  }
}
