// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyTheme,
  forgetThemeChoice,
  loadThemeChoice,
  resolveTheme,
  saveThemeChoice,
  themeFromQuery,
} from '../src/application/theme'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  // Unstub before clearing: the denied-storage case installs a localStorage with no clear().
  vi.unstubAllGlobals()
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

describe('the stored choice', () => {
  it('round-trips both planes', () => {
    saveThemeChoice('light')
    expect(loadThemeChoice()).toBe('light')
    saveThemeChoice('dark')
    expect(loadThemeChoice()).toBe('dark')
  })

  it('reports null when nothing was ever chosen, which is not the same as dark', () => {
    expect(loadThemeChoice()).toBeNull()
  })

  it('treats a hand-edited entry as no answer rather than as an error', () => {
    localStorage.setItem('shunt.theme', 'sepia')
    expect(loadThemeChoice()).toBeNull()
  })

  it('survives storage being denied, as in private browsing', () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('denied')
      },
      setItem() {
        throw new Error('denied')
      },
      removeItem() {
        throw new Error('denied')
      },
    })
    expect(loadThemeChoice()).toBeNull()
    expect(() => saveThemeChoice('light')).not.toThrow()
    expect(() => forgetThemeChoice()).not.toThrow()
  })

  it('forgetting returns the page to following the system', () => {
    saveThemeChoice('light')
    forgetThemeChoice()
    expect(loadThemeChoice()).toBeNull()
  })
})

describe('themeFromQuery', () => {
  it('reads an explicit request for either plane', () => {
    expect(themeFromQuery('?theme=light')).toBe('light')
    expect(themeFromQuery('?theme=dark')).toBe('dark')
  })

  it('is not an instruction unless it names a plane', () => {
    expect(themeFromQuery('')).toBeNull()
    expect(themeFromQuery('?theme=')).toBeNull()
    expect(themeFromQuery('?theme=neon')).toBeNull()
    expect(themeFromQuery('?demo')).toBeNull()
  })
})

describe('resolveTheme precedence', () => {
  it('lets the URL pin the render over everything else', () => {
    expect(resolveTheme('dark', 'light', true)).toBe('dark')
    expect(resolveTheme('light', 'dark', false)).toBe('light')
  })

  it('prefers the owner’s choice over the system', () => {
    expect(resolveTheme(null, 'dark', true)).toBe('dark')
    expect(resolveTheme(null, 'light', false)).toBe('light')
  })

  it('follows the system while no choice has been made', () => {
    expect(resolveTheme(null, null, true)).toBe('light')
    expect(resolveTheme(null, null, false)).toBe('dark')
  })

  it('resolves an unanswered question to the designed default', () => {
    expect(resolveTheme(null, null, false)).toBe('dark')
  })
})

describe('applyTheme', () => {
  it('writes the plane the stylesheet keys off', () => {
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
