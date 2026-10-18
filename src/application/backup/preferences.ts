import { ref } from 'vue'

import type { ArchivePreference } from '../../domain/backup/ArchivePreference'
import type { ArchivePreferenceKey } from '../../domain/backup/ArchivePreferenceKey'
import {
  ARCHIVE_PREFERENCE_KEYS,
  NONPORTABLE_PREFERENCE_KEYS,
  SECRET_PREFERENCE_KEY,
} from '../../domain/backup/archivePreferences'
import { storageKey } from '../storageKey'

export const restoredPreferencesRevision = ref(0)

export function captureArchivePreferences(includeSecret: boolean): readonly ArchivePreference[] {
  const preferences: ArchivePreference[] = []
  for (const key of ARCHIVE_PREFERENCE_KEYS) {
    if (key === SECRET_PREFERENCE_KEY && !includeSecret) continue
    const stored = localStorage.getItem(preferenceStorageKey(key))
    if (stored !== null) preferences.push({ key, value: stored })
  }
  return preferences
}

export function applyArchivePreferences(
  preferences: readonly ArchivePreference[],
  includeSecret: boolean,
  keys: readonly ArchivePreferenceKey[] = ARCHIVE_PREFERENCE_KEYS,
): void {
  const imported = new Map(preferences.map((preference) => [preference.key, preference.value]))
  const portable = keys.filter((key) => {
    if (NONPORTABLE_PREFERENCE_KEYS.includes(key)) return false
    return key !== SECRET_PREFERENCE_KEY || (includeSecret && imported.has(key))
  })
  const previous = new Map(portable.map((key) => [key, localStorage.getItem(preferenceStorageKey(key))]))
  try {
    for (const key of portable) {
      const stored = imported.get(key)
      if (stored === undefined) localStorage.removeItem(preferenceStorageKey(key))
      else localStorage.setItem(preferenceStorageKey(key), portablePreference(key, stored))
    }
  } catch (failure) {
    let rollbackFailed = false
    for (const [key, stored] of previous) {
      try {
        if (stored === null) localStorage.removeItem(preferenceStorageKey(key))
        else localStorage.setItem(preferenceStorageKey(key), stored)
      } catch {
        rollbackFailed = true
      }
    }
    if (rollbackFailed) {
      throw new Error('Browser storage refused the settings and could not restore every previous setting. Check your settings before reconnecting.')
    }
    throw failure
  }
  restoredPreferencesRevision.value += 1
}

function preferenceStorageKey(key: ArchivePreferenceKey): string {
  return key === 'shunt.theme' || key === 'shunt.sidebar' ? key : storageKey(key)
}

function portablePreference(key: ArchivePreferenceKey, stored: string): string {
  if (key !== 'shunt.rememberedSession') return stored
  const snapshot = JSON.parse(stored) as Record<string, unknown>
  delete snapshot.bmsDeviceId
  return JSON.stringify(snapshot)
}
