/**
 * The JK-BMS event logbook (command 0xA1, frame type 0x05).
 *
 * The device keeps a short ring of timestamped events — power cycles, protection trips, mode
 * changes — going back to when it was first powered on. This is the only history the BMS itself
 * holds: there is no per-day energy series in the protocol, so daily figures are folded from the
 * app's own recordings instead. See the capture notes for the frame layout, confirmed against a
 * real 19.10 unit and against the esphome-jk-bms decoder.
 *
 *   [4]     frame type 0x05
 *   [5]     frame counter
 *   [6..9]  uint32 LE record count
 *   [11..]  records, 5 bytes each: uint32 LE seconds-since-first-power-on, then a 1-byte event code
 *
 * Timestamps are seconds since the device first booted, not wall clock. The caller turns them into
 * dates using the pack's current uptime (boot ≈ now − uptime), and shows elapsed time when it can't.
 */

const RECORD_BASE = 11
const RECORD_STRIDE = 5
/** The device holds at most this many, and a corrupt count must not walk off the frame either. */
const MAX_EVENTS = 50

export interface LogbookEvent {
  /** Seconds since the device's first power-on. Absolute wall time is derived by the caller. */
  readonly secondsSinceBoot: number
  readonly code: number
  readonly label: string
}

/**
 * Labels from the esphome-jk-bms reference table, holding the codes a 19.10 unit emits. The table
 * is large and mostly protection events; the two cell ranges are generated, and any code without a
 * known label is shown as its raw hex rather than guessed at.
 */
const LOGBOOK_LABELS: Readonly<Record<number, string>> = {
  0x01: 'Boot',
  0x02: 'Shutdown',
  0x11: 'Cell overcharge protection',
  0x12: 'Cell overcharge protection released',
  0x13: 'Cell undervoltage protection',
  0x14: 'Cell undervoltage protection released',
  0x15: 'Charge overcurrent protection',
  0x16: 'Charge overcurrent protection released',
  0x1b: 'Charge low-temperature protection released',
  0x21: 'Discharge overcurrent protection',
  0x22: 'Discharge overcurrent protection released',
  0x2d: 'Turned off by button',
  0x30: 'CAN charge off',
  0x31: 'CAN charge on',
  0x32: 'CAN discharge off',
  0x33: 'CAN discharge on',
  0x34: 'RS485 charge off',
  0x35: 'RS485 charge on',
  0x36: 'RS485 discharge off',
  0x37: 'RS485 discharge on',
  0x38: 'Enter sleep',
  0x39: 'Charge MOSFET abnormal',
  0x3a: 'Discharge MOSFET abnormal',
  0x3b: 'Time calibration',
  0x3c: 'Cell count incorrect',
  0x3d: 'Button emergency on',
  0x3e: 'Button emergency off',
  0x3f: 'Button forced heating',
  0x44: 'Discharge overcurrent protection III',
}

export function logbookLabel(code: number): string {
  const known = LOGBOOK_LABELS[code]
  if (known !== undefined) return known
  if (code >= 0x64 && code <= 0x83) return `Cell ${code - 0x64 + 1} overcharge protection`
  if (code >= 0xc8 && code <= 0xe7) return `Cell ${code - 0xc8 + 1} overdischarge protection`
  return `Event 0x${code.toString(16).padStart(2, '0')}`
}

export function decodeLogbook(frame: Uint8Array): LogbookEvent[] {
  const data = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const declared = data.getUint32(6, true)
  const count = Math.min(declared, MAX_EVENTS)

  const events: LogbookEvent[] = []
  for (let index = 0; index < count; index += 1) {
    const base = RECORD_BASE + index * RECORD_STRIDE
    // Never read into the trailing checksum or past a short frame.
    if (base + RECORD_STRIDE > frame.length - 1) break
    const secondsSinceBoot = data.getUint32(base, true)
    const code = frame[base + 4]
    // A wholly empty slot is padding, not an event; a real boot carries code 0x01 at second zero.
    if (secondsSinceBoot === 0 && code === 0) continue
    events.push({ secondsSinceBoot, code, label: logbookLabel(code) })
  }
  return events
}
