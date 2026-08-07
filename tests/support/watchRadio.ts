/**
 * A radio whose device is watched rather than scanned.
 *
 * This is a transport-level fake, not a port-level one, so it lives here rather than in
 * `fakeRadios.ts`: it builds a real `EventTarget` and installs `globalThis.BluetoothDevice`, both
 * of which need a jsdom environment. The device is a genuine `EventTarget` so a dispatched
 * advertisement reaches the production listener by the same route a real one would, and every
 * `AbortSignal` handed to `watchAdvertisements` is kept, because the re-arm loop's whole contract
 * is that it aborts the stalled watch before asking for the next.
 *
 * Delivery follows the live watch: an advertisement dispatched while every signal handed out has
 * been aborted reaches nobody, so a scanner that aborts without re-arming genuinely goes quiet the
 * way Chrome's does. `watchingAdvertisements` stays true through all of it — Chrome keeps claiming
 * the watch is live while delivering nothing, which is why the re-arm loop is driven by silence
 * rather than by an error. It is a getter because the Web Bluetooth types mark it readonly.
 */

import { vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { VICTRON_COMPANY_ID } from '../../src/domain/solar/types'

/** Any company id that is not Victron's, for an advertisement the decoder must ignore. */
const FOREIGN_COMPANY_ID = 0x004c

export interface FakeWatchRadio {
  readonly requestDevice: MockInstance<(options: RequestDeviceOptions) => Promise<BluetoothDevice>>
  readonly device: BluetoothDevice
  readonly watchCalls: readonly AbortSignal[]
  deliver(rssi?: number): void
  deliverForeign(): void
  install(): void
  uninstall(): void
}

export function advertisementEvent(payload: Uint8Array, companyId: number, rssi: number): Event {
  const event = new Event('advertisementreceived')
  const manufacturerData = new Map<number, DataView>()
  manufacturerData.set(companyId, new DataView(payload.buffer, payload.byteOffset, payload.byteLength))
  Object.assign(event, { manufacturerData, rssi })
  return event
}

export function fakeWatchRadio(payload: Uint8Array): FakeWatchRadio {
  const watchCalls: AbortSignal[] = []
  let watching = false

  const target = new EventTarget()
  Object.defineProperty(target, 'watchingAdvertisements', { get: () => watching })
  Object.assign(target, {
    id: 'victron-1',
    name: 'SmartSolar HQ',
    watchAdvertisements: vi.fn(async (options?: WatchAdvertisementsOptions) => {
      if (options?.signal) watchCalls.push(options.signal)
      watching = true
    }),
  })
  const device = target as unknown as BluetoothDevice
  const requestDevice = vi.fn(async () => device)

  const listening = (): boolean =>
    watchCalls.length > 0 && watchCalls.some((signal) => !signal.aborted)

  return {
    requestDevice: requestDevice as unknown as FakeWatchRadio['requestDevice'],
    device,
    watchCalls,
    deliver(rssi = -55) {
      if (!listening()) return
      target.dispatchEvent(advertisementEvent(payload, VICTRON_COMPANY_ID, rssi))
    },
    deliverForeign() {
      if (!listening()) return
      target.dispatchEvent(advertisementEvent(payload, FOREIGN_COMPANY_ID, -70))
    },
    install() {
      Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice } })
      Object.defineProperty(globalThis, 'BluetoothDevice', {
        configurable: true,
        value: class {
          watchAdvertisements(): Promise<void> {
            return Promise.resolve()
          }
        },
      })
    },
    uninstall() {
      delete (navigator as { bluetooth?: unknown }).bluetooth
      Reflect.deleteProperty(globalThis, 'BluetoothDevice')
    },
  }
}
