import { sampleBytes } from './columns'
import type { CoverageRun, SessionId, StreamName } from './types'

export const PRUNE_TARGET_RATIO = 0.9
export const MIN_SESSION_SAMPLES = 10
export const MAX_SESSIONS = 2_000
export const MAX_SESSION_HOURS = 20_000
export const COMPACT_RETENTION_MS = 2 * 365 * 24 * 60 * 60_000

export interface RawChunkExtent {
  readonly sessionId: SessionId
  readonly stream: StreamName
  readonly seq: number
  readonly length: number
  readonly baseAt: number
  readonly sealed: boolean
}

export function planRawPrune(
  chunks: readonly RawChunkExtent[],
  rawBytes: number,
  capacityBytes: number,
): readonly RawChunkExtent[] {
  if (rawBytes <= capacityBytes) return []
  const target = Math.floor(capacityBytes * PRUNE_TARGET_RATIO)
  const dropped: RawChunkExtent[] = []
  let remaining = rawBytes
  const oldestFirst = chunks.filter((chunk) => chunk.sealed).sort((left, right) =>
    left.baseAt - right.baseAt || left.sessionId.localeCompare(right.sessionId) || left.seq - right.seq,
  )
  for (const chunk of oldestFirst) {
    if (remaining <= target) break
    dropped.push(chunk)
    remaining -= chunk.length * sampleBytes(chunk.stream)
  }
  return dropped
}

export function retainedCoverage(coverage: readonly CoverageRun[], retainedFrom: number | null): readonly CoverageRun[] {
  if (retainedFrom === null) return coverage
  return coverage.filter((run) => run.to > retainedFrom).map((run) => ({ ...run, from: Math.max(run.from, retainedFrom) }))
}
