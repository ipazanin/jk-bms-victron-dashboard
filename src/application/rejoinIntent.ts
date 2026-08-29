/**
 * Whether this browser may rejoin the last pack on its own.
 *
 * It is the owner's standing answer rather than a setting, and it is why this is persisted at all:
 * pressing Disconnect means "stop reconnecting to this boat", and a page that rejoined the moment
 * it was reopened would make Disconnect a button that undoes itself on the next reload.
 *
 * A browser that has never been told otherwise rejoins. That way the boat is the default and there
 * is nothing to find and switch on, and the only thing that ever writes `off` here is a press of
 * Disconnect — undone by the next press that asks for a radio back, Connect solar as much as
 * Connect or Reconnect, which is the whole undo.
 *
 * Anything unrecognised reads as armed, including a value some future build wrote: being quiet
 * about a pack the owner wanted is the worse of the two failures.
 */

import { storageKey } from './storageKey'

const STORAGE_KEY = 'shunt.rejoinArmed'
const DISARMED = 'off'
const ARMED = 'on'

export function loadRejoinIntent(): boolean {
  try {
    return localStorage.getItem(storageKey(STORAGE_KEY)) !== DISARMED
  } catch {
    return true
  }
}

export function saveRejoinIntent(armed: boolean): void {
  try {
    localStorage.setItem(storageKey(STORAGE_KEY), armed ? ARMED : DISARMED)
  } catch {
    // Private browsing denies storage; a Disconnect then lasts only as long as the tab does.
  }
}
