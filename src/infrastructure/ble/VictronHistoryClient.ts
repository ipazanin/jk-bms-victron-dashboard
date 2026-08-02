/**
 * Web Bluetooth transport for the SmartSolar's stored history, over the 306b GATT tunnel.
 *
 * A session here is a one-shot errand, not a link the app holds: connect, sweep the history
 * registers, disconnect. That is why the port below has no `connect` — unlike `BmsLink`, which
 * models a link that stays up because the pack streams telemetry down it. The controller accepts
 * exactly one BLE client at a time and changes its advertising while connected, so a tunnel left
 * open locks VictronConnect out and silently freezes the Instant Readout feed the dashboard's live
 * solar readings come from. Making the whole errand one method means there is no state in which the
 * dashboard is connected and not reading, and no way for a caller to forget the disconnect.
 *
 * `readStoredHistory` must be called from a user gesture: requestDevice is the first statement,
 * before any await, or the browser rejects it for lack of transient activation. The chooser filters
 * on Victron's manufacturer id rather than the tunnel service, because the tunnel is not
 * advertised — filtering on it produces an empty chooser. `showAllDevices` is the escape hatch.
 *
 * This path works where the advertisement scan does not. On macOS Chrome `requestLEScan` opens its
 * prompt and then never delivers an advertisement, which is what `BridgeSolarScan` exists to work
 * around; `requestDevice` plus a GATT connect is unaffected, so the stored history is reachable on
 * a Mac even though the live feed is not.
 *
 * Reads go out one at a time and each is awaited before the next. Batching several read PDUs into
 * one write is legal — the vendor app does it, two at a time under a CBOR array of two — and it was
 * not worth it here. The tunnel carries no correlation id: a reply names its register and nothing
 * more, there is no length prefix or delimiter, and fragments interleave across two
 * characteristics. With one read outstanding, a PDU either names the register we are waiting for or
 * it is chatter, and that single rule is what makes the reassembler's resynchronisation safe to
 * rely on. With several outstanding, a dropped fragment resynchronises into a neighbouring reply
 * and there is nothing in the framing to catch it — a corrupted day would arrive looking exactly
 * like a real one. The cost is thirty-one round trips instead of sixteen, which the capture puts at
 * well under two seconds either way, against a session bounded at forty-five.
 *
 * Nothing here can write a register. The only frames this module puts on the wire are the captured
 * session-open literals, the captured keepalive, and read requests from `encodeRegisterReadRequest`
 * — which takes a `SolarHistoryRegister`, so the destructive registers near the history block are
 * unreachable from the type checker rather than merely unlikely.
 */

import { decodeSolarHistoryDay, decodeSolarHistoryTotals } from '../../domain/solar/history'
import {
  HISTORY_TOTALS_REGISTER,
  MAX_HISTORY_DAYS,
  historyDayRegister,
} from '../../domain/solar/SolarHistoryRegister'
import type { SolarHistoryRegister } from '../../domain/solar/SolarHistoryRegister'
import type { SolarHistoryTransfer } from '../../domain/solar/SolarHistoryTransfer'
import { encodeRegisterReadRequest } from '../../domain/solar/tunnel/pdu'
import {
  SOLAR_TUNNEL_BULK_CHARACTERISTIC,
  SOLAR_TUNNEL_COMMAND_CHARACTERISTIC,
  SOLAR_TUNNEL_CONTROL_CHARACTERISTIC,
  SOLAR_TUNNEL_SERVICE,
  TUNNEL_COMMAND_OPEN_FRAMES,
  TUNNEL_CONTROL_OPEN_FRAMES,
  TUNNEL_KEEPALIVE_FRAME,
  TUNNEL_KEEPALIVE_PERIOD_MS,
} from '../../domain/solar/tunnel/session'
import { TunnelReassembler } from '../../domain/solar/tunnel/TunnelReassembler'
import type { TunnelPdu } from '../../domain/solar/tunnel/TunnelPdu'
import { VICTRON_COMPANY_ID } from '../../domain/solar/types'
import { toArrayBuffer } from '../../domain/bytes'
import { SolarHistoryRun } from './SolarHistoryRun'

export interface SolarHistoryHandlers {
  /** Days read so far, out of the day count the totals record implies. Never called before totals. */
  onProgress?: (daysRead: number, daysAvailable: number) => void
  /**
   * A reply that arrived whole and would not decode, or a failure inside a sweep that had already
   * started. Reported rather than thrown, because the sweep goes on and settles with what it has.
   */
  onError?: (error: Error) => void
}

/**
 * The controller's stored history as the layers above see it. Only this module touches a radio; the
 * interface is what lets a fake stand in its place, which no object literal can do against the
 * class itself — private fields make it nominal.
 */
export interface SolarHistoryLink {
  /** True from the chooser opening until the session is closed. A second read joins this one. */
  readonly reading: boolean
  /** The name of the controller the last session used, kept after the link is closed. */
  readonly deviceName: string | null
  /**
   * Open a tunnel, sweep the stored history, and close it again. Call from a user gesture.
   *
   * Rejects only when there is no session to measure: a dismissed chooser, a controller that will
   * not connect, a browser without Web Bluetooth. Once the tunnel is open every ending is a result
   * — silence, a refusal and an empty history all resolve, with the outcome saying which.
   */
  readStoredHistory(showAllDevices?: boolean): Promise<SolarHistoryTransfer>
}

/**
 * The tunnel service is not advertised, so a filter on it matches nothing. Victron's company id is
 * what the controller does broadcast, and the chooser is where the user picks theirs out of a
 * marina full of them.
 */
function chooserOptions(showAllDevices: boolean): RequestDeviceOptions {
  if (showAllDevices) {
    return { acceptAllDevices: true, optionalServices: [SOLAR_TUNNEL_SERVICE] }
  }
  return {
    filters: [{ manufacturerData: [{ companyIdentifier: VICTRON_COMPANY_ID }] }],
    optionalServices: [SOLAR_TUNNEL_SERVICE],
  }
}

export class VictronHistoryClient implements SolarHistoryLink {
  private readonly handlers: SolarHistoryHandlers
  private readonly reassembler = new TunnelReassembler()
  private device: BluetoothDevice | null = null
  private control: BluetoothRemoteGATTCharacteristic | null = null
  private command: BluetoothRemoteGATTCharacteristic | null = null
  private bulk: BluetoothRemoteGATTCharacteristic | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private run: SolarHistoryRun | null = null
  /** Held so a second press joins the running sweep instead of starting a rival session. */
  private session: Promise<SolarHistoryTransfer> | null = null
  private lastDeviceName: string | null = null

  constructor(handlers: SolarHistoryHandlers = {}) {
    this.handlers = handlers
  }

  get reading(): boolean {
    return this.session !== null
  }

  get deviceName(): string | null {
    return this.lastDeviceName
  }

  readStoredHistory(showAllDevices = false): Promise<SolarHistoryTransfer> {
    // Synchronous, so the guard costs no transient activation and the chooser still opens.
    if (this.session !== null) return this.session
    const session = this.sweepSession(showAllDevices).finally(() => {
      this.session = null
    })
    this.session = session
    return session
  }

  /**
   * The whole errand. Everything up to the open tunnel may reject; from there on the run is the
   * result, and the session is closed on every path out.
   */
  private async sweepSession(showAllDevices: boolean): Promise<SolarHistoryTransfer> {
    const options = chooserOptions(showAllDevices)
    const device = await navigator.bluetooth.requestDevice(options)
    this.device = device
    this.lastDeviceName = device.name ?? null
    device.addEventListener('gattserverdisconnected', this.handleDisconnect)

    try {
      await this.openTunnel(device)
    } catch (error) {
      await this.closeTunnel()
      throw error
    }

    // Created after the session-open exchange, deliberately: the controller's `07 00 03 00` and the
    // control characteristic's chatter are not answers to anything, and counting them would leave
    // "the controller said nothing about our registers" indistinguishable from a live tunnel.
    const run = new SolarHistoryRun()
    this.run = run
    try {
      await this.sweep(run)
    } catch (error) {
      // A write that failed or a link that went mid-sweep. The session still measured something, so
      // it is reported and the transfer settles with what arrived.
      this.handlers.onError?.(error as Error)
    } finally {
      run.stop()
      this.run = null
      await this.closeTunnel()
    }
    return run.transfer
  }

  /**
   * Subscribe to all three characteristics, then write the session-open frames in the order the
   * controller requires. Subscribing first is not a precaution: the reply to the last open frame
   * arrives immediately, and a notification with no subscription behind it is dropped by the
   * browser with nothing to say it happened.
   */
  private async openTunnel(device: BluetoothDevice): Promise<void> {
    const server = await device.gatt!.connect()
    const service = await server.getPrimaryService(SOLAR_TUNNEL_SERVICE)

    this.control = await service.getCharacteristic(SOLAR_TUNNEL_CONTROL_CHARACTERISTIC)
    this.command = await service.getCharacteristic(SOLAR_TUNNEL_COMMAND_CHARACTERISTIC)
    this.bulk = await service.getCharacteristic(SOLAR_TUNNEL_BULK_CHARACTERISTIC)

    this.control.addEventListener('characteristicvaluechanged', this.handleControlValue)
    this.command.addEventListener('characteristicvaluechanged', this.handleTunnelValue)
    this.bulk.addEventListener('characteristicvaluechanged', this.handleTunnelValue)
    await this.control.startNotifications()
    await this.command.startNotifications()
    await this.bulk.startNotifications()

    for (const frame of TUNNEL_CONTROL_OPEN_FRAMES) {
      await this.write(this.control, frame)
    }
    for (const frame of TUNNEL_COMMAND_OPEN_FRAMES) {
      await this.write(this.command, frame)
    }

    this.keepaliveTimer = setInterval(this.sendKeepalive, TUNNEL_KEEPALIVE_PERIOD_MS)
  }

  /**
   * Totals first, because its day count is what bounds the sweep. Not the capability word in
   * 0x0140: a second opinion about whether the data exists is indistinguishable from a misread bit
   * when it says no, and this controller's own day count is the authority on its own memory.
   *
   * A register answering with a status code ends the sweep rather than skipping past it. The day
   * count already said how far back the records go, so a refusal inside that range means the
   * controller has stopped serving them, and the registers beyond it hold nothing worth another
   * round trip on a session that is blocking the live feed.
   */
  private async sweep(run: SolarHistoryRun): Promise<void> {
    const totalsReply = await this.readRegister(run, HISTORY_TOTALS_REGISTER)
    if (totalsReply === null) return
    if (totalsReply.opcode !== 'valueReport') {
      run.noteRefusal(totalsReply.register)
      return
    }

    let dayCount: number
    try {
      const totals = decodeSolarHistoryTotals(totalsReply.payload)
      run.recordTotals(totals)
      // `daysAvailable` counts the completed days behind today, and today is a record of its own:
      // the captured controller reports 30 and answers thirty-one day registers, 0x1050 through
      // 0x106E, every one of them written. Sweeping `daysAvailable` registers would stop one short
      // and drop the oldest day on the controller — the single day nothing else holds a copy of.
      dayCount = Math.min(totals.daysAvailable + 1, MAX_HISTORY_DAYS)
    } catch (error) {
      run.noteUnreadableReply()
      this.handlers.onError?.(error as Error)
      return
    }

    this.handlers.onProgress?.(0, dayCount)
    for (let daysAgo = 0; daysAgo < dayCount; daysAgo += 1) {
      const register = historyDayRegister(daysAgo)
      const reply = await this.readRegister(run, register)
      if (reply === null) return
      if (reply.opcode !== 'valueReport') {
        run.noteRefusal(register)
        return
      }
      try {
        run.recordDay({ register, daysAgo, day: decodeSolarHistoryDay(reply.payload) })
      } catch (error) {
        run.noteUnreadableReply()
        this.handlers.onError?.(error as Error)
      }
      this.handlers.onProgress?.(daysAgo + 1, dayCount)
    }
  }

  /**
   * One read, armed before it is written. A reply can arrive before the write promise settles, and
   * a run armed afterwards would drop it.
   */
  private async readRegister(run: SolarHistoryRun, register: SolarHistoryRegister): Promise<TunnelPdu | null> {
    if (!run.running) return null
    const answer = run.awaitAnswerFor(register)
    await this.write(this.command, encodeRegisterReadRequest(register))
    return answer
  }

  private async write(characteristic: BluetoothRemoteGATTCharacteristic | null, frame: Uint8Array): Promise<void> {
    if (characteristic === null) throw new Error('The solar tunnel is not open.')
    const bytes = toArrayBuffer(frame)
    if (characteristic.properties.writeWithoutResponse) {
      await characteristic.writeValueWithoutResponse(bytes)
    } else {
      await characteristic.writeValueWithResponse(bytes)
    }
  }

  /**
   * Re-arms the tunnel's inactivity timeout. Failures are swallowed: the session is ending anyway
   * when the link is gone, and the sweep's own bounds report that far better than a keepalive can.
   */
  private readonly sendKeepalive = (): void => {
    void this.write(this.command, TUNNEL_KEEPALIVE_FRAME).catch(() => undefined)
  }

  /**
   * The command and bulk characteristics are one byte stream, not two conversations. A single PDU
   * splits across the pair mid-message, so both feed the same reassembler in arrival order and
   * neither is told apart.
   */
  private readonly handleTunnelValue = (event: Event): void => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value
    if (!value) return
    const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    // Counted before the reassembler is given it: bytes that never parse and bytes that never
    // arrived look identical afterwards, and only this separates them.
    this.run?.noteNotification(chunk)
    for (const pdu of this.reassembler.feed(chunk)) {
      this.run?.notePdu(pdu)
    }
  }

  /** Control carries session chatter and no registers, so it is counted and never parsed. */
  private readonly handleControlValue = (): void => {
    this.run?.noteControlNotification()
  }

  private readonly handleDisconnect = (): void => {
    // The days already gathered are a measurement, so the sweep ends with them rather than waiting
    // out a ceiling that nothing is left to answer.
    this.run?.stop()
    this.stopKeepalive()
    this.control = null
    this.command = null
    this.bulk = null
    this.reassembler.reset()
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnect)
      this.device = null
    }
  }

  /**
   * Closes the tunnel, and is the only way out of a session. The drop handler comes off before the
   * first await: unsubscribing can itself take the link down, and this teardown is deliberate.
   */
  private async closeTunnel(): Promise<void> {
    this.stopKeepalive()
    const device = this.device
    this.device = null
    device?.removeEventListener('gattserverdisconnected', this.handleDisconnect)

    const subscriptions: readonly [BluetoothRemoteGATTCharacteristic | null, EventListener][] = [
      [this.control, this.handleControlValue],
      [this.command, this.handleTunnelValue],
      [this.bulk, this.handleTunnelValue],
    ]
    this.control = null
    this.command = null
    this.bulk = null

    for (const [characteristic, listener] of subscriptions) {
      if (characteristic === null) continue
      characteristic.removeEventListener('characteristicvaluechanged', listener)
      try {
        await characteristic.stopNotifications()
      } catch {
        // The link may already be gone; there is nothing left to unsubscribe from.
      }
    }

    device?.gatt?.disconnect()
    this.reassembler.reset()
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }
}
