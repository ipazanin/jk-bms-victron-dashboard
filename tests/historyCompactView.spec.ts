// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import type { App, Component } from 'vue'
import { provideHistoryEnvironment, useHistoryBrowser } from '../src/application/history/historyBrowser'
import { loadLocalCapacityMiB } from '../src/application/history/localCapacity'
import { SessionHourAccumulator } from '../src/domain/history/SessionHourAccumulator'
import { MAX_PAIRING_AGE_MS, pairSamples } from '../src/domain/history/join'
import { EMPTY_LEDGER } from '../src/domain/history/ledger'
import type { StoredSession } from '../src/application/history/port'
import SessionView from '../src/components/history/SessionView.vue'
import StorageLine from '../src/components/history/StorageLine.vue'
import { MemoryHistoryStore } from './support/MemoryHistoryStore'
import { SESSION_ID, SAMPLE_EPOCH, packChunk, packSamples, sessionRecord, solarSamples } from './support/samples'

let app: App | null = null
let host: HTMLElement
let store: MemoryHistoryStore

beforeEach(() => {
  localStorage.clear()
  store = new MemoryHistoryStore()
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  app?.unmount()
  app = null
  useHistoryBrowser().unloadSession()
  store.close()
  host.remove()
  localStorage.clear()
  vi.restoreAllMocks()
})

async function mount(component: Component, props: Record<string, unknown>): Promise<void> {
  app = createApp(component, props)
  app.mount(host)
  await nextTick()
}

function savedSession(withRaw: boolean): StoredSession {
  const pack = packSamples(3, { at: SAMPLE_EPOCH, currentA: -8 })
  const solar = solarSamples(3, { at: SAMPLE_EPOCH, batteryCurrentA: 3 })
  const accumulator = new SessionHourAccumulator(SESSION_ID, 'recorded')
  for (const reading of pairSamples(pack, solar, MAX_PAIRING_AGE_MS)) accumulator.push(reading)
  return {
    record: sessionRecord({
      state: 'closed', endedAt: SAMPLE_EPOCH + 2_000,
      packSamples: 3, solarSamples: 3,
      retainedFrom: withRaw ? SAMPLE_EPOCH + 2_000 : SAMPLE_EPOCH + 3_000,
      ledger: { ...EMPTY_LEDGER, houseWh: 123, countedMs: 120_000, stateOfChargeFirst: 80, stateOfChargeLast: 70 },
    }),
    packDevice: null,
    solarDevice: null,
    pack: withRaw ? [packChunk([pack[2]])] : [],
    solar: [],
    hours: accumulator.updatedHours(),
    windowClamped: false,
  }
}

async function openSession(saved: StoredSession): Promise<void> {
  vi.spyOn(store, 'readSession').mockResolvedValue(saved)
  provideHistoryEnvironment({ store, downloadJson: () => undefined })
  await useHistoryBrowser().loadSession(SESSION_ID)
  await mount(SessionView, { id: SESSION_ID })
}

describe('session history after raw samples are removed', () => {
  it('shows retained hours and inspectable original moments without fabricating a raw trace', async () => {
    const saved = savedSession(false)
    await openSession(saved)
    const browser = useHistoryBrowser()
    expect(host.textContent).toContain('Hourly history')
    expect(host.textContent).toContain('Important moments')
    expect(host.textContent).toContain('No raw samples are available in this view')
    expect(host.querySelector('.ribbon')).toBeNull()
    expect(host.querySelector('.scrub')).toBeNull()
    expect(browser.account.value?.ledger.houseWh).toBe(123)

    const hourButton = host.querySelector<HTMLButtonElement>('.hours tbody button')!
    hourButton.click()
    await nextTick()
    expect(browser.selectedHour.value?.hourStart).toBe(saved.hours![0].hourStart)
    expect(browser.account.value?.ledger).toEqual(saved.hours![0].ledger)
    expect(host.textContent).toContain('Hourly ledger')
    expect(host.querySelector('.moments details')?.textContent).toContain('Remaining capacity')
    expect(host.querySelector('.moments details')?.textContent).toContain('Solar observation')
  })

  it('keeps a partial raw view separate from the whole-session hourly history', async () => {
    const saved = savedSession(true)
    await openSession(saved)
    const browser = useHistoryBrowser()
    expect(browser.loaded.value?.pack).toHaveLength(1)
    expect(browser.loaded.value?.timeline).toHaveLength(1)
    expect(browser.loaded.value?.hours).toHaveLength(1)
    expect(host.querySelector('.ribbon')).not.toBeNull()
    expect(host.querySelector('.ribbon .caption')?.textContent).toContain('Drawn from 1 samples')
    expect(host.textContent).toContain('Hourly history')
    expect(browser.account.value?.ledger.houseWh).toBe(123)
    browser.select({ from: SAMPLE_EPOCH + 1_999, to: SAMPLE_EPOCH + 2_001 })
    expect(browser.account.value?.ledger.houseWh).toBe(0)
    expect(browser.selectedHour.value).toBeNull()
  })

  it('exports compact history without claiming a recomputation from missing raw samples', async () => {
    const saved = savedSession(false)
    let exported = ''
    vi.spyOn(store, 'readSession').mockResolvedValue(saved)
    provideHistoryEnvironment({ store, downloadJson: (_name, parts) => { exported = [...parts].join('') } })
    const browser = useHistoryBrowser()
    await browser.loadSession(SESSION_ID)
    await browser.downloadSession()
    const document = JSON.parse(exported)
    expect(document.formatVersion).toBe(2)
    expect(document.hours).toEqual(saved.hours)
    expect(document.rawCoverage).toBe('none')
    expect(document.ledger.stored.houseWh).toBe(123)
    expect(document.ledger.recomputed).toBeNull()
    expect(document.streams.pack.rows).toEqual([])
  })

  it('keeps raw-window navigation available when the selected day has no raw samples', async () => {
    const saved = savedSession(false)
    await openSession({ ...saved, record: { ...saved.record, endedAt: SAMPLE_EPOCH + 3 * 86_400_000 } })
    const browser = useHistoryBrowser()
    const original = browser.loaded.value!.rawWindow
    expect(original.to - original.from).toBe(86_400_000)
    const earlier = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Earlier raw window')!
    expect(earlier.disabled).toBe(false)
    earlier.click()
    for (let tick = 0; tick < 3; tick += 1) await nextTick()
    expect(browser.loaded.value!.rawWindow.from).toBeLessThan(original.from)
    const later = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Later raw window')!
    expect(later.disabled).toBe(false)
  })

  it('exports actual retained raw rows beside the summaries and labels them partial', async () => {
    const saved = savedSession(true)
    let exported = ''
    vi.spyOn(store, 'readSession').mockResolvedValue(saved)
    vi.spyOn(store, 'streamChunks').mockImplementation(async (_sessionId, stream, _window, visit) => {
      if (stream === 'pack') await visit(saved.pack[0])
    })
    provideHistoryEnvironment({ store, downloadJson: (_name, parts) => { exported = [...parts].join('') } })
    const browser = useHistoryBrowser()
    await browser.loadSession(SESSION_ID)
    await browser.downloadSession()
    const document = JSON.parse(exported)
    expect(document.rawCoverage).toBe('partial')
    expect(document.streams.pack.rows).toHaveLength(1)
    expect(document.hours).toEqual(saved.hours)
    expect(document.ledger.recomputed).toBeNull()
  })

  it('does not compare repeated-clock accounting against elapsed wall time', async () => {
    const saved = savedSession(false)
    await openSession({ ...saved, hours: saved.hours!.map((hour) => ({ ...hour, clockAdjusted: true })) })
    expect(host.querySelector('.window')?.textContent).toContain('clock times overlap')
    expect(host.querySelector('.window')?.textContent).not.toContain(' of the ')
    host.querySelector<HTMLButtonElement>('.hours tbody button')!.click()
    await nextTick()
    expect(host.querySelector('.window')?.textContent).toContain('clock times overlap')
    expect(host.querySelector('.window')?.textContent).not.toContain(' of the ')
  })
})

describe('local raw recording allowance', () => {
  it('uses exact byte usage and persists the selected allowance only in this browser', async () => {
    await mount(StorageLine, {
      availability: store.availability,
      usage: { totalSamples: 1, sessions: 1, ringRecords: 0, rawBytes: 1024 * 1024, rawCapacityBytes: 100 * 1024 * 1024 },
    })
    expect(host.textContent).toContain('1.0 of 100 MiB')
    const select = host.querySelector('select')!
    expect(select.value).toBe('100')
    expect([...select.options].map((option) => option.value)).toEqual(['25', '50', '100'])
    select.value = '25'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect(loadLocalCapacityMiB()).toBe(25)
    expect(host.textContent).toContain('1.0 of 25 MiB')
    expect(host.textContent).toContain('after their hourly summaries are saved')
    expect(host.textContent).not.toContain('oldest session goes')
  })

  it('does not invent a raw byte total when an older source cannot report it', async () => {
    await mount(StorageLine, {
      availability: store.availability,
      usage: { totalSamples: 1_000, sessions: 1, ringRecords: 0 },
    })
    expect(host.querySelector('.track')).toBeNull()
    expect(host.querySelector('select')?.value).toBe('100')
  })
})
