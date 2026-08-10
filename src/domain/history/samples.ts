/**
 * A radio's reading in the shape the archive files it under.
 *
 * Both mappings are renames across a unit boundary: the radios report in their own words, the stored
 * columns spell the unit into the field name, and nothing in either type says the two agree. So
 * there is one transcription and every writer of stored rows shares it. A column added to a sample,
 * or a unit moved, then fails to compile at every site that files one.
 */

import type { BatterySnapshot } from '../bms/types'
import type { SolarReading } from '../solar/types'
import type { PackSample, SolarSample } from './types'

export function packSampleOf(snapshot: BatterySnapshot, at: number): PackSample {
  return {
    at,
    currentA: snapshot.current,
    packVoltageV: snapshot.packVoltage,
    stateOfCharge: snapshot.stateOfCharge,
    remainingCapacityAh: snapshot.remainingCapacity,
    cellDeltaV: snapshot.cellDelta,
    highestCell: snapshot.highestCell,
    lowestCell: snapshot.lowestCell,
    mosfetTemperatureC: snapshot.mosfetTemperature,
    temperatureSensor1C: snapshot.temperatureSensor1,
    temperatureSensor2C: snapshot.temperatureSensor2,
    chargingEnabled: snapshot.chargingEnabled,
    dischargingEnabled: snapshot.dischargingEnabled,
  }
}

/** The signal strength is the receiver's own measurement, so it arrives beside the reading. */
export function solarSampleOf(reading: SolarReading, rssi: number, at: number): SolarSample {
  return {
    at,
    chargeState: reading.chargeState,
    chargerError: reading.chargerError,
    batteryVoltageV: reading.batteryVoltage,
    batteryCurrentA: reading.batteryCurrent,
    yieldTodayKwh: reading.yieldTodayKwh,
    pvPowerW: reading.pvPower,
    loadCurrentA: reading.loadCurrent,
    rssi,
  }
}
