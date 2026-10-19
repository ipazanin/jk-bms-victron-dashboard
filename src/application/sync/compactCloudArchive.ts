import type { ArchiveSnapshot } from '../../domain/backup/ArchiveSnapshot'
import { validateArchiveSnapshot } from '../../domain/backup/archiveCodec'
import { hourlyArchiveStores } from '../../domain/backup/hourlyArchiveStores'

export function compactCloudArchive(snapshot: ArchiveSnapshot): ArchiveSnapshot {
  validateArchiveSnapshot(snapshot)
  const compact: ArchiveSnapshot = {
    ...snapshot,
    version: 2,
    stores: hourlyArchiveStores(snapshot.stores, snapshot.exportedAt),
    preferences: snapshot.preferences.map((preference) => {
      if (preference.key !== 'shunt.rememberedSession') return preference
      const remembered = JSON.parse(preference.value) as Record<string, unknown>
      return { ...preference, value: JSON.stringify({ ...remembered, history: [] }) }
    }),
  }
  validateArchiveSnapshot(compact)
  return compact
}
