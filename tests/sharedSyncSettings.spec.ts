import { describe, expect, it } from 'vitest'
import { createSettingsRevision, settingsHeads, sharedPreferences } from '../src/domain/sync/sharedSettings'
import { validateCloudCatalog, validateCloudSettingsRevision } from '../src/domain/sync/syncValidation'

function revision(id: string, parents: readonly string[] = []) {
  return { id, sourceId: 'browser', parents, createdAt: 1000, preferences: [{ key: 'shunt.theme' as const, value: 'dark' }] }
}

describe('shared settings ancestry', () => {
  it('keeps concurrent changes as heads until an explicit choice names both parents', () => {
    const first = revision('initial')
    const tablet = revision('tablet', ['initial'])
    const phone = revision('phone', ['initial'])
    expect(settingsHeads([first, tablet, phone])).toEqual([tablet, phone])
    const resolved = createSettingsRevision(phone.preferences, 'browser', ['tablet', 'phone'], 2000)
    expect(settingsHeads([first, tablet, phone, resolved])).toEqual([resolved])
    expect(() => validateCloudCatalog({ archives: [], settings: [first, tablet, phone, resolved] })).not.toThrow()
  })

  it('shares only presentation preferences unless the saved Victron key is opted in', () => {
    const preferences = [
      { key: 'shunt.theme' as const, value: 'dark' },
      { key: 'shunt.logbook' as const, value: '{}' },
      { key: 'shunt.lastBmsDevice' as const, value: '{}' },
      { key: 'victron.advertisementKey' as const, value: 'a'.repeat(32) },
    ]
    expect(sharedPreferences(preferences, false).map((preference) => preference.key)).toEqual(['shunt.theme'])
    expect(sharedPreferences(preferences, true).map((preference) => preference.key)).toEqual(['shunt.theme', 'victron.advertisementKey'])
  })

  it('rejects foreign setting keys, duplicate identities, missing parents and cycles', () => {
    expect(() => validateCloudSettingsRevision({ ...revision('bad'), preferences: [{ key: 'shunt.rejoinArmed', value: 'off' }] })).toThrow('not shared')
    expect(() => validateCloudCatalog({ archives: [], settings: [revision('same'), revision('same')] })).toThrow('duplicate')
    expect(() => validateCloudCatalog({ archives: [], settings: [revision('child', ['absent'])] })).toThrow('missing parent')
    expect(() => validateCloudCatalog({ archives: [], settings: [revision('one', ['two']), revision('two', ['one'])] })).toThrow('cyclic')
  })
})
