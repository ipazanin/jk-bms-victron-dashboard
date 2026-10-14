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

export const SOLAR_RESUME_TIMEOUT_MS = 15_000

export interface SolarRejoinSupervisorDeps {
  readonly rejoinArmed: () => boolean
  readonly adapterOn: () => boolean | null
  readonly rememberedController: () => LastController | null
  readonly advertisementKeyStored: () => boolean
  readonly canResume: (rememberedDeviceId: string | null) => boolean
  readonly canEverResume: () => boolean
  readonly resumeAvailableAt: () => number
  readonly solarBusy: () => boolean
  readonly historySweepHoldsRadio: () => boolean
  readonly resumeSolar: (rememberedDeviceId: string | null, signal: AbortSignal) => Promise<void>
  readonly standDownSolar: () => void
  readonly pageActivity: PageActivity
  readonly schedule: Schedule
  readonly now: () => number
}

export function createSolarRejoinSupervisor(deps: SolarRejoinSupervisorDeps) {
  const searching = ref(false)
  const blocker = ref<RejoinBlocker | null>(null)

  let running = false
  let unsubscribeFromPage: (() => void) | null = null
  let cancelPendingLook: CancelScheduled | null = null
  let attemptToken = 0
  let attemptInFlight = false
  let attemptController: AbortController | null = null
  let cancelAttemptDeadline: CancelScheduled | null = null
  let retryDelayMs = FIRST_RETRY_MS
  let lastAttemptStartedAt = Number.NEGATIVE_INFINITY

  function start(): void {
    if (running) return
    running = true
    unsubscribeFromPage = deps.pageActivity.subscribe(reconsider)
    reconsider()
  }

  function stop(): void {
    if (!running) return
    running = false
    unsubscribeFromPage?.()
    unsubscribeFromPage = null
    standDown()
    blocker.value = null
  }

  function reconsider(): void {
    retryDelayMs = FIRST_RETRY_MS
    look()
  }

  function look(): void {
    cancelPendingLook?.()
    cancelPendingLook = null
    if (!running) return

    reportBlocker()
    if (!pageIsInFront()) releaseWatchThePageCannotHold()
    if (!mayResume()) {
      standDown()
      return
    }
    if (attemptInFlight) return
    if (deps.solarBusy()) {
      searching.value = false
      cancelPendingLook = deps.schedule(look, MINIMUM_GAP_MS)
      return
    }

    const availableAt = Math.max(
      lastAttemptStartedAt + MINIMUM_GAP_MS,
      deps.resumeAvailableAt(),
    )
    const waitMs = availableAt - deps.now()
    if (waitMs > 0) {
      searching.value = true
      cancelPendingLook = deps.schedule(look, waitMs)
      return
    }
    void attemptResume()
  }

  function pageIsInFront(): boolean {
    return deps.pageActivity.visible() && deps.pageActivity.focused()
  }

  function mayResume(): boolean {
    return pageIsInFront() && !deps.historySweepHoldsRadio() && whatItTakesToResume()
  }

  function whatItTakesToResume(): boolean {
    return (
      deps.rejoinArmed() &&
      deps.adapterOn() !== false &&
      deps.advertisementKeyStored() &&
      rememberedId() !== null &&
      deps.canResume(rememberedId())
    )
  }

  function rememberedId(): string | null {
    return deps.rememberedController()?.id ?? null
  }

  function canRestoreTheWatch(): boolean {
    return running && whatItTakesToResume()
  }

  function reportBlocker(): void {
    if (!deps.rejoinArmed() || !deps.advertisementKeyStored()) {
      blocker.value = null
      return
    }
    if (deps.solarBusy()) {
      blocker.value = null
      return
    }
    if (!deps.canEverResume()) {
      blocker.value = 'browser-cannot-rejoin'
      return
    }
    if (rememberedId() === null) {
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

  function standDown(): void {
    cancelPendingLook?.()
    cancelPendingLook = null
    attemptToken += 1
    cancelAttemptDeadline?.()
    cancelAttemptDeadline = null
    const controller = attemptController
    attemptController = null
    attemptInFlight = false
    controller?.abort()
    searching.value = false
  }

  function releaseWatchThePageCannotHold(): void {
    if (!whatItTakesToResume()) return
    if (deps.solarBusy() || deps.historySweepHoldsRadio()) deps.standDownSolar()
  }

  async function attemptResume(): Promise<void> {
    const token = (attemptToken += 1)
    attemptInFlight = true
    const controller = new AbortController()
    attemptController = controller
    cancelAttemptDeadline = deps.schedule(() => {
      standDown()
      searching.value = true
      scheduleRetry()
    }, SOLAR_RESUME_TIMEOUT_MS)
    lastAttemptStartedAt = deps.now()
    searching.value = true

    try {
      await deps.resumeSolar(rememberedId(), controller.signal)
      if (token !== attemptToken) return
      searching.value = false
      blocker.value = null
      retryDelayMs = FIRST_RETRY_MS
    } catch (error) {
      if (token !== attemptToken) return
      if (error instanceof ReconnectRefusedError) {
        blocker.value = error.refusal
        searching.value = false
        return
      }
      scheduleRetry()
    } finally {
      if (token === attemptToken) {
        cancelAttemptDeadline?.()
        cancelAttemptDeadline = null
        attemptController = null
        attemptInFlight = false
      }
    }
  }

  function scheduleRetry(): void {
    if (!running) {
      searching.value = false
      return
    }
    const delayMs = retryDelayMs
    retryDelayMs = Math.min(retryDelayMs * RETRY_GROWTH, RETRY_CEILING_MS)
    cancelPendingLook?.()
    cancelPendingLook = deps.schedule(look, delayMs)
  }

  return {
    searching: readonly(searching),
    blocker: readonly(blocker),
    canRestoreTheWatch,
    cancelPendingResume: standDown,
    start,
    stop,
    reconsider,
  }
}
