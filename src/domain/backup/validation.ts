import type { ArchiveValidationRule } from './ArchiveValidationRule'

export function requireArchive(condition: unknown, path: string, reason = 'invalid value'): asserts condition {
  if (!condition) throw new Error(`Invalid archive at ${path}: ${reason}`)
}

export function record(input: unknown, path: string): Record<string, unknown> {
  requireArchive(typeof input === 'object' && input !== null && !Array.isArray(input), path, 'expected a record')
  requireArchive(Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null, path, 'expected a plain record')
  return input as Record<string, unknown>
}

export function shape(fields: Readonly<Record<string, ArchiveValidationRule>>, exact = false): ArchiveValidationRule {
  return (input, path) => {
    const row = record(input, path)
    if (exact) requireArchive(Object.keys(row).every((field) => Object.hasOwn(fields, field)), path, 'unexpected field')
    for (const [field, validate] of Object.entries(fields)) validate(row[field], `${path}.${field}`)
  }
}

export function list(validate: ArchiveValidationRule): ArchiveValidationRule {
  return (input, path) => {
    requireArchive(Array.isArray(input), path, 'expected an array')
    input.forEach((entry, index) => validate(entry, `${path}[${index}]`))
  }
}

export function nullable(validate: ArchiveValidationRule): ArchiveValidationRule {
  return (input, path) => { if (input !== null) validate(input, path) }
}

export function optional(validate: ArchiveValidationRule): ArchiveValidationRule {
  return (input, path) => { if (input !== undefined) validate(input, path) }
}

export function choice(...allowed: readonly unknown[]): ArchiveValidationRule {
  return (input, path) => requireArchive(allowed.includes(input), path, 'unsupported value')
}

export const text: ArchiveValidationRule = (input, path) => requireArchive(typeof input === 'string', path, 'expected text')
export const identity: ArchiveValidationRule = (input, path) => requireArchive(typeof input === 'string' && input.trim().length > 0, path, 'expected a nonempty identity')
export const boolean: ArchiveValidationRule = (input, path) => requireArchive(typeof input === 'boolean', path, 'expected a boolean')
export const finite: ArchiveValidationRule = (input, path) => requireArchive(typeof input === 'number' && Number.isFinite(input), path, 'expected a finite number')

export function bounded(min: number, max: number, integer = false): ArchiveValidationRule {
  return (input, path) => {
    finite(input, path)
    requireArchive((input as number) >= min && (input as number) <= max && (!integer || Number.isSafeInteger(input)), path, 'number outside its range')
  }
}

export const count = bounded(0, Number.MAX_SAFE_INTEGER, true)
export const timestamp = bounded(0, 8.64e15)
export const byte = bounded(0, 255, true)

export const calendarDate: ArchiveValidationRule = (input, path) => {
  requireArchive(typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input), path, 'expected YYYY-MM-DD')
  const instant = new Date(`${input}T00:00:00.000Z`)
  requireArchive(Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === input, path, 'invalid calendar date')
}

export function fields(names: string, validate: ArchiveValidationRule): Record<string, ArchiveValidationRule> {
  return Object.fromEntries(names.split(' ').map((name) => [name, validate]))
}
