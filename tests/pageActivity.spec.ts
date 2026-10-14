// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { browserPageActivity } from '../src/application/pageActivity'

let visible: boolean
let focused: boolean
let unsubscribe: (() => void) | undefined

beforeEach(() => {
  visible = true
  focused = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
})

afterEach(() => {
  unsubscribe?.()
  unsubscribe = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('browser page activity', () => {
  it.each(['visibility-first', 'focus-first'])('reads current activity in %s event order', (order) => {
    visible = false
    focused = false
    const activity = browserPageActivity()
    const onChange = vi.fn(() => [activity.visible(), activity.focused()])
    unsubscribe = activity.subscribe(onChange)

    const show = (): void => {
      visible = true
      document.dispatchEvent(new Event('visibilitychange'))
    }
    const focus = (): void => {
      focused = true
      window.dispatchEvent(new Event('focus'))
    }

    if (order === 'visibility-first') {
      show()
      expect(onChange).toHaveLastReturnedWith([true, false])
      focus()
    } else {
      focus()
      expect(onChange).toHaveLastReturnedWith([false, true])
      show()
    }

    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveLastReturnedWith([true, true])

    focused = false
    window.dispatchEvent(new Event('blur'))
    expect(onChange).toHaveLastReturnedWith([true, false])

    visible = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(onChange).toHaveLastReturnedWith([false, false])
  })

  it('requests reconciliation on resume while the frozen page remains hidden', () => {
    visible = false
    focused = false
    const activity = browserPageActivity()
    const onChange = vi.fn(() => [activity.visible(), activity.focused()])
    unsubscribe = activity.subscribe(onChange)

    document.dispatchEvent(new Event('resume'))

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveReturnedWith([false, false])
  })

  it.each([false, true])('requests reconciliation on pageshow with persisted=%s', (persisted) => {
    const activity = browserPageActivity()
    const onChange = vi.fn(() => [activity.visible(), activity.focused()])
    unsubscribe = activity.subscribe(onChange)

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted }))

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveReturnedWith([true, true])
  })

  it('reports resume and pageshow even when activity has not changed', () => {
    const onChange = vi.fn()
    unsubscribe = browserPageActivity().subscribe(onChange)

    document.dispatchEvent(new Event('resume'))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))

    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('removes all activity and restore listeners on unsubscribe', () => {
    const onChange = vi.fn()
    const documentAdded = vi.spyOn(document, 'addEventListener')
    const documentRemoved = vi.spyOn(document, 'removeEventListener')
    const windowAdded = vi.spyOn(window, 'addEventListener')
    const windowRemoved = vi.spyOn(window, 'removeEventListener')
    unsubscribe = browserPageActivity().subscribe(onChange)

    expect(documentAdded.mock.calls.map(([eventName]) => eventName)).toEqual(['visibilitychange', 'resume'])
    expect(windowAdded.mock.calls.map(([eventName]) => eventName)).toEqual(['focus', 'blur', 'pageshow'])

    unsubscribe()

    for (const [eventName, listener] of documentAdded.mock.calls) {
      expect(documentRemoved).toHaveBeenCalledWith(eventName, listener)
      document.dispatchEvent(new Event(eventName))
    }
    for (const [eventName, listener] of windowAdded.mock.calls) {
      expect(windowRemoved).toHaveBeenCalledWith(eventName, listener)
      window.dispatchEvent(new Event(eventName))
    }
    expect(onChange).not.toHaveBeenCalled()
  })

  it('allows subscribers to unsubscribe independently', () => {
    const activity = browserPageActivity()
    const firstSubscriber = vi.fn()
    const secondSubscriber = vi.fn()
    const unsubscribeFirst = activity.subscribe(firstSubscriber)
    unsubscribe = activity.subscribe(secondSubscriber)

    unsubscribeFirst()
    document.dispatchEvent(new Event('resume'))

    expect(firstSubscriber).not.toHaveBeenCalled()
    expect(secondSubscriber).toHaveBeenCalledOnce()
  })

  it('treats an environment without a document as active without installing listeners', () => {
    vi.stubGlobal('document', undefined)
    const windowAdded = vi.spyOn(window, 'addEventListener')
    const activity = browserPageActivity()
    unsubscribe = activity.subscribe(vi.fn())

    expect(activity.visible()).toBe(true)
    expect(activity.focused()).toBe(true)
    expect(windowAdded).not.toHaveBeenCalled()
    expect(unsubscribe).not.toThrow()
  })

  it('skips listeners when a window is unavailable', () => {
    vi.stubGlobal('window', undefined)
    const documentAdded = vi.spyOn(document, 'addEventListener')
    unsubscribe = browserPageActivity().subscribe(vi.fn())

    expect(documentAdded).not.toHaveBeenCalled()
    expect(unsubscribe).not.toThrow()
  })

  it('treats focus as available when the document cannot report it', () => {
    vi.stubGlobal('document', { visibilityState: 'visible' })

    expect(browserPageActivity().focused()).toBe(true)
  })
})
