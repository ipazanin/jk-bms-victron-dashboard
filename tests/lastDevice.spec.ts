// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import { forgetLastDevice, loadLastDevice, saveLastDevice } from '../src/application/lastDevice'

const KEY = 'shunt.lastBmsDevice'

beforeEach(() => {
  localStorage.clear()
})

describe('lastDevice', () => {
  it('round-trips id, name and time through save and load', () => {
    saveLastDevice('jk-abc', 'JK_B2A8S20P', 1_700_000_000_000)
    expect(loadLastDevice()).toEqual({ id: 'jk-abc', name: 'JK_B2A8S20P', at: 1_700_000_000_000 })
  })

  it('returns null when nothing was ever saved', () => {
    expect(loadLastDevice()).toBeNull()
  })

  it('keeps a device that has no advertised name', () => {
    saveLastDevice('jk-abc', null, 42)
    expect(loadLastDevice()).toEqual({ id: 'jk-abc', name: null, at: 42 })
  })

  it('refuses to save an empty id', () => {
    saveLastDevice('', 'nameless', 1)
    expect(loadLastDevice()).toBeNull()
  })

  it('discards a stored record whose id is missing', () => {
    localStorage.setItem(KEY, JSON.stringify({ name: 'x', at: 1 }))
    expect(loadLastDevice()).toBeNull()
  })

  it('tolerates a missing name or time, defaulting them', () => {
    localStorage.setItem(KEY, JSON.stringify({ id: 'jk-abc' }))
    expect(loadLastDevice()).toEqual({ id: 'jk-abc', name: null, at: 0 })
  })

  it('discards non-JSON garbage rather than throwing', () => {
    localStorage.setItem(KEY, 'not json {')
    expect(loadLastDevice()).toBeNull()
  })

  it('forget removes the record', () => {
    saveLastDevice('jk-abc', 'JK', 1)
    forgetLastDevice()
    expect(loadLastDevice()).toBeNull()
  })
})
