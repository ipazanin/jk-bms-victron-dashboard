/**
 * The schedule behind automatic rejoin, driven with no browser in the room: a clock that only
 * moves when the spec says so, a page that is in front or behind on command, and a link that
 * answers exactly when it is told to.
 *
 * What is being pinned here is mostly restraint — when NOT to try, and what a failure is allowed
 * to cost. The one thing that is never pinned is a banner, because there is nothing in the
 * supervisor that could write one: a pack out of range is answered by trying again, quietly.
 */

import { describe, expect, it } from 'vitest'

import { createRejoinSupervisor } from '../src/application/rejoinSupervisor'
import type { LastDevice } from '../src/application/lastDevice'
import type { ReconnectPatience } from '../src/infrastructure/ble/ReconnectPatience'
import { ReconnectRefusedError } from '../src/infrastructure/ble/ReconnectRefusedError'
import { manualSchedule } from './support/manualSchedule'
import { scriptedPage } from './support/scriptedPage'

const REMEMBERED_PACK: LastDevice = { id: 'jk-abc', name: 'JK_B2A8S20P', at: 1_700_000_000_000 }

/** The supervisor's own constants, restated so a spec fails loudly when one of them moves. */
const FIRST_RETRY_MS = 1_000
const RETRY_CEILING_MS = 30_000
const MINIMUM_GAP_MS = 1_000
const ATTEMPT_DEADLINE_MS = 15_000
const BEHIND_A_WINDOW_RETRY_MS = 60_000

/** One attempt the supervisor started, held open until the spec decides how it ends. */
interface PendingRejoin {
  readonly deviceId: string
  readonly signal: AbortSignal
  /** What the supervisor said this attempt may do, which is the whole of the page's effect on it. */
  readonly patience: ReconnectPatience
  succeed(): void
  fail(error?: Error): void
}

/** Lets every microtask the settled attempt woke up run before the spec looks at the result. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function supervise(
  options: {
    armed?: boolean
    visible?: boolean
    focused?: boolean
    adapterOn?: boolean | null
    canRejoinWithoutChooser?: boolean
    linkBusy?: boolean
    pack?: LastDevice | null
  } = {},
) {
  const timers = manualSchedule()
  const page = scriptedPage({ visible: options.visible ?? true, focused: options.focused ?? true })
  const attempts: PendingRejoin[] = []
  let armed = options.armed ?? true
  let adapterOn = options.adapterOn === undefined ? true : options.adapterOn
  let linkBusy = options.linkBusy ?? false
  let pack = options.pack === undefined ? REMEMBERED_PACK : options.pack
  let releases = 0

  const supervisor = createRejoinSupervisor({
    rejoinArmed: () => armed,
    canRejoinWithoutChooser: options.canRejoinWithoutChooser ?? true,
    adapterOn: () => adapterOn,
    rememberedPack: () => pack,
    linkBusy: () => linkBusy,
    rejoinPack: (deviceId, signal, patience) => {
      return new Promise<void>((resolve, reject) => {
        attempts.push({
          deviceId,
          signal,
          patience,
          succeed: () => resolve(),
          fail: (error = new Error('Reconnect timed out. Use Connect BMS.')) => reject(error),
        })
        // The real client rejects when it is stood down rather than hanging on, and the deadline
        // is delivered the same way, so the fake has to answer an abort the same way too.
        signal.addEventListener('abort', () =>
          reject(new DOMException('Reconnect stood down', 'AbortError')),
        )
      })
    },
    releaseLink: async () => {
      releases += 1
    },
    pageActivity: page.activity,
    schedule: timers.schedule,
    now: timers.now,
  })

  return {
    supervisor,
    timers,
    page,
    attempts,
    get latest(): PendingRejoin {
      return attempts[attempts.length - 1]
    },
    get releases(): number {
      return releases
    },
    /** The last delay the supervisor asked to wait, which is the price it put on the last failure. */
    get lastWaitMs(): number | undefined {
      return timers.delaysAsked.at(-1)
    },
    arm(next: boolean): void {
      armed = next
      supervisor.reconsider()
    },
    /**
     * Disconnect pressed while an attempt is still finishing, in the case where the stand-down
     * loses the race and a link comes up anyway. Nothing is reconsidered, because the point is
     * what the attempt does when it lands on an intent that has already changed under it.
     */
    disarmMidFlight(): void {
      armed = false
    },
    switchRadio(on: boolean | null): void {
      adapterOn = on
      supervisor.reconsider()
    },
    holdLink(busy: boolean): void {
      linkBusy = busy
    },
    forgetPack(): void {
      pack = null
    },
  }
}

describe('when automatic rejoin may try at all', () => {
  it('goes back to the remembered pack as soon as the page starts', () => {
    const boat = supervise()

    boat.supervisor.start()

    expect(boat.attempts).toHaveLength(1)
    expect(boat.latest.deviceId).toBe('jk-abc')
    expect(boat.supervisor.searching.value).toBe(true)
    expect(boat.supervisor.blocker.value).toBeNull()
  })

  it('stays put while the owner has disarmed it, and goes the moment they arm it again', () => {
    const boat = supervise({ armed: false })

    boat.supervisor.start()
    expect(boat.attempts).toHaveLength(0)
    expect(boat.supervisor.searching.value).toBe(false)
    expect(boat.supervisor.blocker.value).toBeNull()

    boat.arm(true)

    expect(boat.attempts).toHaveLength(1)
  })

  it('does not wait for the tab to be shown, and asks a hidden one for no sighting', () => {
    const boat = supervise({ visible: false })

    boat.supervisor.start()

    // A hidden tab can still attach to a pack the adapter map is holding, and that is most of the
    // minutes after a drop. What it cannot do is listen for one, so it does not ask to.
    expect(boat.attempts).toHaveLength(1)
    expect(boat.latest.patience).toBe('straight-in-only')
  })

  it('waits to be heard only with the window focused, which a visible tab need not be', () => {
    const boat = supervise({ focused: false })

    boat.supervisor.start()

    expect(boat.attempts).toHaveLength(1)
    expect(boat.latest.patience).toBe('straight-in-only')
  })

  it('tries anyway on a browser that will not say whether the radio is on', () => {
    const boat = supervise({ adapterOn: null })

    boat.supervisor.start()

    // Only a plain no is a reason to wait. An answer that is never coming would otherwise hold the
    // loop still forever, and with nothing on screen to say what it is waiting for.
    expect(boat.attempts).toHaveLength(1)
    expect(boat.supervisor.blocker.value).toBeNull()
  })

  it('has nothing to do for a browser that has never connected to a pack', () => {
    const boat = supervise({ pack: null })

    boat.supervisor.start()

    expect(boat.attempts).toHaveLength(0)
    expect(boat.supervisor.blocker.value).toBeNull()
  })

  it('leaves a link that is already up alone', () => {
    const boat = supervise({ linkBusy: true })

    boat.supervisor.start()
    expect(boat.attempts).toHaveLength(0)
    expect(boat.supervisor.searching.value).toBe(false)

    boat.holdLink(false)
    boat.supervisor.reconsider()

    expect(boat.attempts).toHaveLength(1)
  })
})

describe('standing down', () => {
  it('abandons the attempt in flight when the window loses focus, and charges it nothing', async () => {
    const boat = supervise()
    boat.supervisor.start()
    const abandoned = boat.latest

    boat.page.blur()

    expect(abandoned.signal.aborted).toBe(true)
    // Still looking, because the half that needs no window is still worth trying. What was let go
    // of is the wait for a sighting the platform has just made impossible.
    expect(boat.supervisor.searching.value).toBe(true)
    await flush()
    expect(boat.attempts).toHaveLength(1)

    boat.page.focus()
    boat.timers.advance(MINIMUM_GAP_MS)
    expect(boat.attempts).toHaveLength(2)

    // The proof that the stand-down cost nothing: the next real failure still costs the first step.
    boat.latest.fail()
    await flush()
    expect(boat.lastWaitMs).toBe(FIRST_RETRY_MS)
  })

  it('abandons the attempt and says so when the radio is switched off', async () => {
    const boat = supervise()
    boat.supervisor.start()
    const abandoned = boat.latest

    boat.switchRadio(false)

    expect(abandoned.signal.aborted).toBe(true)
    expect(boat.supervisor.blocker.value).toBe('radio-off')
    expect(boat.supervisor.searching.value).toBe(false)
    await flush()

    boat.switchRadio(true)
    boat.timers.advance(MINIMUM_GAP_MS)

    expect(boat.attempts).toHaveLength(2)
    expect(boat.supervisor.blocker.value).toBeNull()
  })

  it('will not try on a browser that cannot rejoin without the chooser, and says which it is', () => {
    const boat = supervise({ canRejoinWithoutChooser: false })

    boat.supervisor.start()

    expect(boat.attempts).toHaveLength(0)
    expect(boat.supervisor.blocker.value).toBe('browser-cannot-rejoin')
  })

  it('stops trying once the pack is no longer permitted, and says so', async () => {
    const boat = supervise()
    boat.supervisor.start()

    boat.latest.fail(new ReconnectRefusedError('permission-gone', 'Tap Connect BMS.'))
    await flush()

    expect(boat.supervisor.blocker.value).toBe('permission-gone')
    expect(boat.supervisor.searching.value).toBe(false)
    // Nothing is waiting to run: a refusal is the one failure repeating cannot fix, so only new
    // information puts the question again.
    expect(boat.timers.pending).toBe(0)
  })

  it('takes the permission back the moment a link is up, whoever made it', async () => {
    const boat = supervise()
    boat.supervisor.start()

    boat.latest.fail(new ReconnectRefusedError('permission-gone', 'Tap Connect BMS.'))
    await flush()
    expect(boat.supervisor.blocker.value).toBe('permission-gone')

    // The chooser is the one thing that answers this refusal, and it never runs an attempt through
    // here. A page telling the owner it has no permission for a pack that is streaming is a claim
    // about a moment that has passed.
    boat.holdLink(true)
    boat.supervisor.reconsider()

    expect(boat.supervisor.blocker.value).toBeNull()
  })

  it('lets go of everything when the page goes away, and stops listening', async () => {
    const boat = supervise()
    boat.supervisor.start()
    const abandoned = boat.latest

    boat.supervisor.stop()
    await flush()

    expect(abandoned.signal.aborted).toBe(true)
    expect(boat.timers.pending).toBe(0)
    expect(boat.supervisor.searching.value).toBe(false)

    boat.page.blur()
    boat.page.focus()
    expect(boat.attempts).toHaveLength(1)
  })
})

describe('while the owner is working in another application', () => {
  it('goes for the pack behind another window, and comes up on the straight attach', async () => {
    const boat = supervise({ focused: false })

    boat.supervisor.start()

    expect(boat.attempts).toHaveLength(1)
    expect(boat.latest.patience).toBe('straight-in-only')

    // The pack is still in the adapter map, which is the ordinary case in the minutes after a
    // drop. A link made this way needs no focus to hold, so the owner's laptop is back on the boat
    // without their having looked at it.
    boat.latest.succeed()
    await flush()

    expect(boat.supervisor.searching.value).toBe(false)
    expect(boat.supervisor.blocker.value).toBeNull()
    expect(boat.timers.pending).toBe(0)
  })

  it('probes once a minute rather than climbing the fast ladder', async () => {
    const boat = supervise({ focused: false })
    boat.supervisor.start()

    const waits: number[] = []
    for (let failure = 0; failure < 4; failure += 1) {
      boat.latest.fail()
      await flush()
      const waited = boat.lastWaitMs ?? 0
      waits.push(waited)
      boat.timers.advance(waited)
    }

    // Flat, and slower than the ladder's own ceiling. Nobody is reading the page, Chromium throttles
    // a hidden tab's timers to about this anyway, and a probe the pack does not answer is a connect
    // attempt spent for nothing.
    expect(waits).toEqual([
      BEHIND_A_WINDOW_RETRY_MS,
      BEHIND_A_WINDOW_RETRY_MS,
      BEHIND_A_WINDOW_RETRY_MS,
      BEHIND_A_WINDOW_RETRY_MS,
    ])
    expect(boat.attempts).toHaveLength(5)
    expect(boat.attempts.every((attempt) => attempt.patience === 'straight-in-only')).toBe(true)
  })

  it('goes back to the fast ladder the moment the owner looks at the page', async () => {
    const boat = supervise({ focused: false })
    boat.supervisor.start()
    boat.latest.fail()
    await flush()
    expect(boat.lastWaitMs).toBe(BEHIND_A_WINDOW_RETRY_MS)

    // An owner who has just brought the window forward must not be made to sit out the rest of a
    // wait that was written for nobody watching.
    boat.timers.advance(MINIMUM_GAP_MS)
    boat.page.focus()

    expect(boat.attempts).toHaveLength(2)
    expect(boat.latest.patience).toBe('wait-for-a-sighting')

    boat.latest.fail()
    await flush()
    expect(boat.lastWaitMs).toBe(FIRST_RETRY_MS)
  })

  it('stands down a wait for a sighting when the page goes behind, and probes in its place', async () => {
    const boat = supervise()
    boat.supervisor.start()
    const waitingToBeHeard = boat.latest
    expect(waitingToBeHeard.patience).toBe('wait-for-a-sighting')

    boat.page.blur()

    // The watch that attempt was holding died with the focus and fired nothing to say so, so
    // leaving it parked would spend its whole deadline on an event that can no longer arrive.
    expect(waitingToBeHeard.signal.aborted).toBe(true)
    await flush()

    boat.timers.advance(MINIMUM_GAP_MS)

    expect(boat.attempts).toHaveLength(2)
    expect(boat.latest.patience).toBe('straight-in-only')
  })

  it('stops everything when the owner disarms it, whatever the page is doing', async () => {
    const boat = supervise({ focused: false })
    boat.supervisor.start()
    const abandoned = boat.latest

    boat.arm(false)
    await flush()

    expect(abandoned.signal.aborted).toBe(true)
    expect(boat.supervisor.searching.value).toBe(false)
    expect(boat.timers.pending).toBe(0)

    boat.timers.advance(BEHIND_A_WINDOW_RETRY_MS * 2)
    expect(boat.attempts).toHaveLength(1)
  })
})

describe('what a failure costs', () => {
  it('waits longer after each failure, and stops lengthening at half a minute', async () => {
    const boat = supervise()
    boat.supervisor.start()

    const waits: number[] = []
    for (let failure = 0; failure < 8; failure += 1) {
      boat.latest.fail()
      await flush()
      const waited = boat.lastWaitMs ?? 0
      waits.push(waited)
      boat.timers.advance(waited)
    }

    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
    expect(waits.every((waited) => waited <= RETRY_CEILING_MS)).toBe(true)
    expect(boat.attempts).toHaveLength(9)
  })

  it('puts the wait back to its first step when something new happens', async () => {
    const boat = supervise()
    boat.supervisor.start()

    boat.latest.fail()
    await flush()
    boat.timers.advance(FIRST_RETRY_MS)
    boat.latest.fail()
    await flush()
    expect(boat.lastWaitMs).toBe(2_000)

    // The owner comes back to the tab, which is better information than the two failures behind it.
    boat.timers.advance(MINIMUM_GAP_MS)
    boat.page.hide()
    boat.page.show()
    expect(boat.attempts).toHaveLength(3)

    boat.latest.fail()
    await flush()
    expect(boat.lastWaitMs).toBe(FIRST_RETRY_MS)
  })

  it('keeps trying for as long as the page is in front — there is no giving up', async () => {
    const boat = supervise()
    boat.supervisor.start()

    for (let failure = 0; failure < 40; failure += 1) {
      boat.latest.fail()
      await flush()
      boat.timers.advance(boat.lastWaitMs ?? 0)
    }

    expect(boat.attempts).toHaveLength(41)
    expect(boat.supervisor.searching.value).toBe(true)
    expect(boat.supervisor.blocker.value).toBeNull()
  })

  it('puts the question again after a link it never made lets go', async () => {
    const boat = supervise()
    boat.supervisor.start()
    boat.latest.fail()
    await flush()

    // The owner takes the link themselves while the loop is waiting out that first failure, so the
    // retry falls due on a link this loop has no business touching.
    boat.holdLink(true)
    boat.timers.advance(FIRST_RETRY_MS)
    await flush()
    expect(boat.attempts).toHaveLength(1)

    // And that link goes. Nothing tells the loop, because nothing owes it that — a page in front of
    // the owner all afternoon has no blur, no adapter flap and no visibility change left to revive
    // it, so a loop that parked here would be done for the rest of the session.
    boat.holdLink(false)
    boat.timers.advance(MINIMUM_GAP_MS)
    await flush()

    expect(boat.attempts).toHaveLength(2)
  })

  it('gives up on an attempt that never found the pack, and counts that as a failure', async () => {
    const boat = supervise()
    boat.supervisor.start()
    const parked = boat.latest

    boat.timers.advance(ATTEMPT_DEADLINE_MS)
    await flush()

    expect(parked.signal.aborted).toBe(true)
    expect(boat.lastWaitMs).toBe(FIRST_RETRY_MS)

    boat.timers.advance(FIRST_RETRY_MS)
    expect(boat.attempts).toHaveLength(2)
  })
})

describe('when the owner asks for an attempt now', () => {
  it('makes it the loop’s own attempt, deadline and all', async () => {
    const boat = supervise()

    const pressed = boat.supervisor.tryNow()

    expect(boat.attempts).toHaveLength(1)
    // The link waits on a sighting for as long as it is let, so an attempt made outside this loop
    // is one nothing can end. The press inherits the same deadline every other attempt runs under.
    boat.timers.advance(ATTEMPT_DEADLINE_MS)
    await expect(pressed).rejects.toThrow()
    expect(boat.latest.signal.aborted).toBe(true)
  })

  it('joins the attempt already running rather than opening a rival beside it', async () => {
    const boat = supervise()
    boat.supervisor.start()
    expect(boat.attempts).toHaveLength(1)

    const pressed = boat.supervisor.tryNow()

    // Two handshakes would fight over the single link the pack allows, and the second would be the
    // one nobody had put a clock on.
    expect(boat.attempts).toHaveLength(1)
    boat.latest.succeed()
    await pressed
  })
})

describe('when the pack answers', () => {
  it('stops looking and clears whatever it was standing down for', async () => {
    const boat = supervise()
    boat.supervisor.start()

    boat.latest.succeed()
    await flush()

    expect(boat.supervisor.searching.value).toBe(false)
    expect(boat.supervisor.blocker.value).toBeNull()
    expect(boat.timers.pending).toBe(0)
  })

  it('lets go of a link the owner disarmed while it was still being made', async () => {
    const boat = supervise()
    boat.supervisor.start()

    boat.disarmMidFlight()
    boat.latest.succeed()
    await flush()

    expect(boat.releases).toBe(1)
  })
})
