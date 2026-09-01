/**
 * Turns a remembered device id back into the handle a grant already covers, or refuses saying which
 * permission answer stopped it.
 *
 * One algorithm, and both radios have errands that need it: the pack's chooser-free reconnect, the
 * controller's watch resumed without a dialog, and the background history sweep that borrows the
 * radio from that watch. Every one of them starts from an id in storage and needs the same three
 * questions asked in the same order, so they ask them here rather than each keeping a copy that
 * drifts. The copies were identical in everything but the sentence at the end, which is the one
 * thing that genuinely differs: each errand has to name the button on screen that fixes it, and
 * "Use Connect BMS" is no help to somebody who came here to read the solar backlog.
 *
 * The distinction the refusals carry is the whole reason this is not a `find` at the call site. A
 * device missing from `getDevices()` says nothing whatever about range: the list is what this origin
 * is permitted to talk to, and a pack that has simply not advertised for three minutes is still on
 * it. So an absence is permission gone, one chooser tap fixes it, and no amount of patience would —
 * which is the opposite of what a caller should do about a device that is merely out of range.
 */

import { ReconnectRefusedError } from './ReconnectRefusedError'

/**
 * What this errand tells the owner when a chooser-free route is not open to it. Three sentences and
 * not a remedy to append, because the specs pin them and a reader grepping for the sentence they
 * saw on screen should land on the errand that said it.
 */
export interface PermittedDeviceRefusals {
  /** No `getDevices()` at all, so every visit needs the chooser however close the device is. */
  readonly cannotListPermitted: string
  /** The list exists, was asked for, and would not answer. */
  readonly wouldNotListPermitted: string
  /** The list answered and this device is not on it: the grant is gone, not the device. */
  readonly permissionGone: string
}

export async function permittedDevice(
  deviceId: string,
  refusals: PermittedDeviceRefusals,
): Promise<BluetoothDevice> {
  const bluetooth = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined
  if (!bluetooth || typeof bluetooth.getDevices !== 'function') {
    throw new ReconnectRefusedError('browser-cannot-rejoin', refusals.cannotListPermitted)
  }
  let permitted: readonly BluetoothDevice[]
  try {
    permitted = await bluetooth.getDevices()
  } catch {
    throw new ReconnectRefusedError('browser-cannot-rejoin', refusals.wouldNotListPermitted)
  }
  const device = permitted.find((candidate) => candidate.id === deviceId)
  if (!device) {
    throw new ReconnectRefusedError('permission-gone', refusals.permissionGone)
  }
  return device
}
