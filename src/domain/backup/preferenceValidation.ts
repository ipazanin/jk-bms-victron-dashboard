import { ARCHIVE_PREFERENCE_KEYS, SECRET_PREFERENCE_KEY } from './archivePreferences'
import { rememberedSession } from './recordValidation'
import { choice, count, finite, identity, list, nullable, record, requireArchive, shape, text, timestamp } from './validation'
import type { ArchiveValidationRule } from './ArchiveValidationRule'

const rememberedRadio = shape({ id: identity, name: nullable(text), at: timestamp })
const stats = shape({
  version: choice(1), range: choice('day', 'week', 'month', 'all', 'custom'),
  custom: nullable(shape({ from: timestamp, to: timestamp })), pack: nullable(identity),
})
const logbook = shape({
  fetchedAt: timestamp, uptimeSecondsAtFetch: nullable(finite),
  events: list(shape({ secondsSinceBoot: count, code: count, label: text })),
})

export const archivePreference: ArchiveValidationRule = (input, path) => {
  shape({ key: choice(...ARCHIVE_PREFERENCE_KEYS), value: text }, true)(input, path)
  const preference = record(input, path)
  const raw = preference.value as string
  const key = preference.key
  if (key === 'shunt.theme') return choice('light', 'dark')(raw, path)
  if (key === 'shunt.sidebar') return choice('collapsed', 'expanded')(raw, path)
  if (key === 'shunt.rejoinArmed') return choice('on', 'off')(raw, path)
  if (key === SECRET_PREFERENCE_KEY) {
    requireArchive(raw === '' || /^[0-9a-f]{32}$/i.test(raw), path, 'invalid advertisement key')
    return
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error(`Invalid archive at ${path}: invalid preference JSON`) }
  if (key === 'shunt.rememberedSession') return rememberedSession(parsed, path)
  if (key === 'shunt.logbook') return logbook(parsed, path)
  if (key === 'shunt.statsPreferences') {
    stats(parsed, path)
    const preferences = record(parsed, path)
    requireArchive(preferences.range !== 'custom' || preferences.custom !== null, path, 'custom range needs dates')
    if (preferences.custom !== null) {
      const window = preferences.custom as { from: number, to: number }
      requireArchive(window.from <= window.to, path, 'inverted custom dates')
    }
    return
  }
  rememberedRadio(parsed, path)
}
