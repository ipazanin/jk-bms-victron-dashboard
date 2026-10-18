// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'
import { applyArchivePreferences, captureArchivePreferences, restoredPreferencesRevision } from '../src/application/backup/preferences'
import { applyTheme, loadThemeChoice } from '../src/application/theme'
import { storageKey } from '../src/application/storageKey'
import { SECRET_PREFERENCE_KEY } from '../src/domain/backup/archivePreferences'
import remembered from './fixtures/rememberedSession.json'

beforeEach(() => {
  localStorage.clear()
  restoredPreferencesRevision.value = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

describe('archive preferences', () => {
  it('captures only the allowlist and requires a separate secret choice', () => {
    localStorage.setItem('shunt.theme', 'light')
    localStorage.setItem(storageKey('shunt.lastBmsDevice'), JSON.stringify({ id: 'local-radio', name: null, at: 1 }))
    localStorage.setItem(storageKey(SECRET_PREFERENCE_KEY), 'a'.repeat(32))
    localStorage.setItem('unrelated.account', 'do not transfer')

    expect(captureArchivePreferences(false)).toEqual([
      { key: 'shunt.theme', value: 'light' },
      { key: 'shunt.lastBmsDevice', value: JSON.stringify({ id: 'local-radio', name: null, at: 1 }) },
    ])
    expect(captureArchivePreferences(true)).toContainEqual({ key: SECRET_PREFERENCE_KEY, value: 'a'.repeat(32) })
  })

  it('keeps demo snapshots separate while sharing the browser theme and sidebar', () => {
    vi.stubEnv('VITE_FAKE_BLE', 'true')
    localStorage.setItem('shunt.theme', 'light')
    localStorage.setItem('shunt.sidebar', 'collapsed')
    localStorage.setItem('shunt.logbook', 'real boat')
    localStorage.setItem('shunt.logbook.fake', 'demo boat')
    expect(captureArchivePreferences(false)).toEqual([
      { key: 'shunt.theme', value: 'light' },
      { key: 'shunt.sidebar', value: 'collapsed' },
      { key: 'shunt.logbook', value: 'demo boat' },
    ])
    applyArchivePreferences([{ key: 'shunt.logbook', value: 'imported demo' }], false)
    expect(localStorage.getItem('shunt.logbook')).toBe('real boat')
    expect(localStorage.getItem('shunt.logbook.fake')).toBe('imported demo')
  })

  it('applies portable settings without copying radio identities or changing permission intent', () => {
    localStorage.setItem(storageKey('shunt.lastBmsDevice'), 'existing local pack')
    localStorage.setItem(storageKey('shunt.lastSolarController'), 'existing local controller')
    localStorage.setItem(storageKey('shunt.rejoinArmed'), 'off')
    localStorage.setItem(storageKey(SECRET_PREFERENCE_KEY), 'local secret')
    const savedSnapshot = { ...remembered, bmsDeviceId: 'foreign-radio' }

    applyArchivePreferences([
      { key: 'shunt.theme', value: 'light' },
      { key: 'shunt.rememberedSession', value: JSON.stringify(savedSnapshot) },
      { key: 'shunt.lastBmsDevice', value: 'foreign pack' },
      { key: 'shunt.lastSolarController', value: 'foreign controller' },
      { key: 'shunt.rejoinArmed', value: 'on' },
      { key: SECRET_PREFERENCE_KEY, value: 'foreign secret' },
    ], false)

    expect(localStorage.getItem('shunt.theme')).toBe('light')
    expect(localStorage.getItem(storageKey('shunt.lastBmsDevice'))).toBe('existing local pack')
    expect(localStorage.getItem(storageKey('shunt.lastSolarController'))).toBe('existing local controller')
    expect(localStorage.getItem(storageKey('shunt.rejoinArmed'))).toBe('off')
    expect(localStorage.getItem(storageKey(SECRET_PREFERENCE_KEY))).toBe('local secret')
    const restored = JSON.parse(localStorage.getItem(storageKey('shunt.rememberedSession'))!)
    expect(restored).not.toHaveProperty('bmsDeviceId')
    expect(restored.battery).toEqual(savedSnapshot.battery)
  })

  it('restores an explicit secret choice and removes portable preferences absent from the saved source', () => {
    localStorage.setItem('shunt.theme', 'light')
    localStorage.setItem(storageKey('shunt.statsPreferences'), 'old choice')
    localStorage.setItem('unrelated.account', 'retained')
    applyArchivePreferences([{ key: SECRET_PREFERENCE_KEY, value: 'b'.repeat(32) }], true)
    expect(localStorage.getItem(storageKey(SECRET_PREFERENCE_KEY))).toBe('b'.repeat(32))
    expect(localStorage.getItem('shunt.theme')).toBeNull()
    expect(localStorage.getItem(storageKey('shunt.statsPreferences'))).toBeNull()
    expect(localStorage.getItem('unrelated.account')).toBe('retained')
  })

  it.each(['false', 'true'])('preserves the existing key when the saved archive omits it in demo mode %s', (demoMode) => {
    vi.stubEnv('VITE_FAKE_BLE', demoMode)
    const keyStorage = storageKey(SECRET_PREFERENCE_KEY)
    localStorage.setItem(keyStorage, 'c'.repeat(32))
    localStorage.setItem('shunt.theme', 'dark')

    applyArchivePreferences([{ key: 'shunt.theme', value: 'light' }], true)

    expect(localStorage.getItem(keyStorage)).toBe('c'.repeat(32))
    expect(localStorage.getItem('shunt.theme')).toBe('light')
    expect(restoredPreferencesRevision.value).toBe(1)
  })

  it('notifies theme readers once after all storage changes finish', () => {
    localStorage.setItem('shunt.theme', 'dark')
    const changed = vi.fn(() => {
      const theme = loadThemeChoice()
      if (theme !== null) applyTheme(theme)
      expect(localStorage.getItem('shunt.sidebar')).toBe('collapsed')
    })
    const stop = watch(restoredPreferencesRevision, changed, { flush: 'sync' })
    try {
      applyArchivePreferences([{ key: 'shunt.theme', value: 'light' }, { key: 'shunt.sidebar', value: 'collapsed' }], false)
      expect(changed).toHaveBeenCalledTimes(1)
      expect(restoredPreferencesRevision.value).toBe(1)
      expect(document.documentElement.dataset.theme).toBe('light')
    } finally { stop() }
  })

  it('rolls back every changed preference when one write fails without publishing a revision', () => {
    localStorage.setItem('shunt.theme', 'dark')
    localStorage.setItem('shunt.sidebar', 'expanded')
    localStorage.setItem(storageKey('shunt.logbook'), 'previous logbook')
    const original = Storage.prototype.setItem
    let denied = false
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, stored) {
      if (key === 'shunt.sidebar' && !denied) { denied = true; throw new Error('quota reached') }
      return original.call(this, key, stored)
    })

    expect(() => applyArchivePreferences([{ key: 'shunt.theme', value: 'light' }, { key: 'shunt.sidebar', value: 'collapsed' }], false)).toThrow('quota reached')
    expect(localStorage.getItem('shunt.theme')).toBe('dark')
    expect(localStorage.getItem('shunt.sidebar')).toBe('expanded')
    expect(localStorage.getItem(storageKey('shunt.logbook'))).toBe('previous logbook')
    expect(restoredPreferencesRevision.value).toBe(0)
  })

  it('reports when storage also refuses rollback', () => {
    localStorage.setItem('shunt.theme', 'dark')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
    expect(() => applyArchivePreferences([{ key: 'shunt.theme', value: 'light' }], false)).toThrow('could not restore every previous setting')
    expect(restoredPreferencesRevision.value).toBe(0)
  })

  it('does not begin writing when the previous settings cannot be read', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem')
    const remove = vi.spyOn(Storage.prototype, 'removeItem')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage denied') })
    expect(() => applyArchivePreferences([{ key: 'shunt.theme', value: 'light' }], false)).toThrow('storage denied')
    expect(write).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(restoredPreferencesRevision.value).toBe(0)
  })
})
