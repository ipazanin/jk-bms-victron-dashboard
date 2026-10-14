import { parseAdvertisementKey } from '../../domain/solar/advertisement'
import { awaitSolarOperation, SolarAdvertisementProcessor } from './solarScan'
import type { SolarScan, VictronHandlers } from './solarScan'

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
  private attempt: AbortController | null = null
  private detachAbort: (() => void) | null = null
  private socket: WebSocket | null = null

  constructor(url: string, handlers: VictronHandlers = {}) {
    this.url = url
    this.handlers = handlers
    this.processor = new SolarAdvertisementProcessor(handlers, 'anything-in-range')
  }

  get resumeAvailableAt(): number {
    return 0
  }

  get scanning(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN
  }

  start(keyHex: string): Promise<void> {
    return this.connect(keyHex)
  }

  private async connect(keyHex: string, signal?: AbortSignal): Promise<void> {
    this.stop()
    if (signal?.aborted) throw new DOMException('Solar scan cancelled.', 'AbortError')
    parseAdvertisementKey(keyHex)
    const attempt = new AbortController()
    this.attempt = attempt
    const cancel = (): void => {
      if (this.attempt === attempt) this.stop()
    }
    signal?.addEventListener('abort', cancel, { once: true })
    this.detachAbort = () => signal?.removeEventListener('abort', cancel)
    try {
      await awaitSolarOperation(this.openSocket(), attempt.signal)
      if (attempt.signal.aborted) return
      await awaitSolarOperation(this.processor.begin(keyHex), attempt.signal)
      if (attempt.signal.aborted) return
      if (this.socket?.readyState !== WebSocket.OPEN) {
        throw new Error('The Victron bridge closed while preparing the solar decoder.')
      }
    } catch (error) {
      if (attempt.signal.aborted) return
      this.stop()
      throw error
    } finally {
      if (signal?.aborted) throw new DOMException('Solar scan cancelled.', 'AbortError')
    }
  }

  canResume(): boolean {
    return true
  }

  canEverResume(): boolean {
    return true
  }

  resume(keyHex: string, _rememberedDeviceId: string | null = null, signal?: AbortSignal): Promise<void> {
    return this.connect(keyHex, signal)
  }

  stop(): void {
    this.attempt?.abort()
    this.attempt = null
    this.detachAbort?.()
    this.detachAbort = null
    this.processor.end()
    const socket = this.socket
    this.socket = null
    if (socket) {
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
        if (this.socket !== socket) return
        settled = true
        resolve()
      }
      socket.onmessage = (event): void => {
        if (this.socket === socket) this.handleMessage(event)
      }
      socket.onerror = (): void => {
        if (settled || this.socket !== socket) return
        settled = true
        reject(
          new Error(
            `Could not reach the Victron bridge at ${this.url}. Start the local bridge script, ` +
              'and open this page over http://localhost — an https page cannot connect to it.',
          ),
        )
      }
      socket.onclose = (): void => {
        if (this.socket !== socket) return
        if (!settled) {
          settled = true
          reject(new Error(`The Victron bridge at ${this.url} closed before the connection opened.`))
          return
        }
        this.processor.end()
        this.socket = null
        this.handlers.onError?.(new Error('The Victron bridge stopped. Restart it and connect again.'))
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
