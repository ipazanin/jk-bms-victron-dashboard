/**
 * JK-BMS BLE wire protocol.
 *
 * Read-only by construction: `buildCommand` refuses any opcode outside READ_COMMANDS,
 * so a settings-write frame cannot be produced from this module.
 *
 * Frames are a fixed 300 bytes and arrive split across GATT notifications, whose size
 * depends on the negotiated MTU (20 bytes on some hosts, ~180 on Android). Never assume
 * one notification is one frame.
 */

export const JK_SERVICE = 0xffe0
export const JK_CHARACTERISTIC = 0xffe1

export const CMD_DEVICE_INFO = 0x97
export const CMD_CELL_INFO = 0x96
const READ_COMMANDS: ReadonlySet<number> = new Set([CMD_DEVICE_INFO, CMD_CELL_INFO])

const COMMAND_HEADER = [0xaa, 0x55, 0x90, 0xeb] as const
export const RESPONSE_HEADER = [0x55, 0xaa, 0xeb, 0x90] as const

export const FRAME_LENGTH = 300
export const COMMAND_LENGTH = 20

export const FRAME_SETTINGS = 0x01
export const FRAME_CELL_INFO = 0x02
export const FRAME_DEVICE_INFO = 0x03

/** The cell-voltage and cell-resistance blocks each hold 32 slots, populated or not. */
export const MAX_CELLS = 32

export function buildCommand(command: number): Uint8Array {
  if (!READ_COMMANDS.has(command)) {
    throw new Error(`refusing to build non-read command 0x${command.toString(16)}`)
  }
  const frame = new Uint8Array(COMMAND_LENGTH)
  frame.set(COMMAND_HEADER, 0)
  frame[4] = command
  frame[19] = checksum(frame.subarray(0, 19))
  return frame
}

export function checksum(bytes: Uint8Array): number {
  let total = 0
  for (const byte of bytes) total = (total + byte) & 0xff
  return total
}

export function isChecksumValid(frame: Uint8Array): boolean {
  return frame.length === FRAME_LENGTH && checksum(frame.subarray(0, FRAME_LENGTH - 1)) === frame[FRAME_LENGTH - 1]
}

export function frameType(frame: Uint8Array): number {
  return frame[4]
}

function indexOfHeader(buffer: Uint8Array, from: number): number {
  const limit = buffer.length - RESPONSE_HEADER.length
  outer: for (let index = from; index <= limit; index += 1) {
    for (let offset = 0; offset < RESPONSE_HEADER.length; offset += 1) {
      if (buffer[index + offset] !== RESPONSE_HEADER[offset]) continue outer
    }
    return index
  }
  return -1
}

/**
 * Reassembles 300-byte frames from arbitrary notification chunks, discarding any frame
 * whose trailing checksum does not verify.
 *
 * A dropped notification leaves a truncated frame in the stream. Skipping a whole
 * FRAME_LENGTH past a bad checksum would then consume the *next*, valid frame along with
 * the wreckage, so on a checksum failure the scan resumes one byte after the bad header
 * and hunts for the next one.
 */
export class FrameAssembler {
  private buffer = new Uint8Array(0)

  /** Bytes held back awaiting the rest of a frame. Bounded under FRAME_LENGTH by construction. */
  get bufferedBytes(): number {
    return this.buffer.length
  }

  feed(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length)
    merged.set(this.buffer, 0)
    merged.set(chunk, this.buffer.length)
    this.buffer = merged

    const frames: Uint8Array[] = []
    let searchFrom = 0

    for (;;) {
      const start = indexOfHeader(this.buffer, searchFrom)
      if (start === -1) {
        // No header anywhere ahead; keep only what could be a header split across chunks.
        const keep = Math.max(0, this.buffer.length - (RESPONSE_HEADER.length - 1))
        this.buffer = this.buffer.slice(keep)
        return frames
      }
      if (this.buffer.length - start < FRAME_LENGTH) {
        // A header with only a partial frame behind it: keep from the header onward and wait
        // for the rest. This slice is what bounds the buffer — its length is always under one
        // FRAME_LENGTH, so a header that is never completed, or an endless run of
        // header-lookalikes, cannot accumulate across feeds.
        this.buffer = this.buffer.slice(start)
        return frames
      }

      const frame = this.buffer.slice(start, start + FRAME_LENGTH)
      if (isChecksumValid(frame)) {
        frames.push(frame)
        this.buffer = this.buffer.slice(start + FRAME_LENGTH)
        searchFrom = 0
      } else {
        searchFrom = start + 1
      }
    }
  }

  reset(): void {
    this.buffer = new Uint8Array(0)
  }
}
