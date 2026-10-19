import { describe, expect, it } from 'vitest'

import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  PACK_COLUMNS,
  SOLAR_COLUMNS,
  exportFileName,
  exportSessionParts,
} from '../src/domain/history/exportDocument'
import type { SessionExport } from '../src/domain/history/exportDocument'
import { MAX_PAIRING_AGE_MS } from '../src/domain/history/join'
import { recomputeLedger } from '../src/domain/history/ledger'
import { SNAPSHOT_SCHEMA_VERSION } from '../src/domain/schemaVersion'
import {
  SAMPLE_EPOCH,
  deviceRecord,
  packSamples,
  sessionRecord,
  solarSamples,
} from './support/samples'

const GENERATED_AT = SAMPLE_EPOCH + 12 * 3_600_000

interface ExportedStream {
  readonly columns: readonly { readonly name: string; readonly unit: string; readonly resolution: number | null }[]
  readonly rows: readonly (readonly (number | string | boolean | null)[])[]
}

interface ExportedDocument {
  readonly format: string
  readonly formatVersion: number
  readonly generatedAt: number
  readonly snapshotSchemaVersion: number
  readonly note: string
  readonly session: Record<string, unknown>
  readonly devices: { readonly pack: Record<string, unknown> | null; readonly solar: Record<string, unknown> | null }
  readonly ledger: { readonly stored: Record<string, unknown>; readonly recomputed: Record<string, unknown> | null }
  readonly streams: { readonly pack: ExportedStream; readonly solar: ExportedStream }
}

function documentFor(overrides: Partial<SessionExport> = {}): ExportedDocument {
  const pack = packSamples(6, { currentA: -8.437 })
  const solar = solarSamples(6, { batteryCurrentA: 7.9 })
  const session: SessionExport = {
    record: sessionRecord({ state: 'closed', endedAt: SAMPLE_EPOCH + 6_000, endReason: 'user-disconnect' }),
    packDevice: deviceRecord({ userLabel: 'Starboard bank' }),
    solarDevice: null,
    recomputedLedger: recomputeLedger(pack, solar, MAX_PAIRING_AGE_MS),
    pack,
    solar,
    generatedAt: GENERATED_AT,
    ...overrides,
  }
  return JSON.parse([...exportSessionParts(session)].join('')) as ExportedDocument
}

describe('the document says what it is', () => {
  it('names its own format and version rather than the app version', () => {
    const document = documentFor()

    expect(document.format).toBe(EXPORT_FORMAT)
    expect(document.formatVersion).toBe(EXPORT_FORMAT_VERSION)
    expect(document.generatedAt).toBe(GENERATED_AT)
  })

  it('carries the snapshot schema the session was written under', () => {
    expect(documentFor().snapshotSchemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION)
  })

  it('lists every column with its unit and the resolution its radio can express', () => {
    const document = documentFor()

    expect(document.streams.pack.columns).toEqual(PACK_COLUMNS)
    expect(document.streams.solar.columns).toEqual(SOLAR_COLUMNS)
    expect(document.streams.pack.columns.find((column) => column.name === 'currentA')).toEqual({
      name: 'currentA',
      unit: 'A',
      resolution: 0.001,
    })
    expect(document.streams.solar.columns.find((column) => column.name === 'batteryCurrentA')).toEqual({
      name: 'batteryCurrentA',
      unit: 'A',
      resolution: 0.1,
    })
  })
})

describe('what the document refuses to carry', () => {
  it('has no house column anywhere, in either stream', () => {
    const document = documentFor()
    const names = [
      ...document.streams.pack.columns.map((column) => column.name),
      ...document.streams.solar.columns.map((column) => column.name),
    ]

    expect(names.some((name) => name.toLowerCase().includes('house'))).toBe(false)
    expect(document.note).toContain('house = solar − pack')
  })

  it('names the columns once instead of repeating them on every row', () => {
    const document = documentFor()

    expect(Array.isArray(document.streams.pack.rows[0])).toBe(true)
    expect(document.streams.pack.rows[0]).toHaveLength(PACK_COLUMNS.length)
  })
})

describe('the rows', () => {
  it('sit in the declared column order, at the values the radios reported', () => {
    const document = documentFor()
    const columns = document.streams.pack.columns.map((column) => column.name)
    const [first] = document.streams.pack.rows

    expect(first[columns.indexOf('at')]).toBe(SAMPLE_EPOCH)
    expect(first[columns.indexOf('currentA')]).toBe(-8.437)
    expect(first[columns.indexOf('chargingEnabled')]).toBe(true)
  })

  it('carries absence as null, which is the absence every instrument tests for', () => {
    const document = documentFor({ solar: solarSamples(2, { pvPowerW: null, loadCurrentA: null }) })
    const columns = document.streams.solar.columns.map((column) => column.name)

    expect(document.streams.solar.rows[0][columns.indexOf('pvPowerW')]).toBeNull()
    expect(document.streams.solar.rows[0][columns.indexOf('loadCurrentA')]).toBeNull()
  })

  it('emits a session with no rows at all as valid JSON', () => {
    const document = documentFor({ pack: [], solar: [], recomputedLedger: null })

    expect(document.streams.pack.rows).toEqual([])
    expect(document.ledger.recomputed).toBeNull()
  })

  it('parses back after being built one row at a time', () => {
    const parts = [...exportSessionParts({
      record: sessionRecord(),
      packDevice: null,
      solarDevice: null,
      recomputedLedger: null,
      pack: packSamples(300),
      solar: solarSamples(300),
      generatedAt: GENERATED_AT,
    })]

    expect(parts.length).toBeGreaterThan(300)
    const document = JSON.parse(parts.join('')) as ExportedDocument
    expect(document.streams.pack.rows).toHaveLength(300)
    expect(document.streams.solar.rows).toHaveLength(300)
  })
})

describe('the ledger travels twice', () => {
  it('carries the account the recorder folded and the one a rescan reproduces', () => {
    const document = documentFor()

    expect(document.ledger.stored).toBeTruthy()
    expect(document.ledger.recomputed).toBeTruthy()
    expect(document.session.ledger).toBeUndefined()
  })

  it('carries no recomputed ledger when the rows are a window rather than the whole session', () => {
    expect(documentFor({ recomputedLedger: null }).ledger.recomputed).toBeNull()
  })
})

describe('the session metadata', () => {
  it('says where the retained data starts when the head was pruned', () => {
    const document = documentFor({
      record: sessionRecord({ retainedFrom: SAMPLE_EPOCH + 2 * 3_600_000 }),
    })

    expect(document.session.retainedFrom).toBe(SAMPLE_EPOCH + 2 * 3_600_000)
  })

  it('carries both the name the owner chose and the one that was derived', () => {
    const document = documentFor()

    expect(document.devices.pack?.label).toBe('Starboard bank')
    expect(document.devices.pack?.defaultLabel).toBe('JK_B2A8S20P · …0001')
    expect(document.devices.pack?.serialNumber).toBe('DEMO00000000001')
    expect(document.devices.solar).toBeNull()
  })
})

describe('the file the owner ends up with', () => {
  it('is named for the device and the local start of the watch', () => {
    const startedAt = new Date(2025, 6, 12, 6, 20, 0).getTime()

    expect(exportFileName('Starboard bank', startedAt)).toBe(
      'shunt-starboard-bank-2025-07-12-0620.json',
    )
  })

  it('slugs an accented or punctuated name down to letters', () => {
    const startedAt = new Date(2025, 6, 12, 6, 20, 0).getTime()

    expect(exportFileName('Bâbord — banc #2', startedAt)).toBe('shunt-babord-banc-2-2025-07-12-0620.json')
    expect(exportFileName('', startedAt)).toBe('shunt-2025-07-12-0620.json')
    expect(exportFileName('!!!', startedAt)).toBe('shunt-2025-07-12-0620.json')
  })

})
