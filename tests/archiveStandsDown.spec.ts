// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import type { App as MountedApp } from 'vue'

import { provideHistoryEnvironment, useHistoryBrowser } from '../src/application/history/historyBrowser'
import type { HistoryStore } from '../src/application/history/port'
import LogView from '../src/components/history/LogView.vue'
import { DATABASE_VERSION } from '../src/infrastructure/history/IdbHistoryStore'
import { openHistoryStore } from '../src/infrastructure/history/openHistoryStore'
import { SESSION_ID, sessionClosure, sessionRecord } from './support/samples'

/**
 * An archive that stands down, read off the screen rather than off the store.
 *
 * Another tab opening this database at a higher version is what fires `versionchange`, and the
 * connection here answers it by letting go: recording stops, every read comes back empty, and the
 * only honest thing left to say is that this browser is holding a log a newer build wrote. None of
 * that is a different store — it is one object revising what it can do — so nothing that watches
 * the store's identity can see it happen.
 *
 * That is the whole reason this file drives a real database under a real Log and asserts on the
 * words on screen. The same failure passed a suite that asked the store what it thought of itself:
 * the store had stood down, said so when asked, and the page went on printing the archive it had at
 * first paint with every session still listed under it.
 */

const ARCHIVE = 'shunt.log.standsdown'

let store: HistoryStore
let mounted: MountedApp | null = null
let host: HTMLElement
/** The connection that forces the upgrade, kept so the run does not end holding a database open. */
let newerBuild: IDBDatabase | null = null

/** What the Log says now, wrapping collapsed so the copy reads as one sentence. */
function painted(): string {
  return (host.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Another tab of a newer build, opening the same archive one version up. */
function openTheArchiveOneVersionHigher(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(ARCHIVE, DATABASE_VERSION + 1)
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error ?? new Error('open failed')))
    request.addEventListener('blocked', () =>
      reject(new Error('the open tab never let go of the archive')),
    )
  })
}

beforeAll(async () => {
  store = await openHistoryStore(ARCHIVE)
  // One real row, so the screen has an archive to stop being able to show.
  await store.openSession(sessionRecord())
  await store.closeSession(SESSION_ID, sessionClosure())

  host = document.createElement('div')
  document.body.append(host)
  provideHistoryEnvironment({ store, downloadJson: () => undefined })
  mounted = createApp(LogView)
  mounted.mount(host)
})

afterAll(() => {
  mounted?.unmount()
  mounted = null
  host.remove()
  newerBuild?.close()
  store.close()
})

describe('an archive that steps aside for a newer build', () => {
  it('takes the Log to the screen that says so, with the sessions it can no longer read gone', async () => {
    await vi.waitFor(() => expect(painted()).toContain('1 session'))

    const before = painted()
    expect(before).toContain('Every session this browser recorded')
    expect(before).not.toContain('recorded by a newer version')

    newerBuild = await openTheArchiveOneVersionHigher()

    await vi.waitFor(() =>
      expect(painted()).toContain(
        'This browser holds a log recorded by a newer version of this page. It is left untouched.',
      ),
    )
    const after = painted()
    // The rows went with the connection. A Log that kept listing them offers the reader a session
    // it can no longer open, and says the archive is fine in the same breath as saying it is not.
    expect(after).not.toContain('1 session')

    // Not the assertion — the evidence that the screen above changed for the real reason.
    expect(store.availability).toMatchObject({ usable: false, reason: 'version-newer' })
    expect(useHistoryBrowser().availability.value).toMatchObject({ reason: 'version-newer' })
  })
})
