// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from 'vue'
import type { App } from 'vue'

import { provideHistoryEnvironment } from '../src/application/history/historyBrowser'
import { unavailableHistoryStore } from '../src/application/history/port'
import type { HistoryUnavailableReason } from '../src/application/history/port'
import LogView from '../src/components/history/LogView.vue'

// A reader who opens the Log to an empty page is trying to work out whether the boat has a problem
// or the laptop does, so every unavailable archive owes them its own sentence. These assert the
// words as a reader meets them, which is also the only way a branch that stops being reachable
// stops passing.

let host: HTMLElement
let app: App | null = null

/** Mounted text with its wrapping collapsed, so the copy can be asserted as one sentence. */
function logViewShowing(reason: HistoryUnavailableReason): string {
  provideHistoryEnvironment({
    store: unavailableHistoryStore(reason),
    downloadJson: () => undefined,
  })
  app = createApp(LogView)
  app.mount(host)
  return (host.textContent ?? '').replace(/\s+/g, ' ')
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  app?.unmount()
  app = null
  host.remove()
})

describe('what the Log says when there is no archive to read', () => {
  it('names the older tab holding the database, and the one thing that fixes it', () => {
    // Nothing about the browser refused anything here: it would keep a log the moment the other tab
    // went away. Falling through to the private-browsing line sends the owner to settings that have
    // nothing to do with it, and never mentions the close-and-reload that ends it.
    const text = logViewShowing('open-blocked')

    expect(text).toContain(
      'Another tab is running an older version of this page and is holding the log open. Close it and reload.',
    )
    expect(text).not.toContain('private browsing')
  })

  it('still blames storage when storage is what refused', () => {
    const text = logViewShowing('no-indexeddb')

    expect(text).toContain('This browser will not keep a log.')
    expect(text).toContain('private browsing')
  })
})
