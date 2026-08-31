/**
 * The guard on the one thing playback must never do: overwrite the browser state the real page runs
 * on. Both builds are served from the same origin, so localStorage is a single shared drawer, and
 * every write below is one a fake session makes within seconds of starting — the encryption key
 * before the first solar attempt, the last pack on every connect, the remembered snapshot every
 * fifteen seconds. Two of them cost real work to restore: the key can only be read back out of
 * VictronConnect, and the remembered snapshot is what the dashboard paints before it has talked to
 * anything.
 *
 * The routing is asserted rather than the round trip, because a read that goes to the wrong key is
 * the failure that looks like it works: the fake finds nothing, writes its own, and the real entry
 * is gone by the time anyone notices.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  forgetLastController,
  loadLastController,
  saveLastController,
} from '../src/application/lastController'
import { forgetLastDevice, loadLastDevice, saveLastDevice } from '../src/application/lastDevice'
import { forgetLogbook, loadLogbook, saveLogbook } from '../src/application/logbook'
import { loadRejoinIntent, saveRejoinIntent } from '../src/application/rejoinIntent'
import {
  forgetRememberedSession,
  loadRememberedSession,
  saveRememberedSession,
} from '../src/application/rememberedSession'
import {
  forgetAdvertisementKey,
  forgetSupersededSolarLiveTransport,
  loadAdvertisementKey,
  saveAdvertisementKey,
} from '../src/application/storage'
import { storageKey } from '../src/application/storageKey'
import { SAMPLE_EPOCH, rememberedSession } from './support/samples'

class RecordingStorage {
  private readonly entries = new Map<string, string>()
  private readonly reads: string[] = []
  private readonly removals: string[] = []

  getItem(key: string): string | null {
    this.reads.push(key)
    return this.entries.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value)
  }

  removeItem(key: string): void {
    this.removals.push(key)
    this.entries.delete(key)
  }

  seed(key: string, value: string): void {
    this.entries.set(key, value)
  }

  valueAt(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  keysTouched(): readonly string[] {
    return [...this.entries.keys()]
  }

  keysRead(): readonly string[] {
    return [...this.reads]
  }

  /**
   * Recorded rather than inferred from what is left: a removal aimed at the real page's key clears
   * an entry a fake session never wrote, so the map alone shows nothing at all.
   */
  keysRemoved(): readonly string[] {
    return [...this.removals]
  }

  forget(): void {
    this.entries.clear()
    this.reads.length = 0
    this.removals.length = 0
  }
}

let storage: RecordingStorage

/** Every entry the fake would otherwise share with the real page, and how each one is driven. */
const namespacedEntries = [
  {
    what: 'the Victron encryption key',
    key: 'victron.advertisementKey',
    write: (): void => saveAdvertisementKey('0123456789abcdef0123456789abcdef'),
    read: (): void => void loadAdvertisementKey(),
    forget: (): void => forgetAdvertisementKey(),
  },
  {
    what: 'the last pack connected to',
    key: 'shunt.lastBmsDevice',
    write: (): void => saveLastDevice('fake-pack', 'JK_B2A8S20P', SAMPLE_EPOCH),
    read: (): void => void loadLastDevice(),
    forget: (): void => forgetLastDevice(),
  },
  {
    what: 'the last controller watched',
    key: 'shunt.lastSolarController',
    write: (): void => saveLastController('fake-controller', 'SmartSolar HQ', SAMPLE_EPOCH),
    read: (): void => void loadLastController(),
    forget: (): void => forgetLastController(),
  },
  {
    what: 'the standing answer about rejoining',
    key: 'shunt.rejoinArmed',
    write: (): void => saveRejoinIntent(false),
    read: (): void => void loadRejoinIntent(),
    forget: null,
  },
  {
    what: "the pack's logbook",
    key: 'shunt.logbook',
    write: (): void =>
      saveLogbook({ fetchedAt: SAMPLE_EPOCH, uptimeSecondsAtFetch: 3_600, events: [] }),
    read: (): void => void loadLogbook(),
    forget: (): void => forgetLogbook(),
  },
  {
    what: 'the remembered session',
    key: 'shunt.rememberedSession',
    write: (): void => saveRememberedSession(rememberedSession()),
    read: (): void => void loadRememberedSession(),
    forget: (): void => forgetRememberedSession(),
  },
]

beforeEach(() => {
  storage = new RecordingStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('storageKey', () => {
  it('hands back the name unchanged when the radios are real', () => {
    expect(storageKey('shunt.logbook')).toBe('shunt.logbook')
  })

  it('suffixes the name when the radios are a fixture being played back', () => {
    vi.stubEnv('VITE_FAKE_BLE', 'true')
    expect(storageKey('shunt.logbook')).toBe('shunt.logbook.fake')
  })
})

describe('persistence under fake radios', () => {
  it('writes every namespaced entry to a key of its own', () => {
    vi.stubEnv('VITE_FAKE_BLE', 'true')

    const written: Record<string, readonly string[]> = {}
    for (const entry of namespacedEntries) {
      storage.forget()
      entry.write()
      written[entry.what] = storage.keysTouched()
    }

    expect(written).toEqual({
      'the Victron encryption key': ['victron.advertisementKey.fake'],
      'the last pack connected to': ['shunt.lastBmsDevice.fake'],
      'the last controller watched': ['shunt.lastSolarController.fake'],
      'the standing answer about rejoining': ['shunt.rejoinArmed.fake'],
      "the pack's logbook": ['shunt.logbook.fake'],
      'the remembered session': ['shunt.rememberedSession.fake'],
    })
  })

  it('reads every namespaced entry from a key of its own', () => {
    vi.stubEnv('VITE_FAKE_BLE', 'true')

    const consulted: Record<string, readonly string[]> = {}
    for (const entry of namespacedEntries) {
      storage.forget()
      entry.read()
      consulted[entry.what] = storage.keysRead()
    }

    expect(consulted).toEqual({
      'the Victron encryption key': ['victron.advertisementKey.fake'],
      'the last pack connected to': ['shunt.lastBmsDevice.fake'],
      'the last controller watched': ['shunt.lastSolarController.fake'],
      'the standing answer about rejoining': ['shunt.rejoinArmed.fake'],
      "the pack's logbook": ['shunt.logbook.fake'],
      'the remembered session': ['shunt.rememberedSession.fake'],
    })
  })

  it('leaves the real entry standing through a write and a clear', () => {
    vi.stubEnv('VITE_FAKE_BLE', 'true')
    for (const entry of namespacedEntries) storage.seed(entry.key, 'what the boat wrote')

    for (const entry of namespacedEntries) {
      entry.write()
      entry.forget?.()
    }

    for (const entry of namespacedEntries) {
      expect(storage.valueAt(entry.key)).toBe('what the boat wrote')
    }
  })
})

describe('persistence under real radios', () => {
  it('writes every entry to its plain key', () => {
    const written: Record<string, readonly string[]> = {}
    for (const entry of namespacedEntries) {
      storage.forget()
      entry.write()
      written[entry.what] = storage.keysTouched()
    }

    expect(written).toEqual({
      'the Victron encryption key': ['victron.advertisementKey'],
      'the last pack connected to': ['shunt.lastBmsDevice'],
      'the last controller watched': ['shunt.lastSolarController'],
      'the standing answer about rejoining': ['shunt.rejoinArmed'],
      "the pack's logbook": ['shunt.logbook'],
      'the remembered session': ['shunt.rememberedSession'],
    })
  })

  it('clears the plain key it wrote, leaving nothing for a later load to find', () => {
    for (const entry of namespacedEntries) {
      const clear = entry.forget
      if (clear === null) continue
      storage.forget()
      entry.write()
      clear()
      expect(storage.keysTouched(), entry.what).toEqual([])
    }
  })
})

/**
 * The one write a playback session makes that nothing else on the page would notice: a removal
 * aimed at the wrong name would silently take the boat's entry with it.
 */
describe('clearing the transport a browser no longer records', () => {
  it('removes the suffixed entry under playback, and leaves the real one alone', () => {
    vi.stubEnv('VITE_FAKE_BLE', 'true')
    storage.seed('victron.liveTransport', 'watch')

    forgetSupersededSolarLiveTransport()

    expect(storage.keysRemoved()).toEqual(['victron.liveTransport.fake'])
    expect(storage.valueAt('victron.liveTransport')).toBe('watch')
  })

  it('removes the plain entry under real radios', () => {
    storage.seed('victron.liveTransport', 'watch')

    forgetSupersededSolarLiveTransport()

    expect(storage.keysRemoved()).toEqual(['victron.liveTransport'])
    expect(storage.valueAt('victron.liveTransport')).toBeNull()
  })
})
