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
  SAMPLE_EPOCH,
  SESSION_ID,
  inForeignLayout,
  packChunk,
  packSamples,
  sessionPatch,
  sessionRecord,
  solarChunk,
  solarSamples,
} from './support/samples'

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
