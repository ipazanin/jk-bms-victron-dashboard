import { describe, expect, it } from 'vitest'
import type { ArchiveSnapshot } from '../src/domain/backup/ArchiveSnapshot'
import { decodeArchiveSnapshot, decodeArchiveValue, encodeArchiveSnapshot, encodeArchiveValue, validateArchiveSnapshot } from '../src/domain/backup/archiveCodec'
import { ARCHIVE_ARRAY_TYPES } from '../src/domain/backup/archiveTransport'
import { hexToBytes } from '../src/domain/bytes'
import { foldSolarHistorySnapshot } from '../src/domain/history/solarLedger'
import type { HistoryChunk, SessionRecord } from '../src/domain/history/types'
import type { RingReadRow } from '../src/domain/history/RingReadRow'
import { SOLAR_DAY_FORMAT } from '../src/domain/history/StoredRowFormat'
import stored from './fixtures/storedSession.json'
import ring from './fixtures/ringLedger.json'
import remembered from './fixtures/rememberedSession.json'
import { deviceRecord, SAMPLE_EPOCH, sessionRecord, warningRecord } from './support/samples'
import { capturedSolarSnapshot } from './support/solarHistoryFixture'
import { summarizeSessionHours } from '../src/domain/history/summarizeSessionHours'
import { packSamples } from './support/samples'

function completeSnapshot(): ArchiveSnapshot {
  const solar = capturedSolarSnapshot()
  const folded = foldSolarHistorySnapshot([], solar, solar.observedAt)
  const chunks = stored.chunks.map((chunk) => {
    const columns = stored.columnTypes[chunk.stream as keyof typeof stored.columnTypes]
    const hydrated = Object.fromEntries(Object.entries(columns).map(([column, name]) => {
      const [constructor] = ARCHIVE_ARRAY_TYPES[name as keyof typeof ARCHIVE_ARRAY_TYPES]
      return [column, new constructor((chunk as unknown as Record<string, number[]>)[column]!)]
    }))
    return { ...chunk, ...hydrated } as unknown as HistoryChunk
  })
  return {
    format: 'shunt-archive', version: 1, exportedAt: solar.observedAt,
    source: { id: 'browser-boat', label: 'Boat tablet' },
    stores: {
      sessions: [stored.session as SessionRecord], chunks,
      devices: [deviceRecord({ ...stored.device, kind: 'pack', ...ring.device }), deviceRecord({ key: solar.deviceKey, kind: 'solar', userLabel: '=SUM(A1:A2)' })],
      meta: [{ key: 'totals', totalSamples: stored.session.sealedSamples, schema: 1, createdAt: SAMPLE_EPOCH, lastPrunedAt: null }],
      warnings: [warningRecord({ sessionId: stored.session.id, title: '=HYPERLINK("https://example.com")' })],
      ringRecords: [...ring.records.map((row) => ({ ...row, bytes: hexToBytes(row.bytes) })), ...folded.rows],
      ringReads: [...ring.reads as RingReadRow[], {
        deviceKey: solar.deviceKey, format: SOLAR_DAY_FORMAT, observedAt: solar.observedAt,
        outcome: solar.outcome, readOnDate: solar.readOnDate, totals: solar.totals,
        daysReceived: solar.days.length, daysAppended: folded.merge.appended,
        daysRevised: folded.merge.revised, daysUnchanged: folded.merge.unchanged,
        daysUnwritten: folded.merge.unwritten, daysRedated: folded.merge.redated,
        ...solar.transport,
      }],
    },
    preferences: [
      { key: 'shunt.theme', value: 'light' },
      { key: 'shunt.sidebar', value: 'collapsed' },
      { key: 'shunt.statsPreferences', value: JSON.stringify({ version: 1, range: 'all', custom: null, pack: stored.device.key }) },
      { key: 'shunt.rememberedSession', value: JSON.stringify({ ...remembered, capturedAt: SAMPLE_EPOCH }) },
      { key: 'shunt.logbook', value: JSON.stringify({ fetchedAt: SAMPLE_EPOCH, uptimeSecondsAtFetch: null, events: [{ secondsSinceBoot: 123, code: 4, label: 'Captured event' }] }) },
      { key: 'shunt.lastBmsDevice', value: JSON.stringify({ id: 'origin-only-pack', name: 'Pack', at: SAMPLE_EPOCH }) },
      { key: 'shunt.lastSolarController', value: JSON.stringify({ id: 'origin-only-solar', name: null, at: SAMPLE_EPOCH }) },
      { key: 'shunt.rejoinArmed', value: 'off' },
      { key: 'victron.advertisementKey', value: 'a'.repeat(32) },
    ],
  }
}

describe('complete archive contract', () => {
  it('round trips hourly history with original sample timestamps and calculation basis', () => {
    const legacy = completeSnapshot()
    const hours = summarizeSessionHours(stored.session.id, packSamples(3), [])
    const snapshot: ArchiveSnapshot = { ...legacy, version: 2, stores: { ...legacy.stores, hours } }
    expect(decodeArchiveSnapshot(encodeArchiveSnapshot(snapshot))).toEqual(snapshot)
    expect(snapshot.stores.hours![0]!.basis).toBe('reconstructed')
  })

  it('requires hourly history on v2 and preserves the v1 store contract', () => {
    const snapshot = completeSnapshot()
    expect(() => validateArchiveSnapshot({ ...snapshot, version: 2 })).toThrow('hourly history must match archive version')
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, hours: [] } })).toThrow('hourly history must match archive version')
  })

  it('rejects orphan or duplicate session hours', () => {
    const legacy = completeSnapshot()
    const [hour] = summarizeSessionHours(stored.session.id, packSamples(3), [])
    const snapshot = { ...legacy, version: 2, stores: { ...legacy.stores, hours: [hour] } }
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, hours: [hour, hour] } })).toThrow('duplicate identity')
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, hours: [{ ...hour, sessionId: 'missing' }] } })).toThrow('missing session')
  })

  it('rejects hourly data outside its supported boundary and calculation contract', () => {
    const legacy = completeSnapshot()
    const [hour] = summarizeSessionHours(stored.session.id, packSamples(3), [])
    for (const change of [{ hourStart: hour!.hourStart + 1 }, { to: hour!.hourStart + 3_600_001 }, { calculationVersion: 99 }]) {
      expect(() => validateArchiveSnapshot({ ...legacy, version: 2, stores: { ...legacy.stores, hours: [{ ...hour, ...change }] } })).toThrow()
    }
  })

  it('rejects an incorrect raw byte total', () => {
    const snapshot = completeSnapshot()
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, meta: [{ ...snapshot.stores.meta[0], rawBytes: 1 }] } })).toThrow('raw byte total disagrees')
  })

  it('round trips captured session columns, ring bytes, solar days, receipts and every preference', () => {
    const snapshot = completeSnapshot()
    const restored = decodeArchiveSnapshot(encodeArchiveSnapshot(snapshot))

    expect(restored).toEqual(snapshot)
    expect(restored.stores.chunks[0]!.offsetMs).toBeInstanceOf(Uint32Array)
    expect(restored.stores.ringRecords[0]).toMatchObject({ bytes: expect.any(Uint8Array) })
    expect(restored.stores.sessions[0]!.id).toBe(stored.session.id)
    expect(restored.stores.devices[1]!.userLabel).toBe('=SUM(A1:A2)')
    expect(restored.preferences).toHaveLength(9)
  })

  it('preserves typed array slices without exporting unrelated buffer bytes', () => {
    const backing = new Uint8Array([99, 1, 2, 88])
    const restored = decodeArchiveValue(encodeArchiveValue(backing.subarray(1, 3)))
    expect(restored).toEqual(new Uint8Array([1, 2]))
  })

  it('preserves explicitly absent optional metadata', () => {
    expect(decodeArchiveValue(encodeArchiveValue({ format: undefined }))).toEqual({ format: undefined })
  })

  it('accepts a new archive before its first metadata write', () => {
    const snapshot = completeSnapshot()
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { sessions: [], chunks: [], devices: [], meta: [], warnings: [], ringRecords: [], ringReads: [] } })).not.toThrow()
  })

  it('preserves lifetime counters and references to sessions removed by pruning', () => {
    const snapshot = completeSnapshot()
    const session = snapshot.stores.sessions[0]!
    expect(() => validateArchiveSnapshot({
      ...snapshot,
      stores: { ...snapshot.stores, sessions: [{ ...session, packSamples: session.packSamples + 300, retainedFrom: session.startedAt, continues: 'evicted-session' }] },
    })).not.toThrow()
  })

  it('accepts a checkpoint whose other stream has not persisted its newest tail', () => {
    const snapshot = completeSnapshot()
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: {
      sessions: [sessionRecord({ packSamples: 1, packChunks: 1 })], chunks: [], devices: [deviceRecord()], meta: [], warnings: [], ringRecords: [], ringReads: [],
    } })).not.toThrow()
  })

  it.each([
    'sessions', 'chunks', 'devices', 'meta', 'warnings', 'ringRecords', 'ringReads',
  ] as const)('rejects duplicate identities in %s', (store) => {
    const snapshot = completeSnapshot()
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, [store]: [...snapshot.stores[store], snapshot.stores[store][0]] } })).toThrow('duplicate identity')
  })

  it('rejects duplicate preferences', () => {
    const snapshot = completeSnapshot()
    expect(() => validateArchiveSnapshot({ ...snapshot, preferences: [...snapshot.preferences, snapshot.preferences[0]] })).toThrow('duplicate identity')
  })

  it('rejects orphan chunks and mismatched device kinds while allowing absent device metadata', () => {
    const snapshot = completeSnapshot()
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, sessions: [] } })).toThrow('missing session')
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, devices: [] } })).not.toThrow()
    const wrongDevices = snapshot.stores.devices.map((device) => ({ ...device, kind: device.kind === 'pack' ? 'solar' : 'pack' }))
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, devices: wrongDevices } })).toThrow('wrong device kind')
  })

  it('rejects a changed ring counter without changing its bytes', () => {
    const snapshot = completeSnapshot()
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, ringRecords: [{ ...snapshot.stores.ringRecords[0], packClockSeconds: 1 }] } })).toThrow('counter disagrees')
  })

  it('rejects sample totals that no longer match the sealed chunks', () => {
    const snapshot = completeSnapshot()
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, meta: [{ ...snapshot.stores.meta[0], totalSamples: 1 }] } })).toThrow('archive sample total')
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, sessions: [{ ...snapshot.stores.sessions[0], sealedSamples: 1 }] } })).toThrow('sealed sample total')
  })

  it('rejects truncated columns, wrong column types and duplicate offsets', () => {
    const snapshot = completeSnapshot()
    for (const offsetMs of [new Uint32Array(1), new Int32Array(snapshot.stores.chunks[0]!.length), new Uint32Array(snapshot.stores.chunks[0]!.length)]) {
      expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, chunks: [{ ...snapshot.stores.chunks[0], offsetMs }] } })).toThrow()
    }
  })

  it.each([256, -1, 1.5, 1e100])('rejects typed-array integer %s before narrowing can hide corruption', (integer) => {
    expect(() => decodeArchiveValue(JSON.stringify({ $typedArray: 'Uint8Array', values: [integer] }))).toThrow('integer outside its range')
  })

  it('rejects unknown transport arrays, nonfinite numbers and unsafe object keys', () => {
    expect(() => decodeArchiveValue('{"$typedArray":"Float64Array","values":[1]}')).toThrow('unsupported typed array')
    expect(() => decodeArchiveValue('{"__proto__":{"polluted":true}}')).toThrow('unsafe property')
    expect(() => encodeArchiveValue({ at: NaN })).toThrow('nonfinite number')
  })

  it('rejects unsupported schema versions and unknown settings', () => {
    const snapshot = completeSnapshot()
    expect(() => validateArchiveSnapshot({ ...snapshot, version: 3 })).toThrow('unsupported value')
    expect(() => validateArchiveSnapshot({ ...snapshot, preferences: [{ key: 'unrelated.account.token', value: 'opaque' }] })).toThrow('unsupported value')
    expect(() => validateArchiveSnapshot({ ...snapshot, preferences: [{ key: 'shunt.statsPreferences', value: '{"version":1,"range":"custom","custom":null,"pack":null}' }] })).toThrow('custom range needs dates')
  })

  it('rejects unknown stores and malformed extra metadata instead of dropping them', () => {
    const snapshot = completeSnapshot()
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, unknown: [] } })).toThrow('unexpected field')
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, devices: [{ ...snapshot.stores.devices[0], futureReading: NaN }] } })).toThrow('nonfinite number')
    expect(() => encodeArchiveValue({ metadata: { $typedArray: 'Uint8Array', values: [1] } })).toThrow('reserved property')
  })

  it('preserves extra row metadata without interpreting its text', () => {
    const snapshot = completeSnapshot()
    const enriched = { ...snapshot, stores: { ...snapshot.stores, devices: snapshot.stores.devices.map((device) => ({ ...device, annotation: { label: '@SUM(1,2)', quality: 3 } })) } }
    expect(decodeArchiveSnapshot(encodeArchiveSnapshot(enriched))).toEqual(enriched)
  })

  it('rejects impossible solar calendar dates and malformed remembered readings', () => {
    const snapshot = completeSnapshot()
    const day = snapshot.stores.ringRecords.find((row) => row.format === SOLAR_DAY_FORMAT)!
    expect(() => validateArchiveSnapshot({ ...snapshot, stores: { ...snapshot.stores, ringRecords: [{ ...day, date: '2026-02-31' }] } })).toThrow('invalid calendar date')
    expect(() => validateArchiveSnapshot({ ...snapshot, preferences: [{ key: 'shunt.rememberedSession', value: JSON.stringify({ ...remembered, battery: { ...remembered.battery, chargingEnabled: 'true' } }) }] })).toThrow('expected a boolean')
  })
})
