import type { ArchiveStores } from './ArchiveStores'
import { COMPACT_RETENTION_MS } from '../history/budget'

export function hourlyArchiveStores(stores: ArchiveStores, capturedAt: number): ArchiveStores {
  return {
    ...stores,
    chunks: [],
    hours: (stores.hours ?? []).filter((hour) => hour.hourStart >= capturedAt - COMPACT_RETENTION_MS),
    sessions: stores.sessions.map((session) => ({
      ...session, sealedSamples: 0, packChunks: 0, solarChunks: 0, coverage: [],
    })),
    meta: stores.meta.map((total) => ({ ...total, totalSamples: 0, rawBytes: 0 })),
  }
}
