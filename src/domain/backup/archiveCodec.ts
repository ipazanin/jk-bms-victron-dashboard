import type { ArchiveSnapshot } from './ArchiveSnapshot'
import type { HistoryChunk } from '../history/types'
import { MAX_SESSION_WARNINGS } from '../history/types'
import { sampleBytes } from '../history/columns'
import { SOLAR_DAY_FORMAT } from '../history/StoredRowFormat'
import { groupKeyFor } from '../history/identity'
import { decodeArchiveValue, encodeArchiveValue, validateArchiveValue } from './archiveTransport'
import { historyChunk } from './chunkValidation'
import { archivePreference } from './preferenceValidation'
import { sessionHour } from './sessionHourValidation'
import { deviceRecord, historyMeta, ringRead, ringRecord, sessionRecord, solarDay, solarRead, warningRecord } from './recordValidation'
import { choice, identity, list, optional, record, requireArchive, shape, timestamp } from './validation'

export { decodeArchiveValue, encodeArchiveValue } from './archiveTransport'

export const ARCHIVE_FORMAT = 'shunt-archive'
export const ARCHIVE_VERSION = 2

export function encodeArchiveSnapshot(snapshot: ArchiveSnapshot): string {
  validateArchiveSnapshot(snapshot)
  return encodeArchiveValue(snapshot)
}

export function decodeArchiveSnapshot(serialized: string): ArchiveSnapshot {
  const snapshot = decodeArchiveValue(serialized)
  validateArchiveSnapshot(snapshot)
  return snapshot
}

export function validateArchiveSnapshot(input: unknown): asserts input is ArchiveSnapshot {
  validateArchiveValue(input)
  shape({
    format: choice(ARCHIVE_FORMAT), version: choice(1, ARCHIVE_VERSION), exportedAt: timestamp,
    source: shape({ id: identity, label: identity }, true),
    stores: shape({
      sessions: list(sessionRecord), chunks: list(historyChunk), devices: list(deviceRecord),
      meta: list(historyMeta), warnings: list(warningRecord),
      hours: optional(list(sessionHour)),
      ringRecords: list((row, path) => (record(row, path).format === SOLAR_DAY_FORMAT ? solarDay : ringRecord)(row, path)),
      ringReads: list((row, path) => (record(row, path).format === SOLAR_DAY_FORMAT ? solarRead : ringRead)(row, path)),
    }, true),
    preferences: list(archivePreference),
  }, true)(input, 'snapshot')

  const snapshot = input as ArchiveSnapshot
  requireArchive(snapshot.version === 1 ? snapshot.stores.hours === undefined : snapshot.stores.hours !== undefined, 'stores.hours', 'hourly history must match archive version')
  requireArchive(snapshot.source.id.length <= 1024, 'source.id', 'source identity exceeds 1024 characters')
  try {
    encodeURIComponent(snapshot.source.id)
  } catch {
    requireArchive(false, 'source.id', 'source identity must contain valid Unicode')
  }
  const { sessions, chunks, devices, meta, warnings, ringRecords, ringReads } = snapshot.stores
  unique(sessions, (session) => session.id, 'sessions')
  unique(chunks, (chunk) => [chunk.sessionId, chunk.stream, chunk.seq], 'chunks')
  unique(devices, (device) => device.key, 'devices')
  unique(meta, (total) => total.key, 'meta')
  unique(warnings, (warning) => [warning.sessionId, warning.seq], 'warnings')
  unique(ringRecords, (row) => [row.deviceKey, row.seq], 'ringRecords')
  unique(ringReads, (read) => [read.deviceKey, read.observedAt], 'ringReads')
  unique(snapshot.preferences, (preference) => preference.key, 'preferences')
  unique(snapshot.stores.hours ?? [], (hour) => [hour.sessionId, hour.hourStart], 'hours')

  const sessionsById = new Map(sessions.map((session) => [session.id, session]))
  const devicesByKey = new Map(devices.map((device) => [device.key, device]))
  const ringByIdentity = new Map(ringRecords.map((row) => [JSON.stringify([row.deviceKey, row.seq]), row]))
  const chunksBySession = new Map<string, HistoryChunk[]>()
  const warningsBySession = new Map<string, number>()
  for (const hour of snapshot.stores.hours ?? []) requireArchive(sessionsById.has(hour.sessionId), 'hours.sessionId', 'missing session')
  for (const chunk of chunks) {
    requireArchive(sessionsById.has(chunk.sessionId), 'chunks.sessionId', 'missing session')
    const sessionChunks = chunksBySession.get(chunk.sessionId) ?? []
    sessionChunks.push(chunk)
    chunksBySession.set(chunk.sessionId, sessionChunks)
  }
  for (const warning of warnings) {
    requireArchive(sessionsById.has(warning.sessionId), 'warnings.sessionId', 'missing session')
    warningsBySession.set(warning.sessionId, (warningsBySession.get(warning.sessionId) ?? 0) + 1)
    requireArchive(warning.seq < MAX_SESSION_WARNINGS, 'warnings.seq', 'warning sequence exceeds session limit')
  }
  for (const count of warningsBySession.values()) requireArchive(count <= MAX_SESSION_WARNINGS, 'warnings', 'too many session warnings')

  let totalSealed = 0
  // Device metadata can be written after its session or ledger rows.
  for (const session of sessions) {
    for (const [key, kind] of [[session.packDeviceKey, 'pack'], [session.solarDeviceKey, 'solar']] as const) {
      const device = key === null ? undefined : devicesByKey.get(key)
      if (device !== undefined) requireArchive(device.kind === kind, 'sessions.deviceKey', 'wrong device kind')
    }
    requireArchive(session.groupKey === groupKeyFor(session.packDeviceKey, session.solarDeviceKey), 'sessions.groupKey', 'group does not match the session devices')
    requireArchive(session.continues !== session.id, 'sessions.continues', 'session cannot continue itself')
    requireArchive(session.state === 'open' ? session.endedAt === null && session.endReason === null : session.endedAt !== null && session.endReason !== null, 'sessions.state', 'inconsistent closure')
    for (const run of session.coverage) requireArchive(run.from <= run.to, 'sessions.coverage', 'inverted interval')
    const sessionChunks = chunksBySession.get(session.id) ?? []
    const sealed = sessionChunks.reduce((sum, chunk) => sum + (chunk.sealed ? chunk.length : 0), 0)
    requireArchive(sealed === session.sealedSamples, 'sessions.sealedSamples', 'sealed sample total disagrees with chunks')
    totalSealed += sealed
    for (const stream of ['pack', 'solar'] as const) {
      const streamChunks = sessionChunks.filter((chunk) => chunk.stream === stream)
      const samples = streamChunks.reduce((sum, chunk) => sum + chunk.length, 0)
      requireArchive(samples <= (stream === 'pack' ? session.packSamples : session.solarSamples), `sessions.${stream}Samples`, 'sample count is below retained rows')
      requireArchive(streamChunks.length <= (stream === 'pack' ? session.packChunks : session.solarChunks), `sessions.${stream}Chunks`, 'chunk count is below retained chunks')
      const tails = streamChunks.filter((chunk) => !chunk.sealed)
      requireArchive(tails.length <= 1, 'chunks.sealed', 'multiple open tails in a stream')
      if (tails[0] !== undefined) {
        requireArchive(session.state === 'open' && streamChunks.every((chunk) => chunk.seq <= tails[0]!.seq), 'chunks.sealed', 'open tail must end an open session stream')
      }
    }
  }
  requireArchive(Number.isSafeInteger(totalSealed), 'meta.totalSamples', 'sample total exceeds safe integer range')
  requireArchive(meta.length === 0 ? totalSealed === 0 : meta[0]!.totalSamples === totalSealed, 'meta.totalSamples', 'archive sample total disagrees with sessions')
  if (meta[0]?.rawBytes !== undefined) {
    const rawBytes = chunks.reduce((sum, chunk) => sum + chunk.length * sampleBytes(chunk.stream), 0)
    requireArchive(meta[0].rawBytes === rawBytes, 'meta.rawBytes', 'raw byte total disagrees with chunks')
  }

  for (const row of ringRecords) {
    const kind = row.format === SOLAR_DAY_FORMAT ? 'solar' : 'pack'
    const device = devicesByKey.get(row.deviceKey)
    if (device !== undefined) requireArchive(device.kind === kind, 'ringRecords.deviceKey', 'wrong device kind')
    if (row.format !== SOLAR_DAY_FORMAT) {
      const counter = new DataView(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength).getUint32(0, true)
      requireArchive(counter === row.packClockSeconds, 'ringRecords.packClockSeconds', 'counter disagrees with stored bytes')
    }
  }
  for (const read of ringReads) {
    const kind = read.format === SOLAR_DAY_FORMAT ? 'solar' : 'pack'
    const device = devicesByKey.get(read.deviceKey)
    if (device !== undefined) requireArchive(device.kind === kind, 'ringReads.deviceKey', 'wrong device kind')
    if (read.format !== SOLAR_DAY_FORMAT) {
      requireArchive(read.recordsAppended + read.overlap <= read.recordsReceived, 'ringReads.recordsReceived', 'receipt counts disagree')
      requireArchive(read.indexSpan === null || read.indexSpan.from <= read.indexSpan.to, 'ringReads.indexSpan', 'inverted ring interval')
      if (read.newestSampleSeq !== null) {
        requireArchive(read.newestSampleCounter !== null, 'ringReads.newestSampleCounter', 'sample reference needs its counter')
        const sample = ringByIdentity.get(JSON.stringify([read.deviceKey, read.newestSampleSeq]))
        if (sample !== undefined && sample.format !== SOLAR_DAY_FORMAT) requireArchive(sample.packClockSeconds === read.newestSampleCounter, 'ringReads.newestSampleCounter', 'sample reference disagrees with stored counter')
      }
    } else {
      requireArchive(read.daysReceived === read.daysAppended + read.daysRevised + read.daysUnchanged + read.daysUnwritten, 'ringReads.daysReceived', 'solar receipt counts disagree')
      requireArchive(read.daysRedated <= read.daysRevised + read.daysUnchanged, 'ringReads.daysRedated', 'redated days must already exist')
    }
  }
}

function unique<TRecord>(rows: readonly TRecord[], key: (row: TRecord) => unknown, path: string): void {
  const identities = new Set<string>()
  for (const row of rows) {
    const identity = JSON.stringify(key(row))
    requireArchive(!identities.has(identity), path, 'duplicate identity')
    identities.add(identity)
  }
}
