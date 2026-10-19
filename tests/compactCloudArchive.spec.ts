import { describe, expect, it } from 'vitest'
import { compactCloudArchive } from '../src/application/sync/compactCloudArchive'
import type { ArchiveSnapshot } from '../src/domain/backup/ArchiveSnapshot'
import { deviceRecord, packChunk, packSamples, SAMPLE_EPOCH, sessionRecord, warningRecord } from './support/samples'
import remembered from './fixtures/rememberedSession.json'
import { summarizeSessionHours } from '../src/domain/history/summarizeSessionHours'

describe('compact cloud capture', () => {
  it('retains archive context and latest readings without raw chunks or remembered trends', () => {
    const history = [{ at: SAMPLE_EPOCH, packCurrent: 1, packVoltage: 13, pvPower: 20, housePower: 7 }]
    const session = sessionRecord({ packSamples: 2, packChunks: 1, sealedSamples: 2, state: 'closed', endedAt: SAMPLE_EPOCH + 1000, endReason: 'user-disconnect' })
    const samples = packSamples(2)
    const hours = summarizeSessionHours(session.id, samples, [])
    const captured: ArchiveSnapshot = {
      format: 'shunt-archive', version: 2, exportedAt: SAMPLE_EPOCH,
      source: { id: 'browser', label: 'Boat' },
      stores: {
        sessions: [session], chunks: [packChunk(samples)], hours, devices: [deviceRecord()],
        meta: [{ key: 'totals', schema: 1, totalSamples: 2, createdAt: SAMPLE_EPOCH, lastPrunedAt: null }],
        warnings: [warningRecord()], ringRecords: [], ringReads: [],
      },
      preferences: [
        { key: 'shunt.theme', value: 'dark' },
        { key: 'shunt.rememberedSession', value: JSON.stringify({ ...remembered, capturedAt: SAMPLE_EPOCH, history }) },
      ],
    }
    const compact = compactCloudArchive(captured)
    expect(compact.version).toBe(2)
    expect(compact.stores.hours).toEqual(hours)
    expect(compact.stores.hours![0]!.moments.length).toBeGreaterThan(0)
    expect(compact.stores.chunks).toEqual([])
    expect(compact.stores.sessions[0]).toEqual({ ...captured.stores.sessions[0], sealedSamples: 0, packChunks: 0, solarChunks: 0, coverage: [] })
    expect(compact.stores.meta[0]!.totalSamples).toBe(0)
    expect(compact.stores.warnings).toEqual(captured.stores.warnings)
    const saved = JSON.parse(compact.preferences[1]!.value)
    expect(saved.battery).toEqual(remembered.battery)
    expect(saved.history).toEqual([])
    expect(compact.preferences[0]).toEqual(captured.preferences[0])
    expect(captured.stores.chunks).toHaveLength(1)
    expect(JSON.parse(captured.preferences[1]!.value).history).toEqual(history)
  })
})
