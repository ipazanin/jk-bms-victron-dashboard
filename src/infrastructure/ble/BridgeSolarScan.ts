/**
 * Solar readings relayed from a native Bluetooth helper over a localhost WebSocket.
 *
 * macOS Chrome cannot deliver BLE advertisements to a page — `requestLEScan` opens its prompt and
 * then finds nothing — so the Victron feature is dead there through the browser's own radio. A
 * small local script (see the bridge/ directory) scans with CoreBluetooth, which works, and
 * forwards the raw manufacturer payload here. This class is the other end: it feeds those bytes to
 * the same `SolarAdvertisementProcessor` the real scanner uses, so the decrypt and every
 * downstream handler are identical.
 *
 * The key is never sent to the bridge; the browser still holds it and does the decrypt. The
 * relayed bytes are a public broadcast that anything in radio range already hears.
 *
 * Opt in by opening the app with `?bridge=1` (see solarBridge.ts). Only reachable from a page
 * served over http://localhost — an https page may not open a ws://localhost socket.
 */

import { parseAdvertisementKey } from '../../domain/solar/advertisement'
import { SolarAdvertisementProcessor } from './solarScan'
import type { SolarScan, VictronHandlers } from './solarScan'

/** One relayed advertisement: the Victron manufacturer payload as hex, and the rssi it arrived at. */
interface BridgeFrame {
  readonly mfg?: unknown
  readonly rssi?: unknown
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

export class BridgeSolarScan implements SolarScan {
  private readonly url: string
  private readonly handlers: VictronHandlers
  private readonly processor: SolarAdvertisementProcessor
  private socket: WebSocket | null = null

  constructor(url: string, handlers: VictronHandlers = {}) {
    this.url = url
    this.handlers = handlers
    this.processor = new SolarAdvertisementProcessor(handlers)
  }

  get scanning(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN
  }

  async start(keyHex: string): Promise<void> {
    // Idempotent, and validate the key before opening anything — both mirroring VictronScanner.
    this.stop()
    parseAdvertisementKey(keyHex)
    await this.openSocket()
    await this.processor.begin(keyHex)
  }

  stop(): void {
    this.processor.end()
    const socket = this.socket
    this.socket = null
    if (socket) {
      // Detach before closing so the deliberate teardown does not trip the unexpected-close path.
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
    }
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const socket = new WebSocket(this.url)
      this.socket = socket

      socket.onopen = (): void => {
        settled = true
        resolve()
      }
      socket.onmessage = (event): void => this.handleMessage(event)
      socket.onerror = (): void => {
        if (settled) return
        settled = true
        this.socket = null
        reject(
          new Error(
            `Could not reach the Victron bridge at ${this.url}. Start the local bridge script, ` +
              'and open this page over http://localhost — an https page cannot connect to it.',
          ),
        )
      }
      socket.onclose = (): void => {
        if (!settled) {
          settled = true
          this.socket = null
          reject(new Error(`The Victron bridge at ${this.url} closed before the connection opened.`))
          return
        }
        // Closed mid-session: the helper went away. Fall out of 'live' rather than trust a frozen
        // reading. The stale clock would demote it in time; surfacing the error says why at once.
        if (this.socket === socket) {
          this.processor.end()
          this.socket = null
          this.handlers.onError?.(new Error('The Victron bridge stopped. Restart it and connect again.'))
        }
      }
    })
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') return
    let frame: BridgeFrame
    try {
      frame = JSON.parse(event.data) as BridgeFrame
    } catch {
      return
    }
    if (typeof frame.mfg !== 'string') return
    const payload = hexToBytes(frame.mfg)
    if (!payload) return
    const rssi = typeof frame.rssi === 'number' ? frame.rssi : 0
    this.processor.ingest(payload, rssi)
  }
}
