import { describe, expect, it } from 'vitest'

import { relativeAge } from '../src/application/format'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function ago(ms: number): string {
  const now = 1_000_000_000_000
  return relativeAge(now - ms, now)
}

describe('relativeAge', () => {
  it('reads under a minute as moments ago', () => {
    expect(ago(0)).toBe('moments ago')
    expect(ago(59 * SECOND)).toBe('moments ago')
  })

  it('switches to minutes at exactly one minute', () => {
    expect(ago(60 * SECOND)).toBe('1 min ago')
    expect(ago(59 * MINUTE)).toBe('59 min ago')
  })

  it('switches to hours at exactly one hour', () => {
    expect(ago(60 * MINUTE)).toBe('1 h ago')
    expect(ago(23 * HOUR)).toBe('23 h ago')
  })

  it('reads a full day as yesterday', () => {
    expect(ago(24 * HOUR)).toBe('yesterday')
  })

  it('reads two days and beyond in days', () => {
    expect(ago(48 * HOUR)).toBe('2 days ago')
    expect(ago(9 * DAY)).toBe('9 days ago')
  })

  it('never reports a negative age for a future timestamp', () => {
    expect(ago(-5 * MINUTE)).toBe('moments ago')
  })
})
