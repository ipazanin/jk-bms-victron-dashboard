/**
 * The committed playback fixtures, held to what the fake and the archive assume of them.
 *
 * These three files are generated from gitignored boat captures, so nobody reviewing a change can
 * re-derive them and the generator is not on anyone's path. That makes them the one kind of test
 * data that can rot silently: a regeneration that quietly drops a field, renames a unit or lets a
 * device identity through would leave the fake running and the specs green. So this spec asserts
 * the properties the rest of the system takes on trust rather than any particular number.
 *
 * The identity checks are written so that no real serial has to be spelled here either. A serial is
 * a long run of upper-case letters and digits, and a stored payload is binary — so a serial-shaped
 * token in the text, or any run of readable text inside a payload, is the leak, whatever the device
 * happened to be called. The generator has the captured serial in hand and refuses to write a file
 * containing it; this is the half of that guard which survives into a repository with no captures.
 *
 * Every assertion runs through the production decoders, so an offset or a scale that moves in
 * `src/domain` moves this spec with it instead of leaving the fixture asserting against itself.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { BUNDLE_MARKER } from '../scripts/support/fakeMarker.mjs'
import {
  detailLogOutcome,
  readDetailLogHeader,
  readDetailLogRecordBytes,
} from '../src/domain/bms/detailLog'
import { logbookLabel } from '../src/domain/bms/logbook'
import { hexToBytes } from '../src/domain/bytes'
import { packDeviceKeyFor } from '../src/domain/history/identity'
import { decodeSolarHistoryDay, decodeSolarHistoryTotals } from '../src/domain/solar/history'
import { HISTORY_DAY_REGISTERS, MAX_HISTORY_DAYS } from '../src/domain/solar/SolarHistoryRegister'
import type { PackRingWireFixture } from '../src/infrastructure/ble/fake/fixture/PackRingWireFixture'
import type { SolarHistoryWireFixture } from '../src/infrastructure/ble/fake/fixture/SolarHistoryWireFixture'
import { loadPlaybackFixture } from '../src/infrastructure/ble/fake/fixture/loadPlaybackFixture'
import packRingWire from '../src/infrastructure/ble/fake/fixture/packRingWire.json'
import solarHistoryWire from '../src/infrastructure/ble/fake/fixture/solarHistoryWire.json'

/** The annotations are the assertion: a generated file that drifts off its record type fails here. */
const packRing: PackRingWireFixture = packRingWire
const solarHistory: SolarHistoryWireFixture = solarHistoryWire
const playback = await loadPlaybackFixture()

const DEMO_SERIAL = 'DEMO00000000001'
const PACK_MODEL = 'JK_B2A8S20P'

/** Long enough that a word cannot reach it by accident, short enough to catch every serial shape. */
const SERIAL_SHAPED = /[A-Z0-9]{8,}/g
/** A stored payload is binary. The only thing in one that would read as text is an identity. */
const READABLE_TEXT = /[\x20-\x7e]{6,}/

/**
 * The earlier read caught the ring full. The later one stops short because the pack stopped
 * continuing that burst after record 808 — which is the whole reason the pair is worth keeping: the
 * ring moved under the reader between the two, and a fold that survives these two survives a real
 * shift rather than an arithmetic one.
 */
const RECORDS_IN_EARLIER_READ = 836
const RECORDS_IN_LATER_READ = 809
const RING_RECORD_BYTES = 24

/**
 * The pack reports power as a filtered figure that trails its own current reading, so the two
 * disagree while the current is moving and agree to the milliwatt once it settles — measured over
 * these captures, the gap never exceeds the largest one-frame change in the product itself. The
 * allowance covers the two decimal places the fixture rounds power to and the frames where the
 * register holds still for more than one sample. What this catches is a scale slip, which is three
 * orders of magnitude out, not the hardware's own filtering.
 */
const TRAILING_POWER_ALLOWANCE_W = 1

/** Rounding to three decimals leaves the difference of two of them a few ulps away from exact. */
const ROUNDING_SLACK_V = 1e-9

function fixtureText(name: string): string {
  return readFileSync(new URL(`../src/infrastructure/ble/fake/fixture/${name}`, import.meta.url), 'utf8')
}

/** The text with everything a fixture is allowed to name struck out, so what remains is a leak. */
function serialShapedTokensIn(text: string): readonly string[] {
  const remaining = [DEMO_SERIAL, PACK_MODEL].reduce((carried, allowed) => carried.split(allowed).join(' '), text)
  return [...new Set(remaining.match(SERIAL_SHAPED) ?? [])].filter((token) => /[A-Z]/.test(token))
}

function readableTextIn(payload: string): string | null {
  const characters = String.fromCharCode(...hexToBytes(payload))
  return READABLE_TEXT.exec(characters)?.[0] ?? null
}

function recordIndexesOf(read: PackRingWireFixture['earlier']): readonly number[] {
  return read.frames.flatMap((frame) => readDetailLogRecordBytes(hexToBytes(frame)).map((record) => record.index))
}

describe('the fixtures carry no device identity', () => {
  for (const name of ['playbackFixture.json', 'packRingWire.json', 'solarHistoryWire.json']) {
    it(`leaves nothing serial-shaped in ${name}`, () => {
      expect(serialShapedTokensIn(fixtureText(name))).toEqual([])
    })
  }

  it('names the pack by the demo serial, which is what gives it an archive key at all', () => {
    expect(playback.device.serialNumber).toBe(DEMO_SERIAL)
    expect(playback.device.model).toBe(PACK_MODEL)
    expect(packDeviceKeyFor(playback.device, null)).toBe(packRing.deviceKey)
  })

  it('holds no readable text in any stored-log frame or history payload', () => {
    const payloads = [
      ...packRing.earlier.frames,
      ...packRing.later.frames,
      solarHistory.totals,
      ...solarHistory.days.map((day) => day.bytes),
    ]
    expect(payloads.map(readableTextIn).filter((text) => text !== null)).toEqual([])
  })

  it('carries the marker the build greps a bundle for, spelled as the grep spells it', () => {
    expect(playback.marker).toBe(BUNDLE_MARKER)
  })
})

describe('the playback streams', () => {
  it('offers the two captured conditions', () => {
    expect(playback.scenarios.map((scenario) => scenario.name)).toEqual(['float', 'discharge'])
  })

  it('labels every logbook event the way the decoder would', () => {
    expect(playback.logbook.length).toBeGreaterThan(0)
    const mislabelled = playback.logbook.filter((event) => event.label !== logbookLabel(event.code))
    expect(mislabelled).toEqual([])
  })

  for (const scenario of playback.scenarios) {
    describe(scenario.name, () => {
      it('runs both radios forward on one time base, starting where the first of them spoke', () => {
        const stalled = [
          ...scenario.pack.filter((frame, index) => index > 0 && frame.atMs <= scenario.pack[index - 1].atMs),
          ...scenario.solar.filter((frame, index) => index > 0 && frame.atMs <= scenario.solar[index - 1].atMs),
        ]

        expect(stalled).toEqual([])
        expect(Math.min(scenario.pack[0].atMs, scenario.solar[0].atMs)).toBe(0)
      })

      it('spans as far as its last frame, so a loop rebases onto the whole capture', () => {
        const last = Math.max(scenario.pack[scenario.pack.length - 1].atMs, scenario.solar[scenario.solar.length - 1].atMs)
        expect(scenario.spanMs).toBe(last)
      })

      it('keeps a resistance for every cell voltage', () => {
        const mismatched = scenario.pack.filter(
          ({ battery }) => battery.cellVoltages.length !== battery.cellResistances.length,
        )
        expect(mismatched).toEqual([])
      })

      it('points its highest and lowest cell at the right cell, counting from one', () => {
        const wrong = scenario.pack.filter(({ battery }) => {
          const voltages = battery.cellVoltages
          return (
            voltages[battery.highestCell - 1] !== Math.max(...voltages) ||
            voltages[battery.lowestCell - 1] !== Math.min(...voltages)
          )
        })
        expect(wrong).toEqual([])
      })

      it('reports a cell delta that is the spread of its own ladder, in volts', () => {
        const inconsistent = scenario.pack.filter(({ battery }) => {
          const spread = Math.max(...battery.cellVoltages) - Math.min(...battery.cellVoltages)
          return Math.abs(battery.cellDelta - spread) > ROUNDING_SLACK_V
        })
        expect(inconsistent).toEqual([])
      })

      it('reports power as an unsigned magnitude that tracks voltage times current', () => {
        const products = scenario.pack.map(({ battery }) => Math.abs(battery.packVoltage * battery.current))
        const biggestStep = products.reduce(
          (widest, product, index) => (index === 0 ? widest : Math.max(widest, Math.abs(product - products[index - 1]))),
          0,
        )

        const adrift = scenario.pack.filter(
          ({ battery }, index) =>
            battery.power < 0 ||
            Math.abs(battery.power - products[index]) > biggestStep + TRAILING_POWER_ALLOWANCE_W,
        )
        expect(adrift).toEqual([])
      })
    })
  }
})

describe("the pack's stored log, as the two reads came off the wire", () => {
  for (const [name, expectedRecords] of [
    ['earlier', RECORDS_IN_EARLIER_READ],
    ['later', RECORDS_IN_LATER_READ],
  ] as const) {
    describe(`the ${name} read`, () => {
      const read = packRing[name]

      it('covers a contiguous stretch of the ring from its oldest record, with no hole', () => {
        const indexes = recordIndexesOf(read)

        expect(indexes).toHaveLength(expectedRecords)
        expect(indexes).toEqual([...Array(expectedRecords).keys()])
      })

      it('pages by exactly what each frame says it carries', () => {
        let expectedIndex = 0
        for (const frame of read.frames) {
          const header = readDetailLogHeader(hexToBytes(frame))
          expect(header.firstRecordIndex).toBe(expectedIndex)
          expectedIndex += header.recordCount
        }
        expect(expectedIndex).toBe(expectedRecords)
      })

      it('splits into records that own their bytes rather than viewing the frame', () => {
        const records = readDetailLogRecordBytes(hexToBytes(read.frames[0]))
        for (const record of records) {
          expect(record.bytes).toHaveLength(RING_RECORD_BYTES)
          expect(record.bytes.buffer.byteLength).toBe(RING_RECORD_BYTES)
        }
      })

      it('reads as a burst the pack answered in full', () => {
        const frames = read.frames.map(hexToBytes)
        const outcome = detailLogOutcome({
          notificationBytes: frames.reduce((total, frame) => total + frame.length, 0),
          assembledFrameCount: frames.length,
          storedLogFrameCount: frames.length,
        })
        expect(outcome).toBe('records-read')
      })
    })
  }

  it('holds the ring full in the earlier read and shifted in the later one', () => {
    expect(packRing.earlier.observedAt).toBeLessThan(packRing.later.observedAt)
    expect(recordIndexesOf(packRing.later).length).toBeLessThan(recordIndexesOf(packRing.earlier).length)
  })

  it('names the zone the pack clock runs on, without which a record has no date', () => {
    expect(packRing.packUtcOffsetMinutes).toBe(60)
  })
})

describe("the controller's stored history, as the sweep came off the wire", () => {
  it('answers the totals register', () => {
    const totals = decodeSolarHistoryTotals(hexToBytes(solarHistory.totals))
    expect(totals.daysAvailable).toBeGreaterThan(0)
    expect(totals.systemYieldKwh).toBeGreaterThan(0)
  })

  it('runs newest first, one register per day of age', () => {
    expect(solarHistory.days).toHaveLength(MAX_HISTORY_DAYS)
    expect(solarHistory.days.map((day) => day.register)).toEqual([...HISTORY_DAY_REGISTERS])
  })

  it('steps its day sequence down by exactly one as the days get older', () => {
    const sequences = solarHistory.days.map((day) => {
      const record = decodeSolarHistoryDay(hexToBytes(day.bytes))
      if (!record.recorded) throw new Error(`register 0x${day.register.toString(16)} was never written`)
      return record.daySequenceNumber
    })

    const outOfStep = sequences.filter((sequence, index) => index > 0 && sequence !== sequences[index - 1] - 1)
    expect(outOfStep).toEqual([])
  })
})
