/**
 * Rejoining the pack without being asked, whether or not the owner is looking at the page.
 *
 * The policy lives here and the mechanics live in the radio, which is the only split that makes
 * either testable: `BmsLink.reconnect` goes as far as its caller says it may, waits for exactly as
 * long as it is allowed, and has no opinion about when to try again; this has no idea how a GATT
 * link is made. What it owns is the schedule — when an attempt may start, how patient it may be,
 * what a failure costs, and when to let go of one already running.
 *
 * Every attempt is this loop's, the owner's presses included. `tryNow` is a press asking for one
 * sooner rather than a second way of making one, so a press inherits the deadline, the abort and
 * the token that bound an automatic attempt, and cannot open a rival beside the scheduled one.
 * There is exactly one place where an attempt is born and exactly one where its failure is priced.
 *
 * Four conditions gate every attempt this loop makes of its own accord, and the page being in front
 * is not one of them. What the page decides is how an attempt is made and how often, never whether.
 * Chromium kills an advertisement watch the moment the tab is hidden or the window loses focus,
 * silently, so behind another window the loop asks for the half that survives — the straight attach,
 * which needs no focus and is answered in seconds — and it asks for it on a slower cadence, because
 * nobody is reading the page and a hidden tab's timers are throttled to about a minute anyway. A
 * GATT link, once made, is not touched by focus at all, so a probe that lands puts the boat back on
 * screen for an owner who was working in another application the whole time.
 *
 * Five things put the question again, and each of them RESETS the ladder, because each is new
 * information: the radio coming on, the tab changing, the window gaining or losing focus, the link
 * dropping, and the owner arming the intent. A timer running out is not new information, so the
 * delay it just waited out stands and the next one is longer.
 *
 * Nothing in here writes a banner. A pack out of range is the ordinary case on a boat and it is
 * answered by trying again, quietly, for as long as it takes; only the three answers in
 * `RejoinBlocker` are worth interrupting the owner for, and they are reported as state rather than
 * as an error.
 */

import { readonly, ref } from 'vue'

import type { ReconnectPatience } from '../infrastructure/ble/ReconnectPatience'
import { ReconnectRefusedError } from '../infrastructure/ble/ReconnectRefusedError'
import type { LastDevice } from './lastDevice'
import type { PageActivity } from './pageActivity'
import type { RejoinBlocker } from './RejoinBlocker'
import type { CancelScheduled, Schedule } from './schedule'

/**
 * The attempt in flight, as the rest of the loop needs to see it: the way to let go of it, and the
 * way to be told how it ended. The outcome is held because a press is owed an answer — the loop's
 * own attempts answer themselves through `searching` and the backoff.
 */
interface StandingAttempt {
  readonly abandon: AbortController
  readonly outcome: Promise<void>
  /** What it was allowed to do, which is the one thing about it the page can invalidate. */
  readonly patience: ReconnectPatience
}

/**
 * What the first failure costs, before doubling.
 *
 * The three below are the ladder both radios wait on. They are exported rather than restated in
 * the controller's own supervisor because there is one reason for either radio to wait — the boat
 * has not answered yet — and two ladders would be two behaviours to explain and to keep in step.
 */
export const FIRST_RETRY_MS = 1_000
export const RETRY_GROWTH = 2
/** The longest the ladder ever grows to. A boat that has drifted out of range comes back within one. */
export const RETRY_CEILING_MS = 30_000

/**
 * How long one attempt may run before it is abandoned and counted as a failure.
 *
 * The link waits for a sighting for as long as it is allowed to, so without a deadline the first
 * attempt would park forever and the backoff below would never be reached. A pack in range
 * advertises several times a second; one that has said nothing in fifteen is not there, and the
 * radio is better spent starting the watch again from the top than holding a dead one open. A probe
 * carries a shorter budget of its own inside the radio and is answered long before this, so what
 * this deadline really bounds is the wait to be heard.
 */
const ATTEMPT_DEADLINE_MS = 15_000

/**
 * The least time between the start of one attempt and the start of the next.
 *
 * The triggers are events the platform can repeat at speed — a radio that flaps, a window raised
 * across two monitors reporting visibility and focus and adapter state within a millisecond of
 * each other — and each of them resets the backoff. Without a floor a flapping trigger would hold
 * the loop at zero delay and hammer the radio; with one, the burst still gets a fresh look, just
 * not a hundred of them.
 */
export const MINIMUM_GAP_MS = 1_000

/**
 * The gap between probes while the page is behind another window, which stands outside the ladder
 * rather than on top of it.
 *
 * A minute, and flat. Chromium throttles a hidden tab's timers to roughly once a minute after about
 * five minutes away, so a faster ladder here would mostly be a fiction the platform declines to
 * honour, and asking for the rate the platform will actually deliver is the difference between a
 * schedule and a hope. It is slower than the ladder's own ceiling because nobody is watching the
 * page to be kept waiting, and because each probe is a connect attempt spent on a pack that may
 * simply not be there. It does not grow: a probe learns the same thing every time it fails, and
 * this is a boat, where the pack coming back is worth more than the handful of connects it costs to
 * go on asking.
 */
const BEHIND_A_WINDOW_RETRY_MS = 60_000

export interface RejoinSupervisorDeps {
  /** The owner's standing answer, read at every decision and never cached. */
  readonly rejoinArmed: () => boolean
  /** Whether this browser can rejoin a permitted pack without the chooser at all. */
  readonly canRejoinWithoutChooser: boolean
  /** Whether the radio is on. Null is the browser refusing to say, which is not a reason to try. */
  readonly adapterOn: () => boolean | null
  readonly rememberedPack: () => LastDevice | null
  /** Whether a link is already up, or a press is already making one. */
  readonly linkBusy: () => boolean
  /**
   * One attempt at the remembered pack, on the terms this loop names: `patience` says whether the
   * radio may wait to hear the pack or must go straight in and report what it finds. Resolves only
   * on a live link; rejects with a `ReconnectRefusedError` when the radio was never asked, and with
   * anything else when the pack did not answer. Aborting the signal must reject rather than resolve.
   */
  readonly rejoinPack: (
    deviceId: string,
    signal: AbortSignal,
    patience: ReconnectPatience,
  ) => Promise<void>
  /** Lets go of a link whose owner disarmed the intent while the attempt making it was in flight. */
  readonly releaseLink: () => Promise<void>
  readonly pageActivity: PageActivity
  readonly schedule: Schedule
  readonly now: () => number
}

export function createRejoinSupervisor(deps: RejoinSupervisorDeps) {
  /** True from the first attempt until the loop has nothing left to do — backoff waits included. */
  const searching = ref(false)
  const blocker = ref<RejoinBlocker | null>(null)

  let running = false
  let unsubscribeFromPage: (() => void) | null = null
  let cancelPendingLook: CancelScheduled | null = null
  let standingAttempt: StandingAttempt | null = null
  /**
   * Which attempt is the current one. An attempt that settles after it was stood down or replaced
   * carries a stale token and is dropped where it lands, so a link nobody wants any more cannot
   * flip state under the one that does.
   */
  let attemptToken = 0
  let retryDelayMs = FIRST_RETRY_MS
  let lastAttemptStartedAt = Number.NEGATIVE_INFINITY

  function start(): void {
    if (running) return
    running = true
    unsubscribeFromPage = deps.pageActivity.subscribe(reconsider)
    reconsider()
  }

  /** Hands back the radio and the timer. The intent is untouched: this is a page going away. */
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
    if (!mayTry()) {
      standDown()
      return
    }
    if (standingAttempt !== null) {
      // An attempt already running is the answer to this question; a second one over the top of it
      // would fight the first for the single link the pack allows. The exception is an attempt
      // whose terms the page has since withdrawn, and it is let go of here rather than left to run
      // out a deadline it can no longer do anything with.
      if (!strandedByThePageGoingBehind(standingAttempt)) return
      standDown()
    }
    if (deps.linkBusy()) {
      // The link is somebody else's for the moment — a chooser press making one, or one already up.
      // Neither is this loop's to interrupt and neither owes it a word when it is over, so the
      // question is put again shortly rather than parked on a wake-up nobody promised.
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
    const pack = deps.rememberedPack()
    // Nobody is waiting on an attempt the loop started for itself; what its failure costs has
    // already been settled inside it.
    if (pack !== null) void beginAttempt(pack)
  }

  /**
   * An attempt now, because the owner asked for one, settling exactly as it settles so the press
   * can be answered. A press that lands on an attempt already running joins that one: two
   * handshakes over the pack would fight for the single link it allows, and the second would be
   * bounded by nothing.
   *
   * The intent has to be armed before this is called. An attempt made under a disarmed intent is
   * let go of the moment it comes up, which is the opposite of what a press asked for.
   */
  function tryNow(): Promise<void> {
    // A press is better information than whatever failures built the wait up.
    retryDelayMs = FIRST_RETRY_MS
    const standing = standingAttempt
    if (standing !== null) return standing.outcome
    cancelPendingLook?.()
    cancelPendingLook = null
    reportBlocker()
    const pack = deps.rememberedPack()
    if (pack === null || deps.linkBusy()) return Promise.resolve()
    return beginAttempt(pack)
  }

  function mayTry(): boolean {
    return (
      deps.rejoinArmed() &&
      deps.adapterOn() === true &&
      deps.canRejoinWithoutChooser &&
      deps.rememberedPack() !== null
    )
  }

  function pageIsInFront(): boolean {
    return deps.pageActivity.visible() && deps.pageActivity.focused()
  }

  /**
   * What an attempt started right now may do.
   *
   * Behind another window there is no watch to be had: Chromium tears every one of them down when
   * the tab is hidden or the window loses focus, and fires nothing to say so. Arming one there is
   * worse than useless — on Android each arming spends one of the five registrations the platform
   * allows per thirty seconds, throttled silently, so a background loop that kept asking would
   * blackhole the watch the owner needs when they come back to the page.
   */
  function patienceThePageAllows(): ReconnectPatience {
    return pageIsInFront() ? 'wait-for-a-sighting' : 'straight-in-only'
  }

  /**
   * Whether the attempt in flight is now waiting on something that can never arrive.
   *
   * Only in that one direction. A probe running when the owner brings the window forward is still a
   * link being made, and standing it down would throw away a handshake that is most of the way
   * home; the ladder it is followed by is fast again from the next look onwards either way.
   */
  function strandedByThePageGoingBehind(attempt: StandingAttempt): boolean {
    return attempt.patience === 'wait-for-a-sighting' && !pageIsInFront()
  }

  /**
   * What the owner would have to do about it, when there is anything to be done. A disarmed
   * supervisor and a browser with no pack to go back to are silent: neither is a fault, and a page
   * that has never connected must not open with a complaint about permissions.
   *
   * `permission-gone` is the one answer only an attempt can give, so whatever the last one said
   * stands until an attempt — or a link that is up, which settles the question by existing — says
   * otherwise.
   */
  function reportBlocker(): void {
    if (!deps.rejoinArmed() || deps.rememberedPack() === null) {
      blocker.value = null
      return
    }
    // A blocker is a claim about right now, and a link that is up or coming up contradicts every
    // one of them. The chooser is how a lapsed permission is answered and it runs no attempt
    // through here, so without this nothing would ever take the claim back.
    if (deps.linkBusy()) {
      blocker.value = null
      return
    }
    if (!deps.canRejoinWithoutChooser) {
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
   * Lets go of whatever is in flight without costing anything. Superseding the token is what makes
   * the abandoned attempt harmless when it finally unwinds, and it is also what keeps a deliberate
   * stand-down out of the backoff: this is the page being put away, not the pack refusing.
   */
  function standDown(): void {
    cancelPendingLook?.()
    cancelPendingLook = null
    attemptToken += 1
    standingAttempt?.abandon.abort()
    standingAttempt = null
    searching.value = false
  }

  /**
   * Starts an attempt and takes the whole of its life on: one deadline, one abort, one place that
   * decides what its failure costs. Every attempt is born here, so there is no way to be holding an
   * attempt that nothing bounds.
   */
  function beginAttempt(pack: LastDevice): Promise<void> {
    const token = (attemptToken += 1)
    const abandon = new AbortController()
    const giveUp = deps.schedule(() => abandon.abort(), ATTEMPT_DEADLINE_MS)
    const patience = patienceThePageAllows()
    lastAttemptStartedAt = deps.now()
    searching.value = true

    // `settleAttempt` is async, so its tail cannot run before the record below is written, however
    // the radio answers.
    const outcome = settleAttempt(token, pack, abandon.signal, patience).finally(() => {
      giveUp()
      if (token === attemptToken) standingAttempt = null
    })
    standingAttempt = { abandon, outcome, patience }
    // Only a press waits on this. A failure the loop asked for on its own account is already priced
    // and would otherwise stand as an unhandled rejection.
    void outcome.catch(() => undefined)
    return outcome
  }

  async function settleAttempt(
    token: number,
    pack: LastDevice,
    signal: AbortSignal,
    patience: ReconnectPatience,
  ): Promise<void> {
    try {
      await deps.rejoinPack(pack.id, signal, patience)
    } catch (error) {
      priceFailure(token, error as Error)
      throw error
    }
    noteLinkIsUp(token)
  }

  function noteLinkIsUp(token: number): void {
    // Whether the link is still wanted is a different question from whether this attempt is still
    // the current one, and it is asked first: Disconnect pressed while the radio was finishing the
    // handshake stands the attempt down, but an abort that arrives too late to stop it would
    // otherwise leave the owner holding a link they asked not to have.
    if (!deps.rejoinArmed()) {
      void deps.releaseLink()
      return
    }
    if (token !== attemptToken) return
    searching.value = false
    blocker.value = null
    retryDelayMs = FIRST_RETRY_MS
  }

  function priceFailure(token: number, error: Error): void {
    // A superseded attempt is one the loop already walked away from, whatever it rejected with: it
    // says nothing about the pack, and it must not lengthen the next wait.
    if (token !== attemptToken) return
    if (error instanceof ReconnectRefusedError) {
      blocker.value = error.refusal
      searching.value = false
      return
    }
    scheduleRetry()
  }

  function scheduleRetry(): void {
    if (!running) {
      // Nothing is watching the page, so nothing will put the question again. Going on saying it is
      // looking would be a promise this loop has no way of keeping.
      searching.value = false
      return
    }
    cancelPendingLook?.()
    // `look` and not `reconsider`: a timer running out has learned nothing, so the wait it just
    // served stands and the next one is longer.
    cancelPendingLook = deps.schedule(look, priceOfThisFailure())
  }

  /**
   * What the failure just priced costs in waiting, and what it does to the ladder.
   *
   * The ladder is the foreground's alone, and a failure behind a window leaves it exactly where it
   * was. A probe that found nothing says only that the pack is not in the adapter map, which is what
   * every probe before it said, so there is nothing there to double — and an owner coming back to
   * the page would inherit a wait built out of attempts they never saw.
   */
  function priceOfThisFailure(): number {
    if (!pageIsInFront()) return BEHIND_A_WINDOW_RETRY_MS
    const delayMs = retryDelayMs
    retryDelayMs = Math.min(retryDelayMs * RETRY_GROWTH, RETRY_CEILING_MS)
    return delayMs
  }

  return {
    searching: readonly(searching),
    blocker: readonly(blocker),
    start,
    stop,
    reconsider,
    tryNow,
  }
}
