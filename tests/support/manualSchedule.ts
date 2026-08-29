/**
 * A clock and the scheduler that runs on it, both driven by hand.
 *
 * The rejoin supervisor's whole subject is time — a delay that doubles to half a minute, a floor
 * between attempts, a deadline on one — and a spec that waited any of it out would take longer to
 * run than the boat takes to drift back into range. `advance` moves the clock and runs whatever
 * came due while it moved, so growth and reset can be read off `delaysAsked` as a list of numbers.
 */

interface ScheduledRun {
  readonly dueAt: number
  readonly run: () => void
  cancelled: boolean
}

export interface ManualSchedule {
  now(): number
  schedule(run: () => void, delayMs: number): () => void
  /** Moves the clock on, running everything that falls due on the way, in the order it falls due. */
  advance(ms: number): void
  /** Every delay asked for, in order, including the ones cancelled before they ran. */
  readonly delaysAsked: readonly number[]
  /** How many runs are still waiting, so a spec can assert the loop has given up or has not. */
  readonly pending: number
}

export function manualSchedule(startAt = 0): ManualSchedule {
  let clock = startAt
  const scheduled: ScheduledRun[] = []
  const delaysAsked: number[] = []

  const nextDue = (notAfter: number): ScheduledRun | null => {
    let soonest: ScheduledRun | null = null
    for (const candidate of scheduled) {
      if (candidate.cancelled || candidate.dueAt > notAfter) continue
      if (soonest === null || candidate.dueAt < soonest.dueAt) soonest = candidate
    }
    return soonest
  }

  return {
    now: () => clock,
    schedule(run, delayMs) {
      delaysAsked.push(delayMs)
      const pending: ScheduledRun = { dueAt: clock + delayMs, run, cancelled: false }
      scheduled.push(pending)
      return () => {
        pending.cancelled = true
      }
    },
    advance(ms) {
      const stopAt = clock + ms
      for (let due = nextDue(stopAt); due !== null; due = nextDue(stopAt)) {
        due.cancelled = true
        clock = due.dueAt
        due.run()
      }
      clock = stopAt
    },
    get delaysAsked() {
      return [...delaysAsked]
    },
    get pending() {
      return scheduled.filter((run) => !run.cancelled).length
    },
  }
}
