import { describe, expect, it } from 'vitest'

import { decodeLogbook, logbookLabel } from '../src/domain/bms/logbook'
import realFrame from './fixtures/logbookFrame.json'

/** A 300-byte logbook frame carrying `events`, built the way the device lays one out. */
function logbookFrame(events: ReadonlyArray<readonly [number, number]>, count = events.length): Uint8Array {
  const frame = new Uint8Array(300)
  frame.set([0x55, 0xaa, 0xeb, 0x90], 0)
  frame[4] = 0x05
  frame[5] = 0xd5
  const view = new DataView(frame.buffer)
  view.setUint32(6, count, true)
  events.forEach(([secondsSinceBoot, code], index) => {
    const base = 11 + index * 5
    view.setUint32(base, secondsSinceBoot, true)
    frame[base + 4] = code
  })
  return frame
}

describe('decodeLogbook', () => {
  it('reads each record as seconds-since-boot and a labelled event code', () => {
    const events = decodeLogbook(logbookFrame([
      [0, 0x01],
      [1023, 0x44],
      [7536, 0x2d],
    ]))

    expect(events).toEqual([
      { secondsSinceBoot: 0, code: 0x01, label: 'Boot' },
      { secondsSinceBoot: 1023, code: 0x44, label: 'Discharge overcurrent protection III' },
      { secondsSinceBoot: 7536, code: 0x2d, label: 'Turned off by button' },
    ])
  })

  it('names per-cell protections from their code ranges', () => {
    const events = decodeLogbook(logbookFrame([
      [100, 0x64],
      [200, 0x67],
      [300, 0xc8],
    ]))

    expect(events.map((event) => event.label)).toEqual([
      'Cell 1 overcharge protection',
      'Cell 4 overcharge protection',
      'Cell 1 overdischarge protection',
    ])
  })

  it('shows a raw hex label for a code it does not know', () => {
    expect(logbookLabel(0x7e)).toBe('Cell 27 overcharge protection')
    expect(logbookLabel(0x03)).toBe('Event 0x03')
  })

  it('honours the record count and skips the empty tail', () => {
    // Two real records, then padding the count does not claim.
    const frame = logbookFrame([[10, 0x01], [20, 0x02]], 2)
    expect(decodeLogbook(frame)).toHaveLength(2)
  })

  it('caps a runaway count at the device maximum rather than walking off the frame', () => {
    // 55 records fit a 300-byte frame; the declared count lies about far more.
    const events = Array.from({ length: 55 }, (_, index) => [index * 10 + 1, 0x01] as const)
    const frame = logbookFrame(events, 9999)

    expect(decodeLogbook(frame)).toHaveLength(50)
  })

  it('drops a wholly empty record but keeps a boot at second zero', () => {
    // (0, Boot) is real; (0, 0) is padding a miscount let through.
    const frame = logbookFrame([[0, 0x01], [0, 0x00]], 2)
    expect(decodeLogbook(frame)).toEqual([{ secondsSinceBoot: 0, code: 0x01, label: 'Boot' }])
  })
})

describe('a real captured logbook frame', () => {
  const frame = Uint8Array.from((realFrame.hex.match(/../g) ?? []).map((byte) => parseInt(byte, 16)))

  it('decodes 28 chronological events beginning with a boot at second zero', () => {
    const events = decodeLogbook(frame)

    expect(events).toHaveLength(28)
    expect(events[0]).toEqual({ secondsSinceBoot: 0, code: 0x01, label: 'Boot' })
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index].secondsSinceBoot).toBeGreaterThanOrEqual(events[index - 1].secondsSinceBoot)
    }
  })

  it('counts one boot per power-on the device reported (4)', () => {
    const boots = decodeLogbook(frame).filter((event) => event.code === 0x01)
    expect(boots).toHaveLength(4)
  })
})
