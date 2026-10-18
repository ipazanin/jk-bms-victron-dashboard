import { SNAPSHOT_SCHEMA_VERSION } from '../schemaVersion'
import { CHARGE_STATES } from '../solar/types'
import { SOLAR_DAY_FORMAT } from '../history/StoredRowFormat'
import { boolean, bounded, byte, calendarDate, choice, count, fields, finite, identity, list, nullable, optional, record, requireArchive, shape, text, timestamp } from './validation'
import type { ArchiveValidationRule } from './ArchiveValidationRule'

const chargeState = choice(...Object.values(CHARGE_STATES), 'unknown')
const level = choice('good', 'warning', 'serious', 'critical')
const nonnegative = bounded(0, Number.MAX_VALUE)

const batteryFields = shape({
  cellVoltages: list(finite), cellResistances: list(finite),
  ...fields('averageCellVoltage cellDelta packVoltage current power remainingCapacity nominalCapacity cycledCapacity mosfetTemperature temperatureSensor1 temperatureSensor2', finite),
  ...fields('highestCell lowestCell cycleCount uptimeSeconds', count),
  stateOfCharge: bounded(0, 100),
  chargingEnabled: boolean, dischargingEnabled: boolean,
})

export const batterySnapshot: ArchiveValidationRule = (input, path) => {
  batteryFields(input, path)
  const battery = record(input, path)
  const cells = battery.cellVoltages as number[]
  const resistances = battery.cellResistances as number[]
  requireArchive(cells.length <= 32 && resistances.length === cells.length, path, 'invalid battery cell count')
  requireArchive((battery.highestCell as number) <= cells.length && (battery.lowestCell as number) <= cells.length, path, 'cell index exceeds battery cell count')
}

export const solarReading = shape({
  chargeState, chargerError: byte,
  ...fields('batteryVoltage batteryCurrent yieldTodayKwh pvPower loadCurrent', nullable(finite)),
})

export const deviceInfo = shape({
  ...fields('model hardwareVersion softwareVersion serialNumber', text),
  uptimeSeconds: count, powerOnCount: count,
})

export const settings = shape({
  cellCount: bounded(1, 32, true),
  ...fields('nominalCapacity cellOverVoltage cellUnderVoltage balanceTriggerDelta startBalanceVoltage maxBalanceCurrent chargeOverTemperature chargeUnderTemperature mosfetOverTemperature', finite),
  balancerEnabled: boolean,
})

export const sessionRecord = shape({
  id: identity, schema: choice(SNAPSHOT_SCHEMA_VERSION), writerId: identity,
  state: choice('open', 'closed'), startedAt: timestamp, endedAt: nullable(timestamp), heartbeatAt: timestamp,
  endReason: nullable(choice('user-disconnect', 'link-lost', 'stalled', 'device-changed', 'page-away', 'archive-lost', 'abandoned')),
  packDeviceKey: nullable(identity), solarDeviceKey: nullable(identity), groupKey: identity,
  ...fields('packSamples solarSamples sealedSamples packChunks solarChunks droppedChunks', count),
  retainedFrom: nullable(timestamp), continues: nullable(identity),
  coverage: list(shape({ from: timestamp, to: timestamp, kind: choice('both', 'pack-only', 'solar-only', 'foreign', 'none') })),
  ledger: shape({
    ...fields('countedMs foreignMs foreignAhFloor', nonnegative),
    ...fields('packAh solarAh houseWh packAhWholeSession', finite),
    ...fields('stateOfChargeFirst stateOfChargeLast stateOfChargeMin', nullable(bounded(0, 100))),
    ...fields('remainingCapacityFirstAh remainingCapacityLastAh pvPowerPeakW', nullable(finite)),
  }),
  entries: list(shape({ at: timestamp, kind: choice('begin', 'fault', 'cleared', 'gap', 'deepest', 'end'), level: choice('good', 'warning', 'serious', 'critical', 'neutral'), text })),
  finalBattery: nullable(batterySnapshot), finalSolar: nullable(solarReading), deviceInfo: nullable(deviceInfo), settings: nullable(settings),
})

export const deviceRecord = shape({
  key: identity, kind: choice('pack', 'solar'), defaultLabel: text,
  ...fields('userLabel model serialNumber hardwareVersion softwareVersion', nullable(text)),
  firstSeenAt: timestamp, lastSeenAt: timestamp, sessionCount: count,
  packUtcOffsetMinutes: optional(nullable(bounded(-14 * 60, 14 * 60, true))),
  packClockAheadSeconds: optional(nullable(finite)),
})

export const historyMeta = shape({
  key: choice('totals'), totalSamples: count, schema: choice(SNAPSHOT_SCHEMA_VERSION),
  createdAt: timestamp, lastPrunedAt: nullable(timestamp),
})

export const warningRecord = shape({
  sessionId: identity, seq: count, at: timestamp, level: choice('warning', 'serious', 'critical'), title: text, detail: text,
  snapshot: shape({
    ...fields('packCurrentA packVoltageV stateOfCharge cellDeltaMv highestCell lowestCell mosfetTemperatureC temperature1C temperature2C pvPowerW solarBatteryCurrentA housePowerW houseCurrentA', nullable(finite)),
    ...fields('chargingEnabled dischargingEnabled houseLoadPlausible', nullable(boolean)),
    solarChargeState: nullable(chargeState),
  }),
})

const chargerErrors: ArchiveValidationRule = (input, path) => {
  list(byte)(input, path)
  requireArchive((input as unknown[]).length === 4, path, 'expected four charger errors')
}

export const ringRecord = shape({
  deviceKey: identity, format: choice(undefined), seq: count,
  packClockSeconds: bounded(0, 0xffffffff, true), firstReadAt: timestamp, followsGap: boolean,
  bytes: (input, path) => requireArchive(input instanceof Uint8Array && input.length === 24, path, 'expected 24 ring bytes'),
})

export const solarDay = shape({
  deviceKey: identity, format: choice(SOLAR_DAY_FORMAT), seq: count,
  date: calendarDate, firstReadAt: timestamp, revisedAt: timestamp,
  day: shape({
    recorded: choice(true), daySequenceNumber: bounded(0, 65535, true),
    ...fields('yieldKwh maxBatteryVoltage minBatteryVoltage maxPvPower maxBatteryCurrent maxPvVoltage', nonnegative),
    consumedKwh: nullable(nonnegative), errorDatabase: bounded(0, 0xffffffff, true), errors: chargerErrors,
    ...fields('minutesInBulk minutesInAbsorption minutesInFloat', bounded(0, 65535, true)),
  }),
})

export const ringRead = shape({
  deviceKey: identity, format: choice(undefined), observedAt: timestamp,
  outcome: choice('no-answer', 'torn-burst', 'other-frames', 'records-read'),
  ...fields('notificationBytes notificationCount assembledFrameCount logFrameCount recordsReceived recordsAppended overlap runsDiscarded', count),
  indexSpan: nullable(shape({ from: count, to: count })),
  ringShift: nullable(bounded(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true)),
  gapDeclared: boolean, newestSampleCounter: nullable(bounded(0, 0xffffffff, true)), newestSampleSeq: nullable(count), elapsedMs: nonnegative,
})

export const solarRead = shape({
  deviceKey: identity, format: choice(SOLAR_DAY_FORMAT), observedAt: timestamp,
  outcome: choice('no-answer', 'torn-stream', 'stalled', 'refused', 'empty-history', 'days-read'),
  readOnDate: calendarDate,
  totals: nullable(shape({
    errorDatabase: bounded(0, 0xffffffff, true), errors: chargerErrors,
    ...fields('resettableYieldKwh systemYieldKwh maxPvVoltage maxBatteryVoltage', nonnegative),
    daysAvailable: count, minBatteryVoltage: nullable(nonnegative),
  })),
  ...fields('daysReceived daysAppended daysRevised daysUnchanged daysUnwritten daysRedated notificationBytes notificationCount controlNotificationCount pduCount unreadableReplyCount', count),
  refusedRegisters: list(bounded(0, 65535, true)), elapsedMs: nonnegative,
})

export const rememberedSession: ArchiveValidationRule = (input, path) => {
  shape({
    version: choice(SNAPSHOT_SCHEMA_VERSION), capturedAt: timestamp,
    battery: nullable(batterySnapshot), solar: nullable(solarReading), device: nullable(deviceInfo), settings: nullable(settings),
    solarRssi: finite, status: shape({ worst: level, headline: text }),
    bmsDeviceId: optional(nullable(text)),
    history: optional(list(shape({ at: timestamp, packCurrent: finite, packVoltage: finite, pvPower: nullable(finite), housePower: nullable(finite) }))),
  })(input, path)
  const session = record(input, path)
  requireArchive((session.capturedAt as number) > 0, `${path}.capturedAt`, 'snapshot time must be positive')
  requireArchive(session.battery !== null || session.solar !== null, path, 'snapshot needs an observed radio')
  if (session.history !== undefined) {
    const history = session.history as { at: number }[]
    requireArchive(history.length <= 601 && history.every((point, index) => point.at > (history[index - 1]?.at ?? 0)), `${path}.history`, 'invalid trend order or length')
  }
}
