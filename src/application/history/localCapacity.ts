import { storageKey } from '../storageKey'

export const LOCAL_CAPACITY_MIB = [25, 50, 100] as const
export type LocalCapacityMiB = typeof LOCAL_CAPACITY_MIB[number]
export const DEFAULT_LOCAL_CAPACITY_MIB: LocalCapacityMiB = 100
const CAPACITY_KEY = 'shunt.localRawCapacityMiB'

export function loadLocalCapacityMiB(): LocalCapacityMiB {
  try {
    const stored = Number(localStorage.getItem(storageKey(CAPACITY_KEY)))
    return LOCAL_CAPACITY_MIB.find((capacity) => capacity === stored) ?? DEFAULT_LOCAL_CAPACITY_MIB
  } catch {
    return DEFAULT_LOCAL_CAPACITY_MIB
  }
}

export function saveLocalCapacityMiB(capacity: LocalCapacityMiB): void {
  if (!LOCAL_CAPACITY_MIB.includes(capacity)) throw new Error('Unsupported local recording capacity')
  localStorage.setItem(storageKey(CAPACITY_KEY), String(capacity))
}

export function localRawCapacityBytes(): number {
  return loadLocalCapacityMiB() * 1024 * 1024
}
