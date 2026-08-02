// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import type { App } from 'vue'

import { provideHistoryEnvironment } from '../src/application/history/historyBrowser'
import StatsView from '../src/components/views/StatsView.vue'
import { calendarDateNow } from '../src/domain/history/calendarDays'
import { PACK_SAMPLING_PERIOD_SECONDS } from '../src/domain/history/ringClock'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { ringRecordBytes, ringSnapshot } from './support/samples'
import { capturedSolarSnapshot, capturedTotals } from './support/solarHistoryFixture'

// Stats is a statement about what the two devices themselves kept, and the ways it can lie are all
// ways of *looking* right: a charge total quietly inflated by the pack resetting its own counter, a
// pack energy figure printed as a total when it is a floor, a controller's day fabricated as zero
// where the register was never written. Those are assertions about painted text, so they are made
// where a reader meets it.

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

/**
 * A controller's ledger holding the captured backlog, dated as if the sweep ran today, so the Week
 * preset covers its newest days without any spec having to fix the clock.
 */
async function solarLedgerOf(store: MemoryHistoryStore): Promise<void> {
  const at = Date.now()
  await store.appendSolarHistory(
    capturedSolarSnapshot({ observedAt: at, readOnDate: calendarDateNow(at) }),
  )
}

describe('what the Stats view paints off the two devices’ own records', () => {
  it('says the history is still on the devices when this browser holds no ledger', async () => {
    // The one empty state for the whole page. A reader who has never read either device needs to be
    // told the records exist and where, not shown six cards of em dashes.
    const text = await statsViewShowing(new MemoryHistoryStore())

    expect(text).toContain('Nothing read from either device yet')
    expect(text).toContain('about a month of hourly snapshots')
    expect(text).toContain('a month of daily totals of its own')
    expect(host.querySelector('[data-testid="stats-no-ring"]')).not.toBeNull()
  })

  it('offers a solar read that says why it is disabled', async () => {
    // jsdom has no Web Bluetooth, which is the disabled case the button has to explain rather than
    // sit dead in. The live read is hardware-in-the-loop and stays there.
    await statsViewShowing(new MemoryHistoryStore())

    const buttons = [...host.querySelectorAll('button')]
    const read = buttons.find((button) => /read solar history/i.test(button.textContent ?? ''))

    expect(read).toBeDefined()
    expect(read?.disabled).toBe(true)
    expect(host.textContent).toContain('This browser has no Web Bluetooth')
  })

  it('says a sweep costs the live feed, because that is why it never happens by itself', async () => {
    // The controller takes one BLE client and changes its advertising while connected. An automatic
    // sweep would silently kill the Instant Readout feed, so the page has to state the trade.
    const text = await statsViewShowing(new MemoryHistoryStore())

    expect(text).toContain("The controller's stored history")
    expect(text).toMatch(/VictronConnect cannot reach it and the live solar readings stop/)
  })

  it('folds the controller’s own days into the solar cards', async () => {
    const store = new MemoryHistoryStore()
    await solarLedgerOf(store)

    const text = await statsViewShowing(store)

    expect(host.querySelector('[data-testid="stats-solar-yield"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="stats-solar-stages"]')).not.toBeNull()
    expect(text).toContain('Solar yield per day')
    expect(text).toContain('Time in each charge stage')
    // The controller integrated these itself, second by second, so they are totals and the page
    // must not carry the pack's hourly-floor caveat over onto them.
    expect(text).toContain("From the controller's own daily registers")
  })

  it('prints the lifetime counters the totals register carried', async () => {
    const store = new MemoryHistoryStore()
    await solarLedgerOf(store)

    const text = await statsViewShowing(store)

    expect(text).toContain('System yield')
    expect(text).toContain(`${capturedTotals.systemYieldKwh.toFixed(2)} kWh`)
    expect(text).toContain(String(capturedTotals.daysAvailable))
  })

  it('keeps the receipt for a sweep the controller refused', async () => {
    // A firmware that stops serving the history registers is only ever visible as a history of
    // attempts, exactly as a pack that stops answering 0xA7 is.
    const store = new MemoryHistoryStore()
    const at = Date.now()
    await store.appendSolarHistory(
      capturedSolarSnapshot({
        observedAt: at,
        readOnDate: calendarDateNow(at),
        outcome: 'refused',
        totals: null,
        days: [],
      }),
    )

    const text = await statsViewShowing(store)

    expect(text).toContain('answered the totals register with a status code')
    expect(text).toContain('will not serve its stored history')
  })

  it('counts an unwritten register as nothing rather than as a day of no sun', async () => {
    // A boat under cover produces recorded days of 0.14 kWh, so a fabricated zero would be
    // indistinguishable from a real one. The receipt says how many registers were left alone.
    const store = new MemoryHistoryStore()
    const at = Date.now()
    const swept = capturedSolarSnapshot({ observedAt: at, readOnDate: calendarDateNow(at) })
    await store.appendSolarHistory({
      ...swept,
      days: swept.days.map((reading) =>
        reading.daysAgo === 0 ? { ...reading, day: { recorded: false } } : reading,
      ),
    })

    const text = await statsViewShowing(store)

    expect(text).toContain('the controller has not written yet')
    expect(text).toContain('rather than as a day of no sun')
  })

  it('keeps the pack selector free of the controller’s ledger', async () => {
    // Both radios file into the same archive under their own keys. A controller offered in the pack
    // picker would fold a 34-byte day record through a decoder written for a 24-byte ring record.
    const store = new MemoryHistoryStore()
    await ledgerOf(store, 48, (index) => 280 + index * 0.5)
    await solarLedgerOf(store)

    await statsViewShowing(store)

    expect(host.querySelector('[data-testid="stats-pack-picker"]')).toBeNull()
    expect(host.querySelector('[data-testid="stats-pack-name"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="stats-solar-yield"]')).not.toBeNull()
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
