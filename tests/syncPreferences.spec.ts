// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applySharedPreferences, loadGoogleSyncState, saveGoogleSyncState } from '../src/application/sync/syncPreferences'
import { storageKey } from '../src/application/storageKey'
import remembered from './fixtures/rememberedSession.json'

beforeEach(() => localStorage.clear())
afterEach(() => { localStorage.clear(); vi.unstubAllEnvs() })

describe('shared settings persistence', () => {
  it('applies only shared settings and preserves local recorder and radio state exactly', () => {
    const preserved = {
      'shunt.rememberedSession': JSON.stringify({ ...remembered, bmsDeviceId: 'this-radio' }),
      'shunt.logbook': 'local logbook',
      'shunt.lastBmsDevice': 'local radio',
      'shunt.rejoinArmed': 'on',
      'victron.advertisementKey': 'a'.repeat(32),
    }
    for (const [key, stored] of Object.entries(preserved)) localStorage.setItem(key, stored)
    localStorage.setItem('shunt.sidebar', 'expanded')

    applySharedPreferences([{ key: 'shunt.theme', value: 'light' }, { key: 'victron.advertisementKey', value: 'b'.repeat(32) }], false)

    expect(localStorage.getItem('shunt.theme')).toBe('light')
    expect(localStorage.getItem('shunt.sidebar')).toBeNull()
    for (const [key, stored] of Object.entries(preserved)) expect(localStorage.getItem(key)).toBe(stored)
  })

  it('requires key opt-in and preserves a key absent from cloud settings', () => {
    localStorage.setItem('victron.advertisementKey', 'a'.repeat(32))
    applySharedPreferences([], true)
    expect(localStorage.getItem('victron.advertisementKey')).toBe('a'.repeat(32))
    applySharedPreferences([{ key: 'victron.advertisementKey', value: 'b'.repeat(32) }], true)
    expect(localStorage.getItem('victron.advertisementKey')).toBe('b'.repeat(32))
  })

  it('defaults to disabled and recovers from malformed browser preferences', () => {
    expect(loadGoogleSyncState()).toMatchObject({ enabled: false, includeSecret: false, workspace: null })
    localStorage.setItem('shunt.googleSync', '{broken')
    expect(loadGoogleSyncState().enabled).toBe(false)
    localStorage.setItem('shunt.googleSync', JSON.stringify({ enabled: true, workspace: { id: 4 }, settingsBaseline: {}, downloaded: [] }))
    expect(loadGoogleSyncState()).toMatchObject({ enabled: true, workspace: null, settingsBaseline: null, downloaded: {} })
  })

  it('loads a settings baseline stored with the former heads list', () => {
    const baseline = { workspaceId: 'sheet', localHash: 'a'.repeat(64), cloudHash: 'b'.repeat(64) }
    localStorage.setItem('shunt.googleSync', JSON.stringify({ enabled: true, settingsBaseline: { ...baseline, heads: ['revision'] } }))
    expect(loadGoogleSyncState().settingsBaseline).toEqual(baseline)
  })

  it('keeps fake-radio sync preferences separate from real history and stores no access token', () => {
    const saved = { ...loadGoogleSyncState(), enabled: true, sourceLabel: 'Boat tablet' }
    vi.stubEnv('VITE_FAKE_BLE', 'true')
    saveGoogleSyncState(saved)
    expect(localStorage.getItem('shunt.googleSync')).toBeNull()
    expect(JSON.parse(localStorage.getItem(storageKey('shunt.googleSync'))!)).toEqual(saved)
    expect(loadGoogleSyncState()).toEqual(saved)
    vi.stubEnv('VITE_FAKE_BLE', 'false')
    expect(loadGoogleSyncState().enabled).toBe(false)
  })
})
