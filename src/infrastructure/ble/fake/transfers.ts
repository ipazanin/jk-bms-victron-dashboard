/**
 * Answers built by driving the real transports over captured bytes.
 *
 * Nothing here states an outcome, a record count or a byte total. Every answer is produced by
 * feeding a real `DetailLogRun` or `SolarHistoryRun` the bytes a device sent and letting it settle,
 * so the receipt on screen is derived by the same code that derives it from a radio. An answer
 * assembled by hand could say "836 records" over a reply that carried none, and the one screen that
 * exists to tell a working read from a broken one would be the screen that lied.
 *
 * The failure shapes are produced by giving a run *less*, never by writing a failure down: silence
 * is a run that is stopped without being fed, and a torn burst is bytes that never assembled. Four
 * answers need bytes of a captured payload changed — a frame's type, a frame's declared record
 * count, a day register's record flag, and today's day record carried further into its own
 * afternoon — and each says which bytes and why.
 */

import { readDetailLogHeader } from '../../../domain/bms/detailLog'
import { FRAME_CELL_INFO, FRAME_DETAIL_LOG, frameType } from '../../../domain/bms/protocol'
import type { DetailLogTransfer } from '../../../domain/bms/DetailLogTransfer'
import { hexToBytes } from '../../../domain/bytes'
import { MIN_ALIGNMENT_OVERLAP } from '../../../domain/history/ringLedger'
import { decodeSolarHistoryDay, decodeSolarHistoryTotals } from '../../../domain/solar/history'
import {
  HISTORY_TODAY_REGISTER,
  HISTORY_TOTALS_REGISTER,
  MAX_HISTORY_DAYS,
  historyDayRegister,
} from '../../../domain/solar/SolarHistoryRegister'
import type {
  SolarHistoryDayRegister,
  SolarHistoryRegister,
} from '../../../domain/solar/SolarHistoryRegister'
import type { SolarHistoryTransfer } from '../../../domain/solar/SolarHistoryTransfer'
import { TUNNEL_CONTROL_OPEN_FRAMES } from '../../../domain/solar/tunnel/session'
import type { TunnelPdu } from '../../../domain/solar/tunnel/TunnelPdu'
import { DetailLogRun } from '../DetailLogRun'
import { SolarHistoryRun } from '../SolarHistoryRun'
import type { SolarHistoryHandlers } from '../VictronHistoryClient'
import type { CapturedRingRead } from './fixture/CapturedRingRead'
import type { PackRingWireFixture } from './fixture/PackRingWireFixture'
import type { SolarHistoryWireFixture } from './fixture/SolarHistoryWireFixture'

/**
 * The captured bytes, fetched on the first answer that needs them and then kept.
 *
 * Fetched rather than imported for the reason `loadPlaybackFixture.ts` gives, at its own smaller
 * price: the pack's ring and the controller's history are another 89 KB on top of the recording.
 */
let ringBytes: Promise<PackRingWireFixture> | null = null
let historyBytes: Promise<SolarHistoryWireFixture> | null = null

function packRingWire(): Promise<PackRingWireFixture> {
  ringBytes ??= import('./fixture/packRingWire.json').then((wire) => wire.default)
  return ringBytes
}

function solarHistoryWire(): Promise<SolarHistoryWireFixture> {
  historyBytes ??= import('./fixture/solarHistoryWire.json').then((wire) => wire.default)
  return historyBytes
}

/** Byte 4 of an assembled frame is its type, which is all `frameType` reads. */
const FRAME_TYPE_OFFSET = 4

/** Byte 8 of a stored-log frame is how many records it declares it carries. */
const RECORD_COUNT_OFFSET = 8

/**
 * Records in the deliberately unplaceable read. Below the overlap the fold needs to prove a shift,
 * so the run can never be aligned against a ledger and is discarded however much of it is already
 * held — which is the only way that sentence on the receipt is reachable from whole captured
 * frames, none of which carries fewer records than that.
 */
const SHORT_RUN_RECORDS = MIN_ALIGNMENT_OVERLAP - 1

/** Bytes of a captured frame kept in the torn burst: a notification that arrived, and no more. */
const TORN_BURST_BYTES = 120

/** Byte 0 of a daily register's payload; 0x04 is a day the controller has not reached yet. */
const RECORD_FLAG_OFFSET = 0
const UNWRITTEN_DAY_RECORD_FLAG = 0x04

/**
 * Bytes 1..4 of a day record are the day's yield in hundredths of a kilowatt-hour, and bytes 22..23
 * are how many of its minutes were spent in float. Both little-endian, as every field there is.
 */
const DAY_YIELD_OFFSET = 1
const DAY_FLOAT_MINUTES_OFFSET = 22

/**
 * How much further into today a second sweep finds the record: an afternoon's worth of float.
 *
 * These two figures move and no others do. Bulk and absorption are behind a day by the time it is in
 * float, and the record's four maxima and its minimum battery voltage are ratchets that an afternoon
 * of float does not touch — moving one would describe a different day rather than a longer one. The
 * pair stays consistent with the record it is applied to: 0.18 kWh across 96 further minutes
 * averages about 110 W, well under the 308 W peak the captured record already carries.
 */
const AFTERNOON_YIELD_HUNDREDTHS_KWH = 18
const AFTERNOON_FLOAT_MINUTES = 96

/**
 * Byte one of a tunnel PDU, echoed from the request. The SmartSolar's register reads run on 0x03;
 * the decoder reports it rather than asserting it, and so does this.
 */
const TUNNEL_INTERFACE_ID = 0x03

/** What the controller answers a register it will not serve with. */
const REGISTER_UNSUPPORTED_STATUS = 0x02

async function capturedRead(read: 'earlier' | 'later'): Promise<CapturedRingRead> {
  const packRing = await packRingWire()
  return read === 'earlier' ? packRing.earlier : packRing.later
}

/**
 * Whole frames from one burst whose records touch a window of ring indexes.
 *
 * Frames, not records: a burst delivers 300-byte frames and a reader either got one or did not, so
 * cutting one open to land a window exactly would be inventing a shape the wire cannot produce.
 * The window is therefore a request for a stretch of the ring and not a promise of its edges.
 */
function framesCovering(read: CapturedRingRead, fromIndex: number, toIndex: number): Uint8Array[] {
  const frames: Uint8Array[] = []
  for (const hex of read.frames) {
    const frame = hexToBytes(hex)
    const header = readDetailLogHeader(frame)
    const lastIndex = header.firstRecordIndex + header.recordCount - 1
    if (header.firstRecordIndex <= toIndex && lastIndex >= fromIndex) frames.push(frame)
  }
  return frames
}

function allFrames(read: CapturedRingRead): Uint8Array[] {
  return read.frames.map(hexToBytes)
}

/**
 * One read, measured by the transport that measures a real one.
 *
 * Each frame is counted as a notification before it is offered as a frame, exactly where the
 * client counts it: a pack that never answered and a burst the link tore up both assemble to
 * nothing, and only the raw byte count separates them.
 */
function measureRead(
  frames: readonly Uint8Array[],
  packUtcOffsetMinutes: number,
): Promise<DetailLogTransfer> {
  const run = new DetailLogRun(packUtcOffsetMinutes)
  for (const frame of frames) {
    run.noteNotification(frame)
    run.noteFrame(frame)
    if (frameType(frame) === FRAME_DETAIL_LOG) run.readRecordsFrom(frame)
  }
  run.stop()
  return run.transfer
}

/** A whole captured burst: the pack's ring as it stood when the boat was visited. */
export async function wholeRingRead(
  read: 'earlier' | 'later',
  packUtcOffsetMinutes: number,
): Promise<DetailLogTransfer> {
  return measureRead(allFrames(await capturedRead(read)), packUtcOffsetMinutes)
}

/** The frames of one burst that touch a stretch of the ring, so two reads can be made to miss. */
export async function partialRingRead(
  read: 'earlier' | 'later',
  fromIndex: number,
  toIndex: number,
  packUtcOffsetMinutes: number,
): Promise<DetailLogTransfer> {
  const captured = await capturedRead(read)
  return measureRead(framesCovering(captured, fromIndex, toIndex), packUtcOffsetMinutes)
}

/**
 * A burst ending in a frame too short to place. The last frame of a read is genuinely a short one —
 * the ring rarely divides by twelve — and only its declared record count is changed, so what
 * arrives is the shape a pack really sends with a length nothing can align.
 */
export async function shortRunRead(packUtcOffsetMinutes: number): Promise<DetailLogTransfer> {
  const read = await capturedRead('later')
  const frame = hexToBytes(read.frames[read.frames.length - 1])
  frame[RECORD_COUNT_OFFSET] = SHORT_RUN_RECORDS
  return measureRead([frame], packUtcOffsetMinutes)
}

/** The pack ignored the command: not one byte came back inside the window. */
export function unansweredRead(packUtcOffsetMinutes: number): Promise<DetailLogTransfer> {
  return measureRead([], packUtcOffsetMinutes)
}

/** Bytes arrived and nothing assembled from them, which is a reply torn up in transit. */
export async function tornBurstRead(packUtcOffsetMinutes: number): Promise<DetailLogTransfer> {
  const earlier = await capturedRead('earlier')
  const run = new DetailLogRun(packUtcOffsetMinutes)
  run.noteNotification(hexToBytes(earlier.frames[0]).subarray(0, TORN_BURST_BYTES))
  run.stop()
  return run.transfer
}

/**
 * Whole frames assembled and not one was a stored log — a link that works, carrying an answer that
 * is not the one the command asked for. A captured frame with its type byte changed, because the
 * run reads nothing else off a frame it is not going to decode.
 */
export async function readWithoutStoredLog(
  packUtcOffsetMinutes: number,
): Promise<DetailLogTransfer> {
  const earlier = await capturedRead('earlier')
  const frame = hexToBytes(earlier.frames[0])
  frame[FRAME_TYPE_OFFSET] = FRAME_CELL_INFO
  return measureRead([frame], packUtcOffsetMinutes)
}

async function totalsPayload(): Promise<Uint8Array> {
  const solarHistory = await solarHistoryWire()
  return hexToBytes(solarHistory.totals)
}

async function dayPayloads(): Promise<Map<number, Uint8Array>> {
  const solarHistory = await solarHistoryWire()
  return new Map(solarHistory.days.map((day) => [day.register, hexToBytes(day.bytes)]))
}

/**
 * The session-open exchange, which proves a tunnel is live and says nothing about any register.
 * One acknowledgement per control frame the open writes, so the count comes from the session's own
 * frame list rather than from a number picked here.
 */
function openTunnel(run: SolarHistoryRun): void {
  TUNNEL_CONTROL_OPEN_FRAMES.forEach(() => run.noteControlNotification())
}

/**
 * One register answered, armed before it is answered exactly as a real read is: a reply can arrive
 * before the write settles, and a run armed afterwards would drop it.
 *
 * The fixture keeps payloads without the tunnel framing that carried them, so the payload stands in
 * as the notification. The byte count that reaches the receipt is therefore a floor on what the
 * wire really carried, and never more than it.
 */
function answerRegister(
  run: SolarHistoryRun,
  register: SolarHistoryRegister,
  payload: Uint8Array,
): Promise<TunnelPdu | null> {
  if (!run.running) return Promise.resolve(null)
  const answer = run.awaitAnswerFor(register)
  run.noteNotification(payload)
  run.notePdu({ opcode: 'valueReport', interfaceId: TUNNEL_INTERFACE_ID, register, payload })
  return answer
}

/** A register the controller answered for with a status code instead of a record. */
function refuseRegister(
  run: SolarHistoryRun,
  register: SolarHistoryRegister,
): Promise<TunnelPdu | null> {
  if (!run.running) return Promise.resolve(null)
  const answer = run.awaitAnswerFor(register)
  const reply = [TUNNEL_INTERFACE_ID, register & 0xff, register >> 8, REGISTER_UNSUPPORTED_STATUS]
  run.noteNotification(new Uint8Array(reply))
  run.notePdu({
    opcode: 'registerUnsupported',
    interfaceId: TUNNEL_INTERFACE_ID,
    register,
    statusCode: REGISTER_UNSUPPORTED_STATUS,
  })
  return answer
}

/**
 * The sweep the client walks: totals first, because its day count is what bounds the backlog, then
 * one register per day of age. `payloadFor` decides what each day register answers with, which is
 * the only thing that separates a controller full of days from one that has kept none, and it is
 * told which register it is answering because today's is the one register a controller rewrites.
 */
async function sweepRegisters(
  run: SolarHistoryRun,
  handlers: SolarHistoryHandlers,
  payloadFor: (payload: Uint8Array, register: SolarHistoryDayRegister) => Uint8Array,
): Promise<void> {
  const totalsReply = await answerRegister(run, HISTORY_TOTALS_REGISTER, await totalsPayload())
  if (totalsReply === null) return
  if (totalsReply.opcode !== 'valueReport') {
    run.noteRefusal(totalsReply.register)
    return
  }

  const totals = decodeSolarHistoryTotals(totalsReply.payload)
  run.recordTotals(totals)
  // Today is a record of its own on top of the completed days behind it, which is why the captured
  // controller reports thirty and answers thirty-one registers.
  const dayCount = Math.min(totals.daysAvailable + 1, MAX_HISTORY_DAYS)
  const payloads = await dayPayloads()
  handlers.onProgress?.(0, dayCount)

  for (let daysAgo = 0; daysAgo < dayCount; daysAgo += 1) {
    const register = historyDayRegister(daysAgo)
    const captured = payloads.get(register)
    if (captured === undefined) {
      throw new Error(`the history fixture holds no register 0x${register.toString(16)}`)
    }
    const reply = await answerRegister(run, register, payloadFor(captured, register))
    if (reply === null) return
    if (reply.opcode !== 'valueReport') {
      // A register refused inside the range the day count promised ends the sweep: the controller
      // has stopped serving them, and the ones beyond it hold nothing worth another round trip.
      run.noteRefusal(register)
      return
    }
    run.recordDay({ register, daysAgo, day: decodeSolarHistoryDay(reply.payload) })
    handlers.onProgress?.(daysAgo + 1, dayCount)
  }
}

function asCaptured(payload: Uint8Array): Uint8Array {
  return payload
}

/** The same record with its flag changed to the one a register the controller has not written carries. */
function asUnwritten(payload: Uint8Array): Uint8Array {
  const unwritten = Uint8Array.from(payload)
  unwritten[RECORD_FLAG_OFFSET] = UNWRITTEN_DAY_RECORD_FLAG
  return unwritten
}

/**
 * The same day, read again later in it.
 *
 * The sequence number is deliberately untouched, and it is the whole reason this works: the ledger
 * matches an incoming day to a stored one by that counter, so a record carrying a new one would be
 * filed as a day of its own rather than as a revision of the day already held.
 */
function asStillBeingWritten(payload: Uint8Array): Uint8Array {
  const later = Uint8Array.from(payload)
  const record = new DataView(later.buffer, later.byteOffset, later.byteLength)
  record.setUint32(
    DAY_YIELD_OFFSET,
    record.getUint32(DAY_YIELD_OFFSET, true) + AFTERNOON_YIELD_HUNDREDTHS_KWH,
    true,
  )
  record.setUint16(
    DAY_FLOAT_MINUTES_OFFSET,
    record.getUint16(DAY_FLOAT_MINUTES_OFFSET, true) + AFTERNOON_FLOAT_MINUTES,
    true,
  )
  return later
}

/**
 * One tunnel session, measured by the run that measures a real one.
 *
 * Opening and stopping belong here rather than in each answer below, because both are load-bearing
 * and neither is what any of them is about: the open is what the receipt counts its control traffic
 * from, and the stop is what settles the transfer — a session left running holds the screen on
 * 'Sweeping…' until its own ceiling times out. The stop is in a `finally` so that a fixture which
 * will not load ends the session rather than stranding it.
 */
async function measureSession(
  exchange: (run: SolarHistoryRun) => Promise<void> | void,
): Promise<SolarHistoryTransfer> {
  const run = new SolarHistoryRun()
  openTunnel(run)
  try {
    await exchange(run)
  } finally {
    run.stop()
  }
  return run.transfer
}

function measureSweep(
  handlers: SolarHistoryHandlers,
  payloadFor: (payload: Uint8Array, register: SolarHistoryDayRegister) => Uint8Array,
): Promise<SolarHistoryTransfer> {
  return measureSession((run) => sweepRegisters(run, handlers, payloadFor))
}

/** Every register the captured controller answered, day by day back to the oldest it kept. */
export function wholeHistorySweep(handlers: SolarHistoryHandlers): Promise<SolarHistoryTransfer> {
  return measureSweep(handlers, asCaptured)
}

/**
 * The same controller swept again while today's record is still being written.
 *
 * Every completed day answers what it answered before, byte for byte, and today's register answers
 * a day that has got further. That asymmetry is the state itself: a controller nobody has touched
 * serves identical bytes for every day behind it, so a re-read of the whole captured backlog can
 * only ever report days already held, unchanged — and the one register that legitimately differs
 * between two sweeps of the same afternoon is the one this changes.
 *
 * Only worth arming over a ledger that already holds the day. Nothing is stored here, so a sweep
 * of this against an empty ledger appends today like any other first sighting and revises nothing.
 */
export function revisedTodaySweep(handlers: SolarHistoryHandlers): Promise<SolarHistoryTransfer> {
  return measureSweep(handlers, (payload, register) =>
    register === HISTORY_TODAY_REGISTER ? asStillBeingWritten(payload) : asCaptured(payload),
  )
}

/** A controller that answers every register and has written none of them: a freshly commissioned one. */
export function unwrittenHistorySweep(handlers: SolarHistoryHandlers): Promise<SolarHistoryTransfer> {
  return measureSweep(handlers, asUnwritten)
}

/** The totals came back and then the controller stopped answering, part-way into the backlog. */
export function totalsOnlySweep(): Promise<SolarHistoryTransfer> {
  return measureSession(async (run) => {
    const reply = await answerRegister(run, HISTORY_TOTALS_REGISTER, await totalsPayload())
    if (reply !== null && reply.opcode === 'valueReport') {
      run.recordTotals(decodeSolarHistoryTotals(reply.payload))
    }
  })
}

/** The controller answered the very first read with a status code, so no day was ever asked for. */
export function refusedSweep(): Promise<SolarHistoryTransfer> {
  return measureSession(async (run) => {
    const reply = await refuseRegister(run, HISTORY_TOTALS_REGISTER)
    if (reply !== null && reply.opcode !== 'valueReport') run.noteRefusal(reply.register)
  })
}

/** The tunnel opened and the controller said nothing about a single register. */
export function unansweredSweep(): Promise<SolarHistoryTransfer> {
  return measureSession(() => undefined)
}

/**
 * Bytes came back off the command characteristic and not one PDU parsed out of them. The totals
 * record's own bytes, handed over as a chunk the reassembler never found a frame boundary in.
 */
export function tornStreamSweep(): Promise<SolarHistoryTransfer> {
  return measureSession(async (run) => {
    run.noteNotification(await totalsPayload())
  })
}
