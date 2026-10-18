import { CHUNK_CAPACITY, CHUNK_LAYOUT_VERSION, MAX_CHUNK_SPAN_MS } from '../history/types'
import type { HistoryChunk } from '../history/types'
import { boolean, bounded, choice, count, finite, identity, record, requireArchive, shape, timestamp } from './validation'
import type { ArchiveValidationRule } from './ArchiveValidationRule'

const packColumns = {
  offsetMs: Uint32Array, currentMa: Int32Array, packVoltageMv: Uint32Array,
  remainingCapacityMah: Uint32Array, cellDeltaMv: Uint16Array, mosfetDeciC: Int16Array,
  temperature1DeciC: Int16Array, temperature2DeciC: Int16Array, stateOfCharge: Uint8Array,
  highestCell: Uint8Array, lowestCell: Uint8Array, switches: Uint8Array,
}
const solarColumns = {
  offsetMs: Uint32Array, batteryVoltageCv: Int16Array, batteryCurrentDa: Int16Array,
  yieldTodayHwh: Uint16Array, pvPowerW: Uint16Array, loadCurrentDa: Uint16Array,
  chargeStateCode: Uint8Array, chargerError: Uint8Array, rssiDbm: Int8Array,
}

export const historyChunk: ArchiveValidationRule = (input, path) => {
  shape({
    sessionId: identity, stream: choice('pack', 'solar'), seq: count, layout: choice(CHUNK_LAYOUT_VERSION),
    baseAt: timestamp, baseMonotonic: bounded(0, Number.MAX_VALUE), wallDriftMs: finite,
    length: bounded(1, CHUNK_CAPACITY, true), sealed: boolean,
  })(input, path)
  const row = record(input, path)
  const columns = row.stream === 'pack' ? packColumns : solarColumns
  for (const [name, constructor] of Object.entries(columns)) {
    const column = row[name]
    requireArchive(column instanceof constructor && (column as Uint8Array).length === row.length, `${path}.${name}`, 'wrong typed array or row count')
  }
  const chunk = input as HistoryChunk
  requireArchive(chunk.offsetMs[0] === 0, `${path}.offsetMs`, 'first offset must be zero')
  for (let index = 1; index < chunk.length; index += 1) {
    requireArchive(chunk.offsetMs[index]! > chunk.offsetMs[index - 1]!, `${path}.offsetMs`, 'offsets must increase')
  }
  requireArchive(chunk.offsetMs[chunk.length - 1]! <= MAX_CHUNK_SPAN_MS, `${path}.offsetMs`, 'chunk exceeds maximum span')
  if (chunk.stream === 'pack') {
    requireArchive(chunk.stateOfCharge.every((percent) => percent <= 100), `${path}.stateOfCharge`, 'percentage exceeds 100')
    requireArchive(chunk.highestCell.every((cell) => cell <= 32) && chunk.lowestCell.every((cell) => cell <= 32), path, 'cell index exceeds 32')
    requireArchive(chunk.switches.every((flags) => flags <= 3), `${path}.switches`, 'invalid switch flags')
  }
}
