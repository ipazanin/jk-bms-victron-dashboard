import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  DATABASE_NAME,
  DATABASE_VERSION,
  applySchema,
} from '../src/infrastructure/history/IdbHistoryStore'

/**
 * `scripts/visual-check.mjs` builds the archive's schema itself rather than waiting for the app to
 * open it, so the seed cannot race the first read. The price is that it hand-copies every store
 * name, key path and index out of the adapter — and a hand copy left behind by a schema change
 * fails silently: the seed lands in stores nothing reads, and the check then reports an empty page
 * as though the page itself were empty.
 *
 * So the copy is held to its original here. The script is read as text, because it is a Node module
 * that launches a browser on import and cannot be called into. `applySchema` is driven against a
 * recorder that answers `createObjectStore` and remembers what it was asked for, because what is
 * being compared is what the adapter DECLARES, not what IndexedDB then does with it.
 */

interface DeclaredIndex {
  readonly name: string
  readonly keyPath: string | readonly string[]
}

interface DeclaredStore {
  readonly name: string
  readonly keyPath: string | readonly string[]
  readonly indexes: readonly DeclaredIndex[]
}

/** Whitespace-flattened, so a wrapped declaration reads the same as a one-line one. */
const source = readFileSync(new URL('../scripts/visual-check.mjs', import.meta.url), 'utf8').replace(
  /\s+/g,
  ' ',
)

const STORE_DECLARATION =
  /(?:const (\w+) = )?created\.createObjectStore\('([^']+)', \{ keyPath: (\[[^\]]*\]|'[^']*'),? \}\)/g
const INDEX_DECLARATION = /(\w+)\.createIndex\('([^']+)', (\[[^\]]*\]|'[^']*')\)/g

/** Every store `applySchema` asks for, and every index it hangs off one. */
function schemaBuiltByAdapter(): readonly DeclaredStore[] {
  const stores: DeclaredStore[] = []
  const recorder = {
    // The verifying branch asks what already exists before building, so the recorder answers.
    objectStoreNames: {
      contains: (name: string) => stores.some((store) => store.name === name),
    },
    createObjectStore(name: string, options: IDBObjectStoreParameters): unknown {
      const indexes: DeclaredIndex[] = []
      stores.push({ name, keyPath: options.keyPath ?? '', indexes })
      return {
        createIndex(indexName: string, keyPath: string | readonly string[]): void {
          indexes.push({ name: indexName, keyPath })
        },
      }
    },
  }
  applySchema(recorder as unknown as IDBDatabase, 0)
  return stores
}

/** The same, read off the check's own upgrade handler. Indexes join their store by its variable. */
function schemaSeededByCheck(): readonly DeclaredStore[] {
  const indexesByVariable = new Map<string, DeclaredIndex[]>()
  const stores: DeclaredStore[] = []

  for (const declaration of source.matchAll(STORE_DECLARATION)) {
    const indexes: DeclaredIndex[] = []
    // A store nothing indexes is declared without a variable to hold it.
    if (declaration[1]) indexesByVariable.set(declaration[1], indexes)
    stores.push({ name: declaration[2], keyPath: keyPathOf(declaration[3]), indexes })
  }
  for (const declaration of source.matchAll(INDEX_DECLARATION)) {
    indexesByVariable
      .get(declaration[1])
      ?.push({ name: declaration[2], keyPath: keyPathOf(declaration[3]) })
  }
  return stores
}

function keyPathOf(literal: string): string | readonly string[] {
  const inner = literal.slice(1, -1)
  return literal.startsWith('[') ? inner.split(',').map(unquote) : inner
}

function unquote(literal: string): string {
  return literal.trim().slice(1, -1)
}

function stringConstant(name: string): string | null {
  return source.match(new RegExp(`const ${name} = '([^']*)'`))?.[1] ?? null
}

function numberConstant(name: string): number | null {
  const found = source.match(new RegExp(`const ${name} = (\\d+)`))
  return found === null ? null : Number(found[1])
}

function stringArrayConstant(name: string): readonly string[] {
  const found = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))
  return found === null ? [] : [...found[1].matchAll(/'([^']*)'/g)].map((each) => each[1])
}

function byName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name)
}

/** Compared by content rather than by declaration order, which is the script's own business. */
function sorted(stores: readonly DeclaredStore[]): readonly DeclaredStore[] {
  return [...stores]
    .map((store) => ({ ...store, indexes: [...store.indexes].sort(byName) }))
    .sort(byName)
}

describe('the visual check seeds the archive the adapter reads', () => {
  it('opens the database the adapter opens', () => {
    expect(stringConstant('DATABASE')).toBe(DATABASE_NAME)
  })

  it('seeds the schema version the adapter builds', () => {
    expect(numberConstant('VERSION')).toBe(DATABASE_VERSION)
  })

  it('seeds every object store the adapter builds', () => {
    const built = schemaBuiltByAdapter().map((store) => store.name)
    expect([...stringArrayConstant('STORES')].sort()).toEqual([...built].sort())
  })

  it("builds every store on the adapter's own key paths and indexes", () => {
    expect(sorted(schemaSeededByCheck())).toEqual(sorted(schemaBuiltByAdapter()))
  })
})
