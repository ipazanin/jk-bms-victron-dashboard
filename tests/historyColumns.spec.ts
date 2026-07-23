import { describe, expect, it } from 'vitest'

import {
  CHARGE_STATE_UNNAMED,
  PACK_SAMPLE_BYTES,
  PackChunkBuilder,
  SOLAR_SAMPLE_BYTES,
  SolarChunkBuilder,
  chargeStateOf,
  decodePackChunk,
  decodeSolarChunk,
  isReadableLayout,
  sampleBytes,
} from '../src/domain/history/columns'
import {
  CHUNK_CAPACITY,
  CHUNK_LAYOUT_VERSION,
  MAX_CHUNK_SPAN_MS,
  PACK_STREAM,
  SOLAR_STREAM,
} from '../src/domain/history/types'
import type { HistoryChunk, PackSample, SolarSample } from '../src/domain/history/types'
import { NOT_AVAILABLE_I16, NOT_AVAILABLE_U16, NOT_AVAILABLE_U9 } from '../src/domain/solar/types'
import { SAMPLE_EPOCH, packSample, packSamples, solarSample, solarSamples } from './support/samples'

// Everything here is about one claim: a sample that goes into a chunk comes back out unchanged.
// The columns sit at the integer scales the two radios transmit, so "unchanged" means exactly
// equal and not close — a spec that accepted 3.3939999 for 3.394 would let a rescaled column
// through, and every recording written afterwards would carry the error.

type Column =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array

/** The typed-array columns of a chunk, whatever they are called. */
function columnsOf(chunk: HistoryChunk): [string, Column][] {
  return Object.entries(chunk).filter((entry): entry is [string, Column] =>
    // Every column carries its own element width, which is the whole reason a row's byte cost is
    // a constant. A DataView would pass ArrayBuffer.isView and carry no width.
    ArrayBuffer.isView(entry[1]) && 'BYTES_PER_ELEMENT' in entry[1],
  )
}

function packChunkOf(samples: readonly PackSample[]): ReturnType<PackChunkBuilder['seal']> {
  const builder = new PackChunkBuilder({
    sessionId: 'session',
    seq: 0,
    baseAt: samples[0].at,
    baseMonotonic: 0,
  })
  for (const sample of samples) builder.append(sample, sample.at - samples[0].at)
  return builder.seal()
}

function solarChunkOf(samples: readonly SolarSample[]): ReturnType<SolarChunkBuilder['seal']> {
  const builder = new SolarChunkBuilder({
    sessionId: 'session',
    seq: 0,
    baseAt: samples[0].at,
    baseMonotonic: 0,
  })
  for (const sample of samples) builder.append(sample, sample.at - samples[0].at)
  return builder.seal()
}

describe('the pack columns', () => {
  it('returns every field exactly as it went in', () => {
    // Each value sits on its column's own wire scale, which is where every value a radio produced
    // sits too: the BMS sends milliamps, millivolts and tenths of a degree as integers.
    const original = packSample({
      currentA: -8.437,
      packVoltageV: 13.394,
      stateOfCharge: 61,
      remainingCapacityAh: 192.408,
      cellDeltaV: 0.017,
      highestCell: 2,
      lowestCell: 4,
      mosfetTemperatureC: 29.7,
      temperatureSensor1C: -3.4,
      temperatureSensor2C: 27.2,
      chargingEnabled: true,
      dischargingEnabled: false,
    })

    expect(decodePackChunk(packChunkOf([original]))[0]).toEqual(original)
  })

  it('keeps millivolt precision rather than landing a hair below it', () => {
    const [decoded] = decodePackChunk(packChunkOf([packSample({ packVoltageV: 3.394 })]))
    expect(decoded.packVoltageV).toBe(3.394)
  })

  it('carries the two switch bits independently', () => {
    const combinations = [
      { chargingEnabled: false, dischargingEnabled: false },
      { chargingEnabled: true, dischargingEnabled: false },
      { chargingEnabled: false, dischargingEnabled: true },
      { chargingEnabled: true, dischargingEnabled: true },
    ]
    const decoded = decodePackChunk(
      packChunkOf(
        combinations.map((switches, index) =>
          packSample({ at: SAMPLE_EPOCH + index * 1_000, ...switches }),
        ),
      ),
    )

    decoded.forEach((sample, index) => {
      expect(sample.chargingEnabled).toBe(combinations[index].chargingEnabled)
      expect(sample.dischargingEnabled).toBe(combinations[index].dischargingEnabled)
    })
  })

  it('stamps each row against the base rather than against the wall clock', () => {
    const decoded = decodePackChunk(packChunkOf(packSamples(4)))
    expect(decoded.map((sample) => sample.at)).toEqual([
      SAMPLE_EPOCH,
      SAMPLE_EPOCH + 1_000,
      SAMPLE_EPOCH + 2_000,
      SAMPLE_EPOCH + 3_000,
    ])
  })
})

describe('the solar columns', () => {
  it('returns every field exactly as it went in', () => {
    const original = solarSample({
      chargeState: 'absorption',
      chargerError: 2,
      batteryVoltageV: 14.21,
      batteryCurrentA: -0.3,
      yieldTodayKwh: 1.47,
      pvPowerW: 151,
      loadCurrentA: 3.2,
      rssi: -84,
    })

    expect(decodeSolarChunk(solarChunkOf([original]))[0]).toEqual(original)
  })

  it('round-trips absence through the sentinels the controller itself broadcasts', () => {
    // Absence is the controller's own vocabulary, so nothing here invents a NaN: NaN passes the
    // `value !== null` guard every instrument uses and would reach a path `d` as the literal "NaN".
    const absent = solarSample({
      batteryVoltageV: null,
      batteryCurrentA: null,
      yieldTodayKwh: null,
      pvPowerW: null,
      loadCurrentA: null,
    })
    const chunk = solarChunkOf([absent])

    expect(chunk.batteryVoltageCv[0]).toBe(NOT_AVAILABLE_I16)
    expect(chunk.batteryCurrentDa[0]).toBe(NOT_AVAILABLE_I16)
    expect(chunk.yieldTodayHwh[0]).toBe(NOT_AVAILABLE_U16)
    expect(chunk.pvPowerW[0]).toBe(NOT_AVAILABLE_U16)
    expect(chunk.loadCurrentDa[0]).toBe(NOT_AVAILABLE_U9)
    expect(decodeSolarChunk(chunk)[0]).toEqual(absent)
  })

  it('separates a reading at the top of a column from an absent one', () => {
    // One unit below each sentinel is a real reading, and a column that clamped to the sentinel
    // instead would turn the controller's highest legal value into silence.
    const highest = solarSample({
      batteryVoltageV: (NOT_AVAILABLE_I16 - 1) / 100,
      yieldTodayKwh: (NOT_AVAILABLE_U16 - 1) / 100,
      pvPowerW: NOT_AVAILABLE_U16 - 1,
      loadCurrentA: (NOT_AVAILABLE_U9 - 1) / 10,
    })
    const [decoded] = decodeSolarChunk(solarChunkOf([highest]))

    expect(decoded).toEqual(highest)
    expect(decoded.pvPowerW).not.toBeNull()
  })

  it('keeps a state this build has never heard of instead of collapsing it', () => {
    // The raw Victron byte is stored, so firmware that names a new state leaves it on disk intact
    // for a later build to read. Until then it reads as the one state with no vendor code.
    expect(chargeStateOf(9)).toBe('unknown')
    expect(chargeStateOf(CHARGE_STATE_UNNAMED)).toBe('unknown')

    const [decoded] = decodeSolarChunk(solarChunkOf([solarSample({ chargeState: 'unknown' })]))
    expect(decoded.chargeState).toBe('unknown')
  })

  it('carries a negative signal strength', () => {
    const [decoded] = decodeSolarChunk(solarChunkOf([solarSample({ rssi: -101 })]))
    expect(decoded.rssi).toBe(-101)
  })
})

describe('what a sealed chunk costs', () => {
  it('holds exactly as many bytes as it holds rows', () => {
    // The load-bearing assertion of the whole layout. structuredClone copies the entire
    // ArrayBuffer a typed array views, so a `.subarray` of a full-capacity staging buffer would be
    // written to disk at full capacity on every checkpoint — silently, with nothing to show for it
    // but the budget.
    const chunk = packChunkOf(packSamples(7))

    expect(chunk.length).toBe(7)
    for (const [name, column] of columnsOf(chunk)) {
      expect(`${name}: ${column.buffer.byteLength}`).toBe(`${name}: ${chunk.length * column.BYTES_PER_ELEMENT}`)
    }
  })

  it('does the same for a tail, which is rewritten at its key every checkpoint', () => {
    const builder = new SolarChunkBuilder({
      sessionId: 'session',
      seq: 0,
      baseAt: SAMPLE_EPOCH,
      baseMonotonic: 0,
    })
    for (const sample of solarSamples(3)) builder.append(sample, sample.at - SAMPLE_EPOCH)
    const tail = builder.tail()

    expect(tail.sealed).toBe(false)
    for (const [name, column] of columnsOf(tail)) {
      expect(`${name}: ${column.buffer.byteLength}`).toBe(`${name}: ${tail.length * column.BYTES_PER_ELEMENT}`)
    }
  })

  it('bills a row at exactly the width its columns add up to', () => {
    // The budget is counted in rows because byte cost is a function of row count. If a column is
    // added, removed or rescaled without the constant moving with it, the cap silently stops
    // meaning what it says — so the constant is checked against the columns rather than restated.
    const packWidth = columnsOf(packChunkOf(packSamples(1))).reduce(
      (total, [, column]) => total + column.BYTES_PER_ELEMENT,
      0,
    )
    const solarWidth = columnsOf(solarChunkOf(solarSamples(1))).reduce(
      (total, [, column]) => total + column.BYTES_PER_ELEMENT,
      0,
    )

    expect(packWidth).toBe(PACK_SAMPLE_BYTES)
    expect(solarWidth).toBe(SOLAR_SAMPLE_BYTES)
    expect(sampleBytes(PACK_STREAM)).toBe(PACK_SAMPLE_BYTES)
    expect(sampleBytes(SOLAR_STREAM)).toBe(SOLAR_SAMPLE_BYTES)
  })
})

describe('what a chunk refuses', () => {
  it('refuses a row stamped before its own base, so a clock step forces a seal', () => {
    const builder = new PackChunkBuilder({
      sessionId: 'session',
      seq: 0,
      baseAt: SAMPLE_EPOCH,
      baseMonotonic: 5_000,
    })
    expect(builder.append(packSample(), 5_000)).toBe(true)

    // A Uint32 offset cannot carry a negative, and a wrapped one reads back as a row weeks from
    // the chunk holding it.
    expect(builder.accepts(4_999)).toBe(false)
    expect(builder.append(packSample({ at: SAMPLE_EPOCH - 1 }), 4_999)).toBe(false)
    expect(builder.length).toBe(1)
  })

  it('refuses a row past the span bound', () => {
    const builder = new PackChunkBuilder({
      sessionId: 'session',
      seq: 0,
      baseAt: SAMPLE_EPOCH,
      baseMonotonic: 0,
    })
    builder.append(packSample(), 0)

    expect(builder.accepts(MAX_CHUNK_SPAN_MS)).toBe(true)
    expect(builder.accepts(MAX_CHUNK_SPAN_MS + 1)).toBe(false)
  })

  it('refuses a row past capacity, and never claims one it did not write', () => {
    const builder = new PackChunkBuilder({
      sessionId: 'session',
      seq: 0,
      baseAt: SAMPLE_EPOCH,
      baseMonotonic: 0,
    })
    for (let index = 0; index < CHUNK_CAPACITY; index += 1) {
      expect(builder.append(packSample({ at: SAMPLE_EPOCH + index }), index)).toBe(true)
    }

    expect(builder.append(packSample({ at: SAMPLE_EPOCH + CHUNK_CAPACITY }), CHUNK_CAPACITY)).toBe(false)
    expect(builder.seal().length).toBe(CHUNK_CAPACITY)
  })

  it('records what the wall clock did that the monotonic clock did not', () => {
    const builder = new PackChunkBuilder({
      sessionId: 'session',
      seq: 0,
      baseAt: SAMPLE_EPOCH,
      baseMonotonic: 0,
    })
    builder.append(packSample({ at: SAMPLE_EPOCH }), 0)
    // Ten seconds of monotonic time, but the wall clock jumped an hour: NTP stepped underneath.
    builder.append(packSample({ at: SAMPLE_EPOCH + 3_610_000 }), 10_000)

    expect(builder.seal().wallDriftMs).toBe(3_600_000)
  })
})

describe('the layout gate', () => {
  it('reads its own layout and every earlier one', () => {
    expect(isReadableLayout(CHUNK_LAYOUT_VERSION)).toBe(true)
    expect(isReadableLayout(CHUNK_LAYOUT_VERSION - 1)).toBe(true)
  })

  it('refuses a chunk a newer build wrote, which is listed and never deleted', () => {
    expect(isReadableLayout(CHUNK_LAYOUT_VERSION + 1)).toBe(false)
  })
})
