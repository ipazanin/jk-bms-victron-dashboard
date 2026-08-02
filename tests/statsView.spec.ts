// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import type { App } from 'vue'

import { provideHistoryEnvironment } from '../src/application/history/historyBrowser'
import StatsView from '../src/components/views/StatsView.vue'
import { PACK_SAMPLING_PERIOD_SECONDS } from '../src/domain/history/ringClock'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { ringRecordBytes, ringSnapshot } from './support/samples'

// Stats is now a statement about what the devices themselves kept, and the ways it can lie are all
// ways of *looking* right: a card waiting for solar the controller will never serve, a charge total
// quietly inflated by the pack resetting its own counter, an energy figure printed as a total when
// it is a floor. Those are assertions about painted text, so they are made where a reader meets it.

const NOMINAL_CAPACITY_AH = 315
/** The counter face of an instant, as the pack's RTC would have written it at UTC. */
const RTC_EPOCH_UTC_MS = Date.UTC(2020, 0, 1)

let host: HTMLElement
let app: App | null = null

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  app?.unmount()
  app = null
  host.remove()
})

/** Mounted text with its wrapping collapsed, so the copy can be asserted as one sentence. */
async function statsViewShowing(store: MemoryHistoryStore): Promise<string> {
  provideHistoryEnvironment({ store, downloadJson: () => undefined })
  app = createApp(StatsView)
  app.mount(host)
  // The ledger is read after mount, and the cards fold off it — several ticks down from first paint.
  for (let turn = 0; turn < 12; turn += 1) await nextTick()
  return (host.textContent ?? '').replace(/\s+/g, ' ')
}

/**
 * A ledger of `count` hourly records ending about now, so the week preset covers them without any
 * spec having to fix the clock.
 */
async function ledgerOf(
  store: MemoryHistoryStore,
  count: number,
  capacityAt: (index: number) => number,
): Promise<void> {
  const now = Date.now()
  const newestCounter = Math.round((now - RTC_EPOCH_UTC_MS) / 1000)
  await store.appendRingSnapshot(
    ringSnapshot({
      observedAt: now,
      runs: [
        {
          firstIndex: 0,
          records: Array.from({ length: count }, (_unused, index) =>
            ringRecordBytes({
              counterSeconds: newestCounter - (count - 1 - index) * PACK_SAMPLING_PERIOD_SECONDS,
              remainingCapacity: capacityAt(index),
              nominalCapacity: NOMINAL_CAPACITY_AH,
            }),
          ),
        },
      ],
    }),
  )
}

describe('what the Stats view paints off the pack’s own ring', () => {
  it('says the log is still on the pack when this browser holds no ledger', async () => {
    // The one empty state for the whole range section. A reader who has never read a log needs to
    // be told the records exist and where, not shown six cards of em dashes.
    const text = await statsViewShowing(new MemoryHistoryStore())

    expect(text).toContain('Nothing read from this pack yet')
    expect(text).toContain('about a month of hourly snapshots')
    expect(host.querySelector('[data-testid="stats-no-ring"]')).not.toBeNull()
  })

  it('leaves no solar-shaped card behind, in either state', async () => {
    // The controller answers its tunnel and refuses the history registers. A card, a strip or a
    // disabled import sitting there waiting is a promise this app cannot keep.
    const empty = await statsViewShowing(new MemoryHistoryStore())
    expect(empty).not.toMatch(/solar|pv\b/i)

    app?.unmount()
    app = null
    host.innerHTML = ''

    const store = new MemoryHistoryStore()
    await ledgerOf(store, 48, (index) => 280 + index * 0.5)
    expect(await statsViewShowing(store)).not.toMatch(/solar|pv\b/i)
  })

  it('folds the range cards out of the stored records', async () => {
    const store = new MemoryHistoryStore()
    await ledgerOf(store, 48, (index) => 280 + index * 0.5)

    const text = await statsViewShowing(store)

    expect(text).toContain('Hours on record')
    expect(text).toContain('Charged')
    expect(text).toContain('Drawn')
    expect(text).toContain('Widest cell spread')
    expect(text).toContain('Charge in vs out')
    expect(text).toContain('Pack over time')
    expect(text).toContain('Events per day')
  })

  it('calls every energy figure a floor rather than a total', async () => {
    // The counter is sampled hourly, so an hour that charged and discharged back to where it began
    // reads as nothing at all. Printing that as a total would overstate what the ring can know.
    const store = new MemoryHistoryStore()
    await ledgerOf(store, 48, (index) => 280 + index * 0.5)

    expect(await statsViewShowing(store)).toContain('a floor rather than a total')
  })

  it('reports the pack resetting its own charge counter instead of banking it as charge', async () => {
    // Measured on the real ring: 19 intervals land exactly on nominal and carry a fifth of the raw
    // positive total. Folded in, they would inflate the charged tile by about a fifth.
    const store = new MemoryHistoryStore()
    await ledgerOf(store, 48, (index) => (index === 47 ? NOMINAL_CAPACITY_AH : 280 + index * 0.5))

    const text = await statsViewShowing(store)

    expect(text).toContain('reset its own charge counter')
    expect(text).toContain('left out of the figures above')
  })

  it('states where the pack’s clock stands against this browser’s, once, for the whole page', async () => {
    const store = new MemoryHistoryStore()
    await ledgerOf(store, 48, (index) => 280 + index * 0.5)

    const text = await statsViewShowing(store)

    expect(text).toMatch(/The pack's clock runs about .* fast/)
    expect(text).toContain('Times below are corrected by that')
  })

  it('keeps the receipt for a read that came back with nothing', async () => {
    // A pack that stops answering 0xA7 is only ever visible as a history of attempts, so the read
    // that carried no record is exactly the one whose journal row has to reach the screen.
    const store = new MemoryHistoryStore()
    await store.appendRingSnapshot(ringSnapshot({ outcome: 'no-answer', runs: [] }))

    const text = await statsViewShowing(store)

    expect(text).toContain('The pack does not answer this command')
    expect(text).toContain("The pack's stored log")
  })

  it('offers a pack selector only once a second ledger exists', async () => {
    const store = new MemoryHistoryStore()
    await store.appendRingSnapshot(ringSnapshot())

    await statsViewShowing(store)
    expect(host.querySelector('[data-testid="stats-pack-picker"]')).toBeNull()
    expect(host.querySelector('[data-testid="stats-pack-name"]')).not.toBeNull()

    app?.unmount()
    app = null
    host.innerHTML = ''

    await store.appendRingSnapshot(ringSnapshot({ deviceKey: 'jk:SECONDPACK', observedAt: 5 }))
    await statsViewShowing(store)
    expect(host.querySelector('[data-testid="stats-pack-picker"]')).not.toBeNull()
  })
})
