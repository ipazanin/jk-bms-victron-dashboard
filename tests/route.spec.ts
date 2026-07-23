import { describe, expect, it } from 'vitest'

import { hashOf, parseRoute } from '../src/application/route'
import type { Route } from '../src/application/route'

describe('parseRoute', () => {
  it('treats an empty hash and a bare slash as the dashboard', () => {
    expect(parseRoute('')).toEqual({ name: 'dashboard' })
    expect(parseRoute('#')).toEqual({ name: 'dashboard' })
    expect(parseRoute('#/')).toEqual({ name: 'dashboard' })
  })

  it('resolves the standalone tabs', () => {
    expect(parseRoute('#/connect')).toEqual({ name: 'connect' })
    expect(parseRoute('#/stats')).toEqual({ name: 'stats' })
    expect(parseRoute('#/warnings')).toEqual({ name: 'warnings' })
    expect(parseRoute('#/log')).toEqual({ name: 'log' })
  })

  it('reads a session id out of the log segment', () => {
    expect(parseRoute('#/log/abc123')).toEqual({ name: 'session', id: 'abc123' })
  })

  it('decodes a percent-encoded session id', () => {
    expect(parseRoute('#/log/a%20b')).toEqual({ name: 'session', id: 'a b' })
  })

  it('falls back to the log list when the session segment is empty', () => {
    expect(parseRoute('#/log/')).toEqual({ name: 'log' })
  })

  it('falls back to the log list when a hand-edited id will not decode', () => {
    expect(parseRoute('#/log/%')).toEqual({ name: 'log' })
  })

  it('sends an unknown hash to the dashboard rather than an error page', () => {
    expect(parseRoute('#/nowhere')).toEqual({ name: 'dashboard' })
    expect(parseRoute('#/connect/extra')).toEqual({ name: 'connect' })
  })
})

describe('hashOf', () => {
  it('emits the canonical hash for every route', () => {
    expect(hashOf({ name: 'dashboard' })).toBe('#/')
    expect(hashOf({ name: 'connect' })).toBe('#/connect')
    expect(hashOf({ name: 'stats' })).toBe('#/stats')
    expect(hashOf({ name: 'warnings' })).toBe('#/warnings')
    expect(hashOf({ name: 'log' })).toBe('#/log')
    expect(hashOf({ name: 'session', id: 'abc123' })).toBe('#/log/abc123')
  })

  it('percent-encodes a session id that needs it', () => {
    expect(hashOf({ name: 'session', id: 'a b/c' })).toBe('#/log/a%20b%2Fc')
  })

  it('round-trips every route through parse', () => {
    const routes: Route[] = [
      { name: 'dashboard' },
      { name: 'connect' },
      { name: 'stats' },
      { name: 'warnings' },
      { name: 'log' },
      { name: 'session', id: 'weird id/with spaces' },
    ]
    for (const route of routes) {
      expect(parseRoute(hashOf(route))).toEqual(route)
    }
  })
})
