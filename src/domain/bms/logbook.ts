/**
 * The JK-BMS event logbook (command 0xA1, frame type 0x05).
 *
 * The device keeps a short ring of timestamped events — power cycles, protection trips, mode
 * changes — going back to when it was first powered on. An entry is a code and a timestamp and
 * nothing else; the pack's other store, the detail log in `detailLog.ts`, holds full snapshots and
 * draws its event codes from the same vocabulary. See the capture notes for the frame layout,
 * confirmed against a real 19.10 unit and against the esphome-jk-bms decoder.
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
 * The event vocabulary, transcribed code for code from the `LOGBOOK_CODES` array in
 * esphome-jk-bms. That array is the only published mapping of these codes: JK documents a 16-bit
 * alarm bitfield at register 0x8B, which is a different vocabulary and cannot be used to check an
 * entry here. So a label is only ever copied across from that one table, never inferred from what
 * its neighbours mean — codes that read as a pair (a trip and its release, a protection and the
 * next severity level) are not always adjacent in the order JK assigned them.
 *
 * Every code the reference defines is listed, contiguously, so that a missing or shifted entry
 * shows up as a gap when read against the source. The wording is this repo's, matching the rest of
 * the UI rather than the reference's translation. The two per-cell ranges are generated instead of
 * listed, and a code the reference leaves blank is shown as raw hex rather than guessed at.
 */
const LOGBOOK_LABELS: Readonly<Record<number, string>> = {
  0x01: 'Boot',
  0x02: 'Shutdown',
  0x03: 'App charge off',
  0x04: 'App charge on',
  0x05: 'App discharge off',
  0x06: 'App discharge on',
  0x07: 'Remote charge off',
  0x08: 'Remote charge on',
  0x09: 'Remote discharge off',
  0x0a: 'Remote discharge on',
  0x0b: 'MOSFET over-temperature protection',
  0x0c: 'MOSFET over-temperature protection released',
  0x0d: 'Current sensor abnormal',
  0x0e: 'Current sensor abnormal released',
  0x0f: 'Coprocessor communication abnormal',
  0x10: 'Coprocessor communication abnormal released',
  0x11: 'Cell overcharge protection',
  0x12: 'Cell overcharge protection released',
  0x13: 'Battery overcharge protection',
  0x14: 'Battery overcharge protection released',
  0x15: 'Charge overcurrent protection',
  0x16: 'Charge overcurrent protection released',
  0x17: 'Charge short-circuit protection',
  0x18: 'Charge short-circuit protection released',
  0x19: 'Charge over-temperature protection',
  0x1a: 'Charge over-temperature protection released',
  0x1b: 'Charge low-temperature protection',
  0x1c: 'Charge low-temperature protection released',
  0x1d: 'Cell undervoltage protection',
  0x1e: 'Cell undervoltage protection released',
  0x1f: 'Battery undervoltage protection',
  0x20: 'Battery undervoltage protection released',
  0x21: 'Discharge overcurrent protection',
  0x22: 'Discharge overcurrent protection released',
  0x23: 'Discharge short-circuit protection',
  0x24: 'Discharge short-circuit protection released',
  0x25: 'Discharge over-temperature protection',
  0x26: 'Discharge over-temperature protection released',
  0x27: 'Watchdog reset',
  0x28: 'Discharge short-circuit protection II',
  0x29: 'Emergency mode enabled manually',
  0x2a: 'Emergency mode disabled manually',
  0x2b: 'Emergency mode ended automatically',
  0x2c: 'Turned off by app',
  0x2d: 'Turned off by button',
  0x2e: 'Discharge switch-on failed',
  0x2f: 'RS485 power off',
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
  0x40: 'Discharge overcurrent protection II',
  0x41: 'Discharge overcurrent protection III',
  0x42: 'Short-circuit protection release failed',
  0x43: 'Factory setting Li-ion',
  0x44: 'Factory setting LFP',
  0x45: 'Factory setting LTO',
  0x46: 'Remote emergency on',
  0x47: 'Remote emergency off',
  0x48: 'Discharge under-temperature protection',
  0x49: 'Discharge under-temperature protection released',
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
