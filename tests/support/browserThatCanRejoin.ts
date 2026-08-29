/**
 * The browser as the rejoin path needs it: one whose radio is on and whose `getDevices` exists.
 *
 * Rejoining without the chooser is gated on that call, which jsdom has no radio to provide, and
 * nothing automatic is attempted until the browser says the adapter is there. The fake link
 * performs the reconnect itself, so raising the one flag and answering the one question is all the
 * guards need; everything else stays as honest as the browser running the spec.
 */

import { browserBleEnvironment } from '../../src/infrastructure/ble/capabilities'
import type { BleEnvironment } from '../../src/infrastructure/ble/capabilities'

export function browserThatCanRejoin(): BleEnvironment {
  const environment = browserBleEnvironment()
  return {
    capabilities: { ...environment.capabilities, canReconnect: true },
    watchAdapter: (onChange) => {
      onChange(true)
      return () => undefined
    },
  }
}
