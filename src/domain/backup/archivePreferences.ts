import type { ArchivePreferenceKey } from './ArchivePreferenceKey'

export const SECRET_PREFERENCE_KEY = 'victron.advertisementKey'

export const NONPORTABLE_PREFERENCE_KEYS: readonly ArchivePreferenceKey[] = [
  'shunt.lastBmsDevice',
  'shunt.lastSolarController',
  'shunt.rejoinArmed',
]

export const ARCHIVE_PREFERENCE_KEYS: readonly ArchivePreferenceKey[] = [
  'shunt.theme',
  'shunt.sidebar',
  'shunt.statsPreferences',
  'shunt.rememberedSession',
  'shunt.logbook',
  ...NONPORTABLE_PREFERENCE_KEYS,
  SECRET_PREFERENCE_KEY,
]
