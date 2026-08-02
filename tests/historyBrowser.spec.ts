/**
 * The archive read model, driven directly.
 *
 * One thing lives here and nowhere below it: the tally of chunks this build has no reader for. The
 * store hands those chunks over precisely so they can be counted, and the count is the only thing
 * telling a session whose rows are stored in another layout apart from a session that recorded
 * nothing — the two decode to exactly the same empty arrays, and the session view captions them
 * differently on the strength of this number alone.
 *
 * The Memory fake stands in for the archive, which the contract suite binds to the adapter's own
 * answers about layout, window and export in the same three cases this file starts from.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createHistoryBrowser } from '../src/application/history/historyBrowser'
import type { HistoryBrowser } from '../src/application/history/historyBrowser'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import {
  PACK_DEVICE_KEY,
  RING_EPOCH_COUNTER_SECONDS,
  SAMPLE_EPOCH,
  SESSION_ID,
  inForeignLayout,
  packChunk,
  packSamples,
  ringRecords,
  ringSnapshot,
  sessionPatch,
  sessionRecord,
  solarChunk,
  solarSamples,
} from './support/samples'
import { PACK_SAMPLING_PERIOD_SECONDS } from '../src/domain/history/ringClock'

/** Lets the microtask chain behind a fire-and-forget `refresh()` settle before an assertion. */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
}

describe('reading a session through the archive model', () => {
  let store: MemoryHistoryStore
  let browser: HistoryBrowser

  beforeEach(() => {
    store = new MemoryHistoryStore()
    browser = createHistoryBrowser({
      store: () => store,
      now: () => SAMPLE_EPOCH,
      download: () => undefined,
    })
  })

  afterEach(() => {
    browser.dispose()
    store.close()
  })

  it('decodes the chunks it can read and counts the ones it cannot', async () => {
    await store.openSession(sessionRecord())
    await store.commitChunk(
      packChunk(packSamples(3), { seq: 0 }),
      sessionPatch({ packSamples: 6, packChunks: 2 }),
    )
    await store.commitChunk(
      inForeignLayout(packChunk(packSamples(3, { at: SAMPLE_EPOCH + 300_000 }), { seq: 1 })),
      sessionPatch({ packSamples: 6, packChunks: 2 }),
    )

    await browser.loadSession(SESSION_ID)

    const loaded = browser.loaded.value
    expect(loaded?.pack).toHaveLength(3)
    expect(loaded?.unreadableChunks).toBe(1)
  })

  it('reports a session it can read nothing of as unreadable, not as empty', async () => {
    // The whole point of counting these. Both streams decode to nothing, the session row still
    // reports every row it recorded, and only this number says why the two disagree.
    await store.openSession(sessionRecord())
    await store.commitChunk(
      inForeignLayout(packChunk(packSamples(4))),
      sessionPatch({ packSamples: 4, packChunks: 1 }),
    )
    await store.commitChunk(
      inForeignLayout(solarChunk(solarSamples(4))),
      sessionPatch({ packSamples: 4, solarSamples: 4, packChunks: 1, solarChunks: 1 }),
    )

    await browser.loadSession(SESSION_ID)

    const loaded = browser.loaded.value
    expect(loaded?.pack).toEqual([])
    expect(loaded?.solar).toEqual([])
    expect(loaded?.timeline).toEqual([])
    expect(loaded?.unreadableChunks).toBe(2)
    expect(loaded?.record.packSamples).toBe(4)
    expect(loaded?.record.solarSamples).toBe(4)
  })

  it('counts nothing unreadable for a session that genuinely holds no rows', async () => {
    // The other side of the same pin: a watch that connected and recorded nothing decodes to the
    // same empty arrays as the case above and must not be captioned as stored in another layout.
    await store.openSession(sessionRecord())

    await browser.loadSession(SESSION_ID)

    const loaded = browser.loaded.value
    expect(loaded?.pack).toEqual([])
    expect(loaded?.solar).toEqual([])
    expect(loaded?.unreadableChunks).toBe(0)
  })
})

describe("reading the pack's own ring through the archive model", () => {
  const OTHER_PACK_KEY = 'jk:OTHERPACK002'

  let store: MemoryHistoryStore
  let browser: HistoryBrowser

  beforeEach(() => {
    store = new MemoryHistoryStore()
    browser = createHistoryBrowser({
      store: () => store,
      now: () => SAMPLE_EPOCH,
      download: () => undefined,
    })
  })

  afterEach(() => {
    browser.dispose()
    store.close()
  })

  it('loads a ledger alongside the session list', async () => {
    await store.appendRingSnapshot(ringSnapshot())

    await browser.refresh()

    expect(browser.ringLedgers.value).toHaveLength(1)
    expect(browser.ringLedgers.value[0].deviceKey).toBe(PACK_DEVICE_KEY)
    expect(browser.ringLedgers.value[0].records).toBe(8)
  })

  it('supersedes a ledger read still in flight', async () => {
    await store.appendRingSnapshot(ringSnapshot({ deviceKey: PACK_DEVICE_KEY }))
    await store.appendRingSnapshot(
      // Below MIN_ALIGNMENT_OVERLAP and an empty ledger is opened, not broken — but a run this
      // short is still discarded either way, so this one carries five records to actually land.
      ringSnapshot({ deviceKey: OTHER_PACK_KEY, runs: [{ firstIndex: 0, records: ringRecords(5) }] }),
    )

    // Neither call is awaited before the next fires, so the second request's answer must be the
    // one left standing whatever order the two reads themselves settle in.
    const first = browser.loadRingLedger(PACK_DEVICE_KEY)
    const second = browser.loadRingLedger(OTHER_PACK_KEY)
    await Promise.all([first, second])

    expect(browser.ringLedger.value?.deviceKey).toBe(OTHER_PACK_KEY)
    expect(browser.ringLedger.value?.records).toHaveLength(5)
  })

  it("re-reads a loaded ledger when a foreign tab's ring-read arrives", async () => {
    const opening = ringRecords(8)
    await store.appendRingSnapshot(ringSnapshot({ runs: [{ firstIndex: 0, records: opening }] }))
    await browser.loadRingLedger(PACK_DEVICE_KEY)
    expect(browser.ringLedger.value?.records).toHaveLength(8)

    // A second tab folding its own read straight into the store, then announcing the change the
    // way a BroadcastChannel message would carry it here — the channel never delivers to the tab
    // that posted, so this tab's copy is stale until the watch fires and re-reads it. The run
    // repeats four already-stored records so it aligns, then carries two genuinely new ones.
    const overlapThenNew = [
      ...opening.slice(4),
      ...ringRecords(2, {
        counterSeconds: RING_EPOCH_COUNTER_SECONDS + 8 * PACK_SAMPLING_PERIOD_SECONDS,
      }),
    ]
    await store.appendRingSnapshot(
      ringSnapshot({ runs: [{ firstIndex: 4, records: overlapThenNew }] }),
    )
    store.announce()
    await flushMicrotasks()

    expect(browser.ringLedger.value?.records).toHaveLength(10)
  })

  it('survives a store that holds no ledger', async () => {
    await expect(browser.loadRingLedger(OTHER_PACK_KEY)).resolves.toBeUndefined()

    expect(browser.ringLedger.value).toBeNull()
    expect(browser.ringLoading.value).toBe(false)
  })
})
