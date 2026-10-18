import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHistoryBrowser } from '../src/application/history/historyBrowser'
import type { HistoryStore, SessionListing, StoredRingLedger, StoredSession } from '../src/application/history/port'
import type { DeviceRecord, WarningRecord } from '../src/domain/history/types'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { deviceRecord, PACK_DEVICE_KEY, SAMPLE_EPOCH, SESSION_ID, ringSnapshot, sessionRecord, warningRecord } from './support/samples'
import { capturedSolarSnapshot, SOLAR_DEVICE_KEY } from './support/solarHistoryFixture'

function deferred<TResult>() {
  let resolve!: (result: TResult) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<TResult>((fulfill, fail) => { resolve = fulfill; reject = fail })
  return { promise, resolve, reject }
}

function browserFor(initial: HistoryStore | null) {
  let store = initial
  const download = vi.fn()
  const browser = createHistoryBrowser({ store: () => store, now: () => SAMPLE_EPOCH, download })
  return { browser, download, switchTo(next: HistoryStore | null) { store = next } }
}

async function recordedStore(writerId = 'first-writer'): Promise<MemoryHistoryStore> {
  const store = new MemoryHistoryStore()
  await store.upsertDevice(deviceRecord())
  await store.openSession(sessionRecord({ writerId }))
  await store.appendWarning(warningRecord())
  await store.appendRingSnapshot(ringSnapshot())
  await store.appendSolarHistory(capturedSolarSnapshot())
  return store
}

const window = { from: SAMPLE_EPOCH - 1, to: SAMPLE_EPOCH + 1 }

afterEach(() => { vi.restoreAllMocks() })

describe('history source isolation', () => {
  it('clears every previous source result before a failed source refresh', async () => {
    const previous = await recordedStore()
    const selected = new MemoryHistoryStore()
    const { browser, switchTo } = browserFor(previous)
    await browser.refresh()
    await browser.loadSession(SESSION_ID)
    await browser.loadWindowWarnings(window)
    await browser.loadRingLedger(PACK_DEVICE_KEY)
    await browser.loadSolarLedger(SOLAR_DEVICE_KEY)
    browser.select(window)
    expect(browser.groups.value).toHaveLength(1)
    expect(browser.windowWarnings.value).toHaveLength(1)
    expect(browser.ringLedger.value).not.toBeNull()
    expect(browser.solarLedger.value).not.toBeNull()

    vi.spyOn(selected, 'listSessions').mockRejectedValue(new Error('Selected source cannot be read'))
    switchTo(selected)
    await browser.refresh()

    expect(browser.groups.value).toEqual([])
    expect(browser.sessions.value).toEqual([])
    expect(browser.devices.value).toEqual([])
    expect(browser.warnings.value).toEqual([])
    expect(browser.ringLedgers.value).toEqual([])
    expect(browser.usage.value).toBeNull()
    expect(browser.loaded.value).toBeNull()
    expect(browser.selection.value).toBeNull()
    expect(browser.windowWarnings.value).toBeNull()
    expect(browser.ringLedger.value).toBeNull()
    expect(browser.solarLedger.value).toBeNull()
    expect(browser.failure.value).toBe('Selected source cannot be read')
    browser.dispose()
  })

  it('reads the same session identity from the new store instead of reusing the loaded session', async () => {
    const previous = await recordedStore('previous-writer')
    const selected = await recordedStore('selected-writer')
    const { browser, switchTo } = browserFor(previous)
    await browser.loadSession(SESSION_ID)
    expect(browser.loaded.value?.record.writerId).toBe('previous-writer')
    switchTo(selected)
    await browser.loadSession(SESSION_ID)
    expect(browser.loaded.value?.record.writerId).toBe('selected-writer')
    browser.dispose()
  })

  it('ignores a previous source session response after loading the same identity from the new source', async () => {
    const previous = await recordedStore('previous-writer')
    const selected = await recordedStore('selected-writer')
    const earlierSession = await previous.readSession(SESSION_ID)
    const earlier = deferred<StoredSession | null>()
    vi.spyOn(previous, 'readSession').mockReturnValue(earlier.promise)
    const { browser, switchTo } = browserFor(previous)
    const readingEarlier = browser.loadSession(SESSION_ID)
    switchTo(selected)
    await browser.loadSession(SESSION_ID)
    earlier.resolve(earlierSession)
    await readingEarlier
    expect(browser.loaded.value?.record.writerId).toBe('selected-writer')
    expect(browser.loading.value).toBe(false)
    browser.dispose()
  })

  it('ignores a pending session from the previous source even when the selected source has no matching session', async () => {
    const previous = await recordedStore()
    const oldSession = await previous.readSession(SESSION_ID)
    const response = deferred<StoredSession | null>()
    vi.spyOn(previous, 'readSession').mockReturnValue(response.promise)
    const { browser, switchTo } = browserFor(previous)
    const reading = browser.loadSession(SESSION_ID)
    switchTo(new MemoryHistoryStore())
    await browser.refresh()
    response.resolve(oldSession)
    await reading
    expect(browser.loaded.value).toBeNull()
    expect(browser.missing.value).toBe(SESSION_ID)
    browser.dispose()
  })

  it.each(['resolves', 'rejects'] as const)('ignores a previous source listing that later %s', async (outcome) => {
    const previous = await recordedStore('previous-writer')
    const selected = await recordedStore('selected-writer')
    const oldListing = await previous.listSessions()
    const response = deferred<readonly SessionListing[]>()
    vi.spyOn(previous, 'listSessions').mockReturnValue(response.promise)
    const { browser, switchTo } = browserFor(previous)
    const reading = browser.refresh()
    switchTo(selected)
    await browser.refresh()
    if (outcome === 'resolves') response.resolve(oldListing)
    else response.reject(new Error('Previous source failed'))
    await reading
    expect(browser.sessions.value[0]?.record.writerId).toBe('selected-writer')
    expect(browser.failure.value).toBeNull()
    browser.dispose()
  })

  it('invalidates pending warnings and both device ledgers when the source changes', async () => {
    const previous = await recordedStore()
    const oldPack = await previous.readRingLedger(PACK_DEVICE_KEY)
    const oldSolar = await previous.readRingLedger(SOLAR_DEVICE_KEY)
    const warnings = deferred<readonly WarningRecord[]>()
    const pack = deferred<StoredRingLedger | null>()
    const solar = deferred<StoredRingLedger | null>()
    vi.spyOn(previous, 'warningsInWindow').mockReturnValue(warnings.promise)
    vi.spyOn(previous, 'readRingLedger').mockImplementation((key) => key === PACK_DEVICE_KEY ? pack.promise : solar.promise)
    const { browser, switchTo } = browserFor(previous)
    const reading = Promise.all([browser.loadWindowWarnings(window), browser.loadRingLedger(PACK_DEVICE_KEY), browser.loadSolarLedger(SOLAR_DEVICE_KEY)])
    const selected = new MemoryHistoryStore()
    const listing = deferred<readonly SessionListing[]>()
    vi.spyOn(selected, 'listSessions').mockReturnValue(listing.promise)
    switchTo(selected)
    const refreshing = browser.refresh()
    warnings.resolve([warningRecord()])
    pack.resolve(oldPack)
    solar.resolve(oldSolar)
    await reading
    expect(browser.windowWarnings.value).toBeNull()
    expect(browser.ringLedger.value).toBeNull()
    expect(browser.solarLedger.value).toBeNull()
    expect(browser.ringLoading.value).toBe(false)
    expect(browser.solarLoading.value).toBe(false)
    listing.resolve([])
    await refreshing
    browser.dispose()
  })

  it('still loads a deep link requested before the first store opens', async () => {
    const selected = await recordedStore()
    const { browser, switchTo } = browserFor(null)
    await browser.loadSession(SESSION_ID)
    expect(browser.loaded.value).toBeNull()
    expect(browser.missing.value).toBeNull()
    switchTo(selected)
    await browser.refresh()
    expect(browser.loaded.value?.record.id).toBe(SESSION_ID)
    browser.dispose()
  })

  it('keeps existing results after a transient refresh failure in the same source', async () => {
    const store = await recordedStore()
    const { browser } = browserFor(store)
    await browser.refresh()
    vi.spyOn(store, 'listSessions').mockRejectedValue(new Error('Temporary failure'))
    await browser.refresh()
    expect(browser.groups.value).toHaveLength(1)
    expect(browser.failure.value).toBe('Temporary failure')
    browser.dispose()
  })

  it('clears records when the source disappears and resumes its current session when storage returns', async () => {
    const store = await recordedStore()
    const { browser, switchTo } = browserFor(store)
    await browser.refresh()
    await browser.loadSession(SESSION_ID)
    switchTo(null)
    await browser.refresh()
    expect(browser.groups.value).toEqual([])
    expect(browser.loaded.value).toBeNull()
    expect(browser.availability.value).toBeNull()
    switchTo(store)
    await browser.refresh()
    expect(browser.loaded.value?.record.id).toBe(SESSION_ID)
    browser.dispose()
  })

  it('ignores pending window warnings after disposal', async () => {
    const store = await recordedStore()
    const warnings = deferred<readonly WarningRecord[]>()
    vi.spyOn(store, 'warningsInWindow').mockReturnValue(warnings.promise)
    const { browser } = browserFor(store)
    const reading = browser.loadWindowWarnings(window)
    browser.dispose()
    warnings.resolve([warningRecord()])
    await reading
    expect(browser.windowWarnings.value).toBeNull()
  })

  it('does not finish a session download after its source was replaced', async () => {
    const previous = await recordedStore()
    const { browser, download, switchTo } = browserFor(previous)
    await browser.loadSession(SESSION_ID)
    const streaming = deferred<void>()
    vi.spyOn(previous, 'streamChunks').mockReturnValueOnce(streaming.promise)
    const exporting = browser.downloadSession()
    switchTo(new MemoryHistoryStore())
    await browser.refresh()
    streaming.resolve()
    await exporting
    expect(download).not.toHaveBeenCalled()
    expect(browser.exportState.value).toBe('idle')
    browser.dispose()
  })

  it('keeps the selected source label when a previous source rename finishes', async () => {
    const previous = await recordedStore()
    const selected = await recordedStore()
    await selected.renameDevice(PACK_DEVICE_KEY, 'Selected source pack')
    const renamed = deferred<DeviceRecord | null>()
    const commitRename = previous.renameDevice.bind(previous)
    vi.spyOn(previous, 'renameDevice').mockImplementation(async (key, label) => {
      await renamed.promise
      return commitRename(key, label)
    })
    const { browser, switchTo } = browserFor(previous)
    await browser.loadSession(SESSION_ID)
    const renaming = browser.renameDevice(PACK_DEVICE_KEY, 'Previous source pack')
    switchTo(selected)
    await browser.loadSession(SESSION_ID)
    renamed.resolve(null)
    await renaming
    expect((await previous.listDevices()).find((device) => device.key === PACK_DEVICE_KEY)?.userLabel).toBe('Previous source pack')
    expect(browser.loaded.value?.label).toBe('Selected source pack')
    browser.dispose()
  })

  it.each(['deleteSession', 'deleteRingLedger'] as const)('keeps the selected source records when a previous source %s finishes', async (operation) => {
    const previous = await recordedStore('previous-writer')
    const selected = await recordedStore('selected-writer')
    const deleted = deferred<void>()
    const commitDelete = previous[operation].bind(previous)
    vi.spyOn(previous, operation).mockImplementation(async (key) => {
      await deleted.promise
      return commitDelete(key)
    })
    const { browser, switchTo } = browserFor(previous)
    await browser.loadSession(SESSION_ID)
    await browser.loadRingLedger(PACK_DEVICE_KEY)
    const deleting = operation === 'deleteSession' ? browser.deleteSession(SESSION_ID) : browser.deleteRingLedger(PACK_DEVICE_KEY)
    switchTo(selected)
    await browser.loadSession(SESSION_ID)
    await browser.loadRingLedger(PACK_DEVICE_KEY)
    deleted.resolve()
    await deleting
    expect(browser.loaded.value?.record.writerId).toBe('selected-writer')
    expect(browser.ringLedger.value?.deviceKey).toBe(PACK_DEVICE_KEY)
    if (operation === 'deleteSession') expect(await previous.readSession(SESSION_ID)).toBeNull()
    else expect(await previous.readRingLedger(PACK_DEVICE_KEY)).toBeNull()
    browser.dispose()
  })

  it('does not refresh the selected source after a previous source clock write completes', async () => {
    const previous = await recordedStore()
    const selected = await recordedStore()
    const updated = deferred<DeviceRecord | null>()
    const commitClock = previous.setPackClock.bind(previous)
    vi.spyOn(previous, 'setPackClock').mockImplementation(async (key, clock) => {
      await updated.promise
      return commitClock(key, clock)
    })
    const { browser, switchTo } = browserFor(previous)
    const changing = browser.setPackClock(PACK_DEVICE_KEY, { utcOffsetMinutes: 120, aheadSeconds: 30 })
    switchTo(selected)
    await browser.refresh()
    const listSelected = vi.spyOn(selected, 'listSessions')
    updated.resolve(null)
    await changing
    expect((await previous.listDevices()).find((device) => device.key === PACK_DEVICE_KEY)?.packClockAheadSeconds).toBe(30)
    expect(listSelected).not.toHaveBeenCalled()
    browser.dispose()
  })

  it.each(['renameDevice', 'deleteSession', 'deleteRingLedger', 'setPackClock'] as const)('does not report an old source %s failure against the selected source', async (operation) => {
    const previous = await recordedStore()
    const selected = await recordedStore('selected-writer')
    const result = deferred<never>()
    vi.spyOn(previous, operation).mockReturnValue(result.promise)
    const { browser, switchTo } = browserFor(previous)
    const writing = operation === 'renameDevice' ? browser.renameDevice(PACK_DEVICE_KEY, 'New label')
      : operation === 'deleteSession' ? browser.deleteSession(SESSION_ID)
        : operation === 'deleteRingLedger' ? browser.deleteRingLedger(PACK_DEVICE_KEY)
          : browser.setPackClock(PACK_DEVICE_KEY, { utcOffsetMinutes: 120, aheadSeconds: 30 })
    switchTo(selected)
    await browser.loadSession(SESSION_ID)
    result.reject(new Error('Previous source write failed'))
    await writing
    expect(browser.failure.value).toBeNull()
    expect(browser.loaded.value?.record.writerId).toBe('selected-writer')
    browser.dispose()
  })
})
