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


const ARCHIVE = 'shunt.log.standsdown'

let store: HistoryStore
let mounted: MountedApp | null = null
let host: HTMLElement
let newerBuild: IDBDatabase | null = null

function painted(): string {
  return (host.textContent ?? '').replace(/\s+/g, ' ').trim()
}

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
    expect(before).toContain('Sessions from this browser')
    expect(before).not.toContain('recorded by a newer version')

    newerBuild = await openTheArchiveOneVersionHigher()

    await vi.waitFor(() =>
      expect(painted()).toContain(
        'This browser holds a log recorded by a newer version of this page. It is left untouched.',
      ),
    )
    const after = painted()
    expect(after).not.toContain('1 session')
    expect(store.availability).toMatchObject({ usable: false, reason: 'version-newer' })
    expect(useHistoryBrowser().availability.value).toMatchObject({ reason: 'version-newer' })
  })
})
