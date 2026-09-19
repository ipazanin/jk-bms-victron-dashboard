// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadStatsPreferences, saveStatsPreferences } from '../src/application/history/statsPreferences'

const KEY = 'shunt.statsPreferences'
const preferences = {
  range: 'custom',
  custom: { from: Date.UTC(2026, 0, 9), to: Date.UTC(2026, 0, 2) },
  pack: 'jk:SECONDPACK',
} as const

beforeEach(() => localStorage.clear())

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  localStorage.clear()
})

describe('Stats preferences', () => {
  it('keeps the selected range, dates in either order, and pack', () => {
    saveStatsPreferences(preferences)
    expect(loadStatsPreferences()).toEqual(preferences)
  })

  it.each(['invalid json', 'null', '[]', '{"version":2,"range":"day"}'])(
    'uses the original defaults for an unreadable or unsupported preference: %s',
    (stored) => {
      localStorage.setItem(KEY, stored)
      expect(loadStatsPreferences()).toEqual({ range: 'week', custom: null, pack: null })
    },
  )

  it.each([null, { from: 1e30, to: 2 }, { from: '2026-01-01', to: 2 }])(
    'rejects invalid custom dates without losing a valid pack choice: %j',
    (custom) => {
      localStorage.setItem(KEY, JSON.stringify({ version: 1, ...preferences, custom }))
      expect(loadStatsPreferences()).toEqual({ range: 'week', custom: null, pack: preferences.pack })
    },
  )

  it('uses separate choices for fake and real device archives', () => {
    saveStatsPreferences(preferences)
    vi.stubEnv('VITE_FAKE_BLE', 'true')
    expect(loadStatsPreferences().pack).toBeNull()
    saveStatsPreferences({ range: 'day', custom: null, pack: 'jk:FAKE' })
    vi.stubEnv('VITE_FAKE_BLE', 'false')
    expect(loadStatsPreferences()).toEqual(preferences)
  })

  it('allows browsing when preference reads or writes are denied', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    expect(loadStatsPreferences()).toEqual({ range: 'week', custom: null, pack: null })
    expect(() => saveStatsPreferences(preferences)).not.toThrow()
  })
})
