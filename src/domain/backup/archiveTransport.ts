import { record, requireArchive } from './validation'

export const ARCHIVE_ARRAY_TYPES = {
  Uint8Array: [Uint8Array, 0, 0xff],
  Int8Array: [Int8Array, -0x80, 0x7f],
  Uint16Array: [Uint16Array, 0, 0xffff],
  Int16Array: [Int16Array, -0x8000, 0x7fff],
  Uint32Array: [Uint32Array, 0, 0xffffffff],
  Int32Array: [Int32Array, -0x80000000, 0x7fffffff],
} as const

export function encodeArchiveValue(input: unknown): string {
  validateArchiveValue(input)
  return JSON.stringify(input, (_key, entry: unknown) => {
    if (entry === undefined) return { $undefined: true }
    if (ArrayBuffer.isView(entry)) {
      const arrayType = Object.entries(ARCHIVE_ARRAY_TYPES).find(([, [constructor]]) => entry instanceof constructor)
      requireArchive(arrayType !== undefined, 'JSON', 'unsupported typed array')
      return { $typedArray: arrayType[0], values: Array.from(entry as Uint8Array) }
    }
    return entry
  })
}

export function validateArchiveValue(input: unknown, path = 'snapshot', depth = 0, ancestors = new Set<object>()): void {
  requireArchive(depth <= 64, path, 'nesting exceeds 64 levels')
  if (typeof input === 'number') requireArchive(Number.isFinite(input), path, 'nonfinite number')
  requireArchive(typeof input !== 'bigint' && typeof input !== 'function' && typeof input !== 'symbol', path, 'unsupported value')
  if (input === null || typeof input !== 'object') return
  if (ArrayBuffer.isView(input)) {
    requireArchive(Object.values(ARCHIVE_ARRAY_TYPES).some(([constructor]) => input instanceof constructor), path, 'unsupported typed array')
    return
  }
  requireArchive(!ancestors.has(input), path, 'cyclic record')
  ancestors.add(input)
  if (Array.isArray(input)) {
    input.forEach((entry, index) => validateArchiveValue(entry, `${path}[${index}]`, depth + 1, ancestors))
  } else {
    const row = record(input, path)
    for (const [key, entry] of Object.entries(row)) {
      requireArchive(!['__proto__', 'prototype', 'constructor', '$typedArray', '$undefined'].includes(key), path, 'unsafe or reserved property name')
      validateArchiveValue(entry, `${path}.${key}`, depth + 1, ancestors)
    }
  }
  ancestors.delete(input)
}

export function decodeArchiveValue(serialized: string): unknown {
  return decode(JSON.parse(serialized), 0)
}

function decode(input: unknown, depth: number): unknown {
  requireArchive(depth <= 64, 'JSON', 'nesting exceeds 64 levels')
  if (input === null || typeof input !== 'object') {
    if (typeof input === 'number') requireArchive(Number.isFinite(input), 'JSON', 'nonfinite number')
    return input
  }
  if (Array.isArray(input)) return input.map((entry) => decode(entry, depth + 1))
  const encoded = record(input, 'JSON')
  for (const key of Object.keys(encoded)) requireArchive(!['__proto__', 'prototype', 'constructor'].includes(key), 'JSON', 'unsafe property name')
  if ('$undefined' in encoded) {
    requireArchive(encoded.$undefined === true && Object.keys(encoded).length === 1, 'JSON', 'invalid undefined marker')
    return undefined
  }
  if ('$typedArray' in encoded) {
    requireArchive(typeof encoded.$typedArray === 'string' && Object.hasOwn(ARCHIVE_ARRAY_TYPES, encoded.$typedArray), 'JSON', 'unsupported typed array')
    requireArchive(Object.keys(encoded).length === 2 && Array.isArray(encoded.values), 'JSON', 'invalid typed array payload')
    const [constructor, minimum, maximum] = ARCHIVE_ARRAY_TYPES[encoded.$typedArray as keyof typeof ARCHIVE_ARRAY_TYPES]
    requireArchive(encoded.values.every((entry: unknown) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= minimum && entry <= maximum), 'JSON', 'typed array integer outside its range')
    return new constructor(encoded.values)
  }
  return Object.fromEntries(Object.entries(encoded).map(([key, entry]) => [key, decode(entry, depth + 1)]))
}
