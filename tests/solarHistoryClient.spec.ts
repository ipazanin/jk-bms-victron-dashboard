// @vitest-environment jsdom

/**
 * The BLE client that fetches the SmartSolar's stored history, driven offline.
 *
 * The controller is on the boat and accepts one client at a time, so everything below is a fake
 * GATT replaying `tests/fixtures/solarHistoryWire.json`: the session-open and keepalive frames the
 * vendor app wrote, the read requests it sent, and the value reports that came back. The two
 * captured reports are replayed byte for byte; the other twenty-nine wrap the controller's own
 * captured payload in the framing those two establish, because the capture kept every payload and
 * only two of the envelopes around them.
 *
 * Two properties get their own cases rather than being left to inspection. One read outstanding at
 * a time is a correctness property, not a performance choice — the tunnel has no correlation id, so
 * a second outstanding read would let a resynchronised stream deliver one register's bytes as
 * another's. And no frame this client writes may carry the write opcode except the captured
 * keepalive, which is asserted over every byte that reached the radio.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hexToBytes } from '../src/domain/bytes'
import {
  HISTORY_TOTALS_REGISTER,
  SOLAR_HISTORY_REGISTERS,
} from '../src/domain/solar/SolarHistoryRegister'
import { TUNNEL_KEEPALIVE_FRAME } from '../src/domain/solar/tunnel/session'
import { TUNNEL_OPCODE_BYTES } from '../src/domain/solar/tunnel/TunnelOpcode'
import type { RecordedSolarHistoryDay } from '../src/domain/solar/RecordedSolarHistoryDay'
import type { SolarHistoryDayReading } from '../src/domain/solar/SolarHistoryDayReading'
import { VictronHistoryClient } from '../src/infrastructure/ble/VictronHistoryClient'
import wire from './fixtures/solarHistoryWire.json'

/** The three characteristics of the tunnel, as the fake radio names them. */
type TunnelLine = 'control' | 'command' | 'bulk'

const CHARACTERISTIC_LINES: Readonly<Record<string, TunnelLine>> = {
  '306b0002-b081-4037-83dc-e59fcc3cdfd0': 'control',
  '306b0003-b081-4037-83dc-e59fcc3cdfd0': 'command',
  '306b0004-b081-4037-83dc-e59fcc3cdfd0': 'bulk',
}

/** What a Bluetooth notification carries at the MTU these sessions negotiate. */
const NOTIFICATION_BYTES = 20

/** Byte 0 of a day the controller has not filled in yet. */
const UNWRITTEN_DAY_RECORD_FLAG = 0x04

const VALUE_REPORT_OPCODE = TUNNEL_OPCODE_BYTES.valueReport
const READ_OPCODE = TUNNEL_OPCODE_BYTES.read
const WRITE_OPCODE = TUNNEL_OPCODE_BYTES.write

/** `08 03 19 <reg-be16> 58 22`, the envelope both captured value reports carry. */
const VALUE_REPORT_INTERFACE = 0x03
const CBOR_TWO_BYTE_UNSIGNED = 0x19
const CBOR_BYTE_STRING_ONE_BYTE_LENGTH = 0x58

const capturedTotals = hexToBytes(wire.totals)
const capturedDays = new Map(wire.days.map((day) => [day.register, hexToBytes(day.bytes)]))

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The value report the controller sends for a register holding this payload. */
function valueReport(register: number, payload: Uint8Array): Uint8Array {
  const envelope = Uint8Array.of(
    VALUE_REPORT_OPCODE,
    VALUE_REPORT_INTERFACE,
    CBOR_TWO_BYTE_UNSIGNED,
    register >> 8,
    register & 0xff,
    CBOR_BYTE_STRING_ONE_BYTE_LENGTH,
    payload.length,
  )
  const report = new Uint8Array(envelope.length + payload.length)
  report.set(envelope, 0)
  report.set(payload, envelope.length)
  return report
}

/** A `09` reply: the register exists and the controller answered with a status code instead. */
function statusReply(register: number, statusCode: number): Uint8Array {
  return Uint8Array.of(
    TUNNEL_OPCODE_BYTES.registerUnsupported,
    VALUE_REPORT_INTERFACE,
    CBOR_TWO_BYTE_UNSIGNED,
    register >> 8,
    register & 0xff,
    statusCode,
  )
}

/**
 * The register a read request asks for. Parsed here by hand rather than through the codec, which
 * refuses a host request on sight — this is the controller's side of the conversation.
 */
function requestedRegister(request: Uint8Array): number | null {
  if (request.length !== 6 || request[0] !== READ_OPCODE) return null
  return (request[4] << 8) | request[5]
}

interface FakeCharacteristic {
  properties: { writeWithoutResponse: boolean }
  value: DataView | null
  addEventListener: (type: string, listener: EventListener) => void
  removeEventListener: (type: string, listener: EventListener) => void
  startNotifications: ReturnType<typeof vi.fn>
  stopNotifications: ReturnType<typeof vi.fn>
  writeValueWithoutResponse: ReturnType<typeof vi.fn>
  writeValueWithResponse: ReturnType<typeof vi.fn>
  fire(bytes: Uint8Array): void
}

interface WrittenFrame {
  readonly line: TunnelLine
  readonly bytes: Uint8Array
}

interface Radio {
  requestDevice: ReturnType<typeof vi.fn>
  gattDisconnect: ReturnType<typeof vi.fn>
  characteristic(line: TunnelLine): FakeCharacteristic
  /** Every frame the client put on the wire, in order, with the characteristic it went to. */
  readonly written: readonly WrittenFrame[]
  /** Subscriptions and writes interleaved, so a case can assert what happened before what. */
  readonly log: readonly string[]
  /** What the controller does when a frame lands on the command characteristic. */
  answer: (frame: Uint8Array, radio: Radio) => void
  /** Deliver bytes as notifications of MTU size, as the browser would. */
  deliver(line: TunnelLine, bytes: Uint8Array): void
  dropLink(): void
}

/** The mutable side of the radio: what a case reads back through `Radio`'s readonly views. */
interface RadioTape {
  readonly written: WrittenFrame[]
  readonly log: string[]
  answer(frame: Uint8Array): void
}

function fakeCharacteristic(line: TunnelLine, tape: RadioTape): FakeCharacteristic {
  const listeners = new Set<EventListener>()
  const characteristic: FakeCharacteristic = {
    properties: { writeWithoutResponse: true },
    value: null,
    addEventListener: (type, listener) => {
      if (type === 'characteristicvaluechanged') listeners.add(listener)
    },
    removeEventListener: (type, listener) => {
      if (type === 'characteristicvaluechanged') listeners.delete(listener)
    },
    startNotifications: vi.fn(async () => {
      tape.log.push(`subscribe:${line}`)
      return characteristic
    }),
    stopNotifications: vi.fn(async () => undefined),
    writeValueWithoutResponse: vi.fn(async (buffer: ArrayBuffer) => {
      const frame = new Uint8Array(buffer)
      tape.log.push(`write:${line}:${toHex(frame)}`)
      tape.written.push({ line, bytes: frame })
      // Answered from inside the write, before its promise settles. A client that armed itself
      // after writing would lose every reply, and this is what makes that fail loudly.
      if (line === 'command') tape.answer(frame)
    }),
    writeValueWithResponse: vi.fn(async () => undefined),
    fire(bytes: Uint8Array) {
      characteristic.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (const listener of [...listeners]) {
        listener({ target: characteristic } as unknown as Event)
      }
    },
  }
  return characteristic
}

function buildRadio(): Radio {
  const written: WrittenFrame[] = []
  const log: string[] = []
  const deviceListeners = new Set<EventListener>()
  const gattDisconnect = vi.fn(() => {
    gatt.connected = false
  })

  const radio = { written, log, gattDisconnect, answer: () => undefined } as unknown as Radio
  const tape: RadioTape = { written, log, answer: (frame) => radio.answer(frame, radio) }

  const characteristics: Record<TunnelLine, FakeCharacteristic> = {
    control: fakeCharacteristic('control', tape),
    command: fakeCharacteristic('command', tape),
    bulk: fakeCharacteristic('bulk', tape),
  }

  const service = {
    getCharacteristic: vi.fn(async (uuid: string) => characteristics[CHARACTERISTIC_LINES[uuid]]),
  }
  const server = { getPrimaryService: vi.fn(async () => service) }
  const gatt = {
    connected: false,
    connect: vi.fn(async () => {
      gatt.connected = true
      return server
    }),
    disconnect: gattDisconnect,
  }
  const device = {
    id: 'solar-1',
    name: 'SmartSolar HQ2149',
    gatt,
    addEventListener: (type: string, listener: EventListener) => {
      if (type === 'gattserverdisconnected') deviceListeners.add(listener)
    },
    removeEventListener: (type: string, listener: EventListener) => {
      if (type === 'gattserverdisconnected') deviceListeners.delete(listener)
    },
  }
  const requestDevice = vi.fn(async () => device)

  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice } })

  radio.requestDevice = requestDevice
  radio.characteristic = (line) => characteristics[line]
  radio.deliver = (line, bytes) => {
    for (let offset = 0; offset < bytes.length; offset += NOTIFICATION_BYTES) {
      characteristics[line].fire(bytes.subarray(offset, offset + NOTIFICATION_BYTES))
    }
  }
  radio.dropLink = () => {
    gatt.connected = false
    for (const listener of [...deviceListeners]) {
      listener(new Event('gattserverdisconnected'))
    }
  }
  return radio
}

/**
 * A controller that answers every history register out of the fixture. The two registers whose
 * envelopes were captured are replayed verbatim; the rest are the captured payload in the framing
 * those two establish.
 */
function answersFromCapture(
  options: { readonly totals?: Uint8Array; readonly days?: ReadonlyMap<number, Uint8Array> } = {},
): Radio['answer'] {
  const totals = options.totals ?? capturedTotals
  const days = options.days ?? capturedDays
  return (frame, radio) => {
    const register = requestedRegister(frame)
    if (register === null) return
    if (register === HISTORY_TOTALS_REGISTER) {
      const captured = hexToBytes(wire.capturedFrames.valueReportTotals)
      radio.deliver('command', options.totals ? valueReport(register, totals) : captured)
      return
    }
    const payload = days.get(register)
    if (payload === undefined) return
    radio.deliver('command', valueReport(register, payload))
  }
}

/**
 * The same controller, answering a fixed time after the request. Real replies are not instant, and
 * a sweep that resolves inside one tick of fake time leaves no window for the keepalive to run in.
 */
function answersAfter(delayMs: number, answer: Radio['answer']): Radio['answer'] {
  return (frame, radio) => {
    if (requestedRegister(frame) === null) return
    setTimeout(() => answer(frame, radio), delayMs)
  }
}

/** Every read request the client sent, in the order it sent them. */
function registersRequested(radio: Radio): number[] {
  return radio.written
    .map((frame) => requestedRegister(frame.bytes))
    .filter((register): register is number => register !== null)
}

/** Keepalives are the only frames on this link that carry the write opcode. */
function keepalivesWritten(): number {
  return radio.written.filter((frame) => frame.bytes[0] === WRITE_OPCODE).length
}

function recorded(reading: SolarHistoryDayReading): RecordedSolarHistoryDay {
  if (!reading.day.recorded) throw new Error(`register 0x${reading.register.toString(16)} is unwritten`)
  return reading.day
}

let radio: Radio

beforeEach(() => {
  radio = buildRadio()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'bluetooth')
})

describe('VictronHistoryClient session', () => {
  it('subscribes to all three characteristics before it writes, then opens the session in order', async () => {
    radio.answer = answersFromCapture()
    const client = new VictronHistoryClient()

    await client.readStoredHistory()

    const frames = wire.capturedFrames
    expect(radio.log.slice(0, 7)).toEqual([
      'subscribe:control',
      'subscribe:command',
      'subscribe:bulk',
      `write:control:${frames.sessionOpenControl[0]}`,
      `write:control:${frames.sessionOpenControl[1]}`,
      `write:command:${frames.sessionOpenCommand[0]}`,
      `write:command:${frames.sessionOpenCommand[1]}`,
    ])
  })

  it('treats the error the controller sends after the session opens as chatter', async () => {
    radio.answer = (frame, target) => {
      // The `0300` open frame draws `07 00 03 00` on this controller, every session, before a
      // single register has been asked for. The vendor app proceeds regardless, and so must this.
      if (toHex(frame) === wire.capturedFrames.sessionOpenCommand[1]) {
        target.deliver('command', hexToBytes(wire.capturedFrames.sessionErrorAfterOpen))
        return
      }
      answersFromCapture()(frame, target)
    }
    const client = new VictronHistoryClient()

    const transfer = await client.readStoredHistory()

    expect(transfer.outcome).toBe('days-read')
    expect(transfer.refusedRegisters).toEqual([])
  })

  it('closes the tunnel when the sweep is done, because the controller allows one client', async () => {
    radio.answer = answersFromCapture()
    const client = new VictronHistoryClient()

    await client.readStoredHistory()

    expect(radio.gattDisconnect).toHaveBeenCalledTimes(1)
    for (const line of ['control', 'command', 'bulk'] as const) {
      expect(radio.characteristic(line).stopNotifications).toHaveBeenCalledTimes(1)
    }
    expect(client.reading).toBe(false)
    expect(client.deviceName).toBe('SmartSolar HQ2149')
  })

  it('joins a second read to the session already running instead of opening a rival one', async () => {
    radio.answer = answersFromCapture()
    const client = new VictronHistoryClient()

    const [first, second] = await Promise.all([client.readStoredHistory(), client.readStoredHistory()])

    expect(radio.requestDevice).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('keeps the tunnel alive on its interval, and stops the moment the session closes', async () => {
    vi.useFakeTimers()
    // Two and a half seconds a register, which is inside the quiet gap and slow enough that the
    // sweep runs long past the keepalive period.
    radio.answer = answersAfter(2_500, answersFromCapture())
    const client = new VictronHistoryClient()

    const reading = client.readStoredHistory()
    await vi.advanceTimersByTimeAsync(3_500)
    const afterFirstPeriod = keepalivesWritten()
    await vi.advanceTimersByTimeAsync(3_500)
    const afterSecondPeriod = keepalivesWritten()
    // Past the sweep's own ceiling, which is what ends a session this slow.
    await vi.advanceTimersByTimeAsync(60_000)
    await reading
    const atClose = keepalivesWritten()
    await vi.advanceTimersByTimeAsync(20_000)

    expect(afterFirstPeriod).toBe(1)
    expect(afterSecondPeriod).toBe(2)
    expect(keepalivesWritten()).toBe(atClose)
  })
})

describe('VictronHistoryClient sweep', () => {
  it('reads the totals register first, then one day register per stored day', async () => {
    radio.answer = answersFromCapture()
    const client = new VictronHistoryClient()

    const transfer = await client.readStoredHistory()

    expect(transfer.totals?.daysAvailable).toBe(30)
    // Totals, then today, then one register per day of age. Thirty days behind today is
    // thirty-one records, and the sweep stops there rather than one short of it.
    expect(registersRequested(radio)).toEqual([
      HISTORY_TOTALS_REGISTER,
      ...wire.days.map((day) => day.register),
    ])
    expect(transfer.days).toHaveLength(31)
    expect(transfer.outcome).toBe('days-read')
  })

  it('hands each register its own payload, agreeing with the vendor export day by day', async () => {
    radio.answer = answersFromCapture()
    const client = new VictronHistoryClient()

    const transfer = await client.readStoredHistory()

    // Every day the controller holds is swept, oldest included: it reports thirty days behind
    // today and answers thirty-one registers, and the last of them is the one day that exists
    // nowhere else once it rolls off.
    const swept = new Map(transfer.days.map((reading) => [reading.register, reading]))
    expect(swept.size).toBe(wire.days.length)
    expect(swept.has(0x106e)).toBe(true)

    // The export was taken a day before the capture, so it covers every swept day but the two
    // newest. All of them are compared; a sweep that stopped short would fail on the count.
    const compared = wire.expectedFromVendorExport.filter((day) => swept.has(day.register))
    expect(compared).toHaveLength(wire.expectedFromVendorExport.length)

    for (const exported of compared) {
      const day = recorded(swept.get(exported.register)!)
      expect(Math.round(day.yieldKwh * 1_000)).toBe(exported.yieldWh)
      expect(day.maxPvPower).toBe(exported.maxPvPowerW)
      expect(day.minutesInFloat).toBe(exported.minutesInFloat)
    }
  })

  it('keeps only one read outstanding, so a resynchronised stream cannot cross two replies', async () => {
    // The totals register answers and nothing else does. A client that batched its requests would
    // have every day register on the wire by now; one that waits has asked for exactly one.
    vi.useFakeTimers()
    radio.answer = (frame, target) => {
      if (requestedRegister(frame) !== HISTORY_TOTALS_REGISTER) return
      answersFromCapture()(frame, target)
    }
    const client = new VictronHistoryClient()

    const reading = client.readStoredHistory()
    await vi.advanceTimersByTimeAsync(3_100)
    const transfer = await reading

    expect(registersRequested(radio)).toEqual([HISTORY_TOTALS_REGISTER, wire.days[0].register])
    expect(transfer.outcome).toBe('stalled')
    expect(transfer.totals?.daysAvailable).toBe(30)
    expect(transfer.days).toEqual([])
  })

  it('reads a reply that arrived split across the command and bulk characteristics', async () => {
    radio.answer = (frame, target) => {
      const register = requestedRegister(frame)
      if (register === null) return
      const payload = register === HISTORY_TOTALS_REGISTER ? capturedTotals : capturedDays.get(register)
      if (payload === undefined) return
      // Torn mid-payload and finished on the other characteristic, which is what the tunnel does
      // with anything that does not fit one notification.
      const report = valueReport(register, payload)
      target.deliver('command', report.subarray(0, 13))
      target.deliver('bulk', report.subarray(13))
    }
    const client = new VictronHistoryClient()

    const transfer = await client.readStoredHistory()

    expect(transfer.outcome).toBe('days-read')
    expect(transfer.days).toHaveLength(31)
    const today = recorded(transfer.days[0])
    const capturedToday = hexToBytes(wire.capturedFrames.valueReportToday)
    // The same day the captured envelope carries, reassembled out of two characteristics.
    expect(today.daySequenceNumber).toBe(capturedToday[39] | (capturedToday[40] << 8))
  })

  it('reports a payload it cannot read and carries on with the next register', async () => {
    const onError = vi.fn()
    const damaged = new Uint8Array(capturedDays.get(wire.days[1].register)!)
    // Flag byte 0x02 is neither a written day nor an unwritten register, so the decoder refuses it.
    damaged[0] = 0x02
    radio.answer = (frame, target) => {
      const register = requestedRegister(frame)
      if (register === wire.days[1].register) {
        target.deliver('command', valueReport(register, damaged))
        return
      }
      answersFromCapture()(frame, target)
    }
    const client = new VictronHistoryClient({ onError })

    const transfer = await client.readStoredHistory()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(transfer.unreadableReplyCount).toBe(1)
    expect(transfer.days).toHaveLength(30)
    expect(transfer.outcome).toBe('days-read')
  })

  it('reports progress against the day count the totals record declared', async () => {
    const onProgress = vi.fn()
    radio.answer = answersFromCapture()
    const client = new VictronHistoryClient({ onProgress })

    await client.readStoredHistory()

    expect(onProgress).toHaveBeenNthCalledWith(1, 0, 31)
    expect(onProgress).toHaveBeenLastCalledWith(31, 31)
  })
})

describe('VictronHistoryClient outcomes', () => {
  it('resolves rather than rejecting when the controller never answers', async () => {
    vi.useFakeTimers()
    const client = new VictronHistoryClient()

    const reading = client.readStoredHistory()
    await vi.advanceTimersByTimeAsync(6_100)
    const transfer = await reading

    expect(transfer.outcome).toBe('no-answer')
    expect(transfer.notificationBytes).toBe(0)
    expect(transfer.days).toEqual([])
    expect(transfer.totals).toBeNull()
  })

  it('separates bytes that parsed into nothing from silence', async () => {
    vi.useFakeTimers()
    radio.answer = (frame, target) => {
      if (requestedRegister(frame) === null) return
      // A reply whose head was lost: every byte is real, and no PDU begins at any of them.
      target.deliver('command', capturedTotals)
    }
    const client = new VictronHistoryClient()

    const reading = client.readStoredHistory()
    await vi.advanceTimersByTimeAsync(6_100)
    const transfer = await reading

    expect(transfer.outcome).toBe('torn-stream')
    expect(transfer.notificationBytes).toBe(capturedTotals.length)
    expect(transfer.pduCount).toBe(0)
  })

  it('calls a status code on the totals register a refusal, and asks for no days', async () => {
    radio.answer = (frame, target) => {
      const register = requestedRegister(frame)
      if (register === null) return
      target.deliver('command', statusReply(register, 0x02))
    }
    const client = new VictronHistoryClient()

    const transfer = await client.readStoredHistory()

    expect(transfer.outcome).toBe('refused')
    expect(transfer.refusedRegisters).toEqual([HISTORY_TOTALS_REGISTER])
    expect(registersRequested(radio)).toEqual([HISTORY_TOTALS_REGISTER])
  })

  it('calls a controller with nothing stored empty, not broken', async () => {
    const emptyTotals = new Uint8Array(capturedTotals)
    // Byte 18 is the count of completed days behind today. Zero is a controller powered on and not
    // yet keeping one, which is a result and not a failure to read one. Today's register still
    // exists and still answers — carrying the unwritten flag, which is the only honest way to model
    // this: a sweep that never asked for it could not tell an empty controller from a silent one.
    emptyTotals[18] = 0
    const unwrittenToday = new Uint8Array(34)
    unwrittenToday[0] = UNWRITTEN_DAY_RECORD_FLAG
    radio.answer = answersFromCapture({
      totals: emptyTotals,
      days: new Map([[wire.days[0].register, unwrittenToday]]),
    })
    const client = new VictronHistoryClient()

    const transfer = await client.readStoredHistory()

    expect(transfer.outcome).toBe('empty-history')
    expect(transfer.totals?.daysAvailable).toBe(0)
    expect(registersRequested(radio)).toEqual([HISTORY_TOTALS_REGISTER, wire.days[0].register])
  })

  it('settles with the days it had when the link went away mid-sweep', async () => {
    let registersAnswered = 0
    radio.answer = (frame, target) => {
      if (requestedRegister(frame) === null) return
      answersFromCapture()(frame, target)
      registersAnswered += 1
      // Totals, then today, then yesterday — and the radio goes while that last reply is still in
      // the air, before the sweep has had a turn to read it.
      if (registersAnswered === 3) target.dropLink()
    }
    const client = new VictronHistoryClient()

    const transfer = await client.readStoredHistory()

    // One day, not two: a reply the radio outran is lost, and what the sweep already had is kept.
    expect(transfer.outcome).toBe('days-read')
    expect(transfer.days.map((reading) => reading.register)).toEqual([wire.days[0].register])
    expect(transfer.totals?.daysAvailable).toBe(30)
  })

  it('rejects when there is no session to measure at all', async () => {
    radio.requestDevice.mockRejectedValueOnce(new DOMException('User cancelled', 'NotFoundError'))
    const client = new VictronHistoryClient()

    await expect(client.readStoredHistory()).rejects.toThrow(/cancelled/i)
    expect(client.reading).toBe(false)
  })
})

// A write and a read differ by one byte on this tunnel, and a register a few bits from the history
// block is believed to erase the stored days. These assert the property over what actually reached
// the radio, so an encoder added later fails here rather than on the boat.

describe('VictronHistoryClient write safety', () => {
  it('writes no frame carrying the write opcode except the captured keepalive', async () => {
    vi.useFakeTimers()
    // Slowly, so the keepalive runs: a sweep that finishes inside one tick never writes one, and
    // the keepalive is the only frame this assertion has to make an exception for.
    radio.answer = answersAfter(2_500, answersFromCapture())
    const client = new VictronHistoryClient()

    const reading = client.readStoredHistory()
    await vi.advanceTimersByTimeAsync(60_000)
    await reading

    const keepaliveHex = toHex(TUNNEL_KEEPALIVE_FRAME)
    const writeFrames = radio.written.filter((frame) => frame.bytes[0] === WRITE_OPCODE)
    expect(writeFrames.length).toBeGreaterThan(0)
    for (const frame of writeFrames) {
      expect(toHex(frame.bytes)).toBe(keepaliveHex)
    }
  })

  it('asks only for registers in the frozen history set', async () => {
    radio.answer = answersFromCapture()
    const reachable: readonly number[] = SOLAR_HISTORY_REGISTERS
    const client = new VictronHistoryClient()

    await client.readStoredHistory()

    const requested = registersRequested(radio)
    expect(requested.length).toBe(32)
    for (const register of requested) {
      expect(reachable).toContain(register)
    }
  })
})
