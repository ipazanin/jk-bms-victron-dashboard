// @vitest-environment jsdom
import 'fake-indexeddb/auto'

import { describe, expect, it } from 'vitest'

import archive from './fixtures/storedSession.json'

/**
 * The fixture the visual check seeds must survive a round trip through the REAL adapter, not just
 * through the pure decoders. historyLedger.spec.ts reads it directly, which proves the columns
 * decode but proves nothing about whether the adapter can find the chunks it wrote.
 */

const COLUMN_TYPES: Record<string, new (values: number[]) => ArrayBufferView> = {
  offsetMs: Uint32Array,
  currentMa: Int32Array,
  packVoltageMv: Uint32Array,
  remainingCapacityMah: Uint32Array,
  cellDeltaMv: Uint16Array,
  mosfetDeciC: Int16Array,
  temperature1DeciC: Int16Array,
  temperature2DeciC: Int16Array,
  stateOfCharge: Uint8Array,
  highestCell: Uint8Array,
  lowestCell: Uint8Array,
  switches: Uint8Array,
  batteryVoltageCv: Int16Array,
  batteryCurrentDa: Int16Array,
  yieldTodayDawh: Uint16Array,
  pvPowerW: Uint16Array,
  loadCurrentDa: Uint16Array,
  chargeStateCode: Uint8Array,
  chargerError: Uint8Array,
  rssiDbm: Int8Array,
}

function seed(): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(archive.database.name, archive.database.version)
    open.onupgradeneeded = () => {
      const created = open.result
      const sessions = created.createObjectStore('sessions', { keyPath: 'id' })
      sessions.createIndex('byStartedAt', 'startedAt')
      sessions.createIndex('byDevice', ['groupKey', 'startedAt'])
      sessions.createIndex('byState', 'state')
      const chunks = created.createObjectStore('chunks', { keyPath: ['sessionId', 'stream', 'seq'] })
      chunks.createIndex('bySession', 'sessionId')
      const devices = created.createObjectStore('devices', { keyPath: 'key' })
      devices.createIndex('byLastSeen', 'lastSeenAt')
      created.createObjectStore('meta', { keyPath: 'key' })
    }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const database = open.result
      const transaction = database.transaction(['sessions', 'chunks', 'devices', 'meta'], 'readwrite')
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)

      transaction.objectStore('devices').put(archive.device)
      transaction.objectStore('sessions').put(archive.session)
      transaction.objectStore('meta').put(archive.meta)
      for (const chunk of archive.chunks as Record<string, unknown>[]) {
        const widened: Record<string, unknown> = { ...chunk }
        for (const [column, Typed] of Object.entries(COLUMN_TYPES)) {
          const stored = chunk[column]
          if (stored === undefined) continue
          widened[column] = new Typed(
            Array.isArray(stored) ? (stored as number[]) : (Object.values(stored as object) as number[]),
          )
        }
        transaction.objectStore('chunks').put(widened)
      }
    }
  })
}

describe('the seeded fixture through the real adapter', () => {
  it('returns the session in the list AND its samples in the timeline', async () => {
    await seed()

    const { openHistoryStore } = await import('../src/infrastructure/history/openHistoryStore')
    const store = await openHistoryStore()
    expect(store.availability.usable).toBe(true)

    const sessions = await store.listSessions()
    expect(sessions).not.toHaveLength(0)

    const loaded = await store.readSession(archive.session.id as never)
    expect(loaded).not.toBeNull()
    // This is the assertion the visual check was really making when it waited for the ledger:
    // a session that lists but yields no chunks renders a shell with no instrument in it.
    expect(loaded!.pack.length).toBeGreaterThan(0)
    expect(loaded!.solar.length).toBeGreaterThan(0)
  })
})
