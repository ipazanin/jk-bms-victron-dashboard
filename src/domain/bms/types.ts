/** Volts, amps, watts, amp-hours, degrees Celsius, ohms. Positive current = charging. */
export interface BatterySnapshot {
  readonly cellVoltages: readonly number[]
  readonly cellResistances: readonly number[]
  readonly averageCellVoltage: number
  readonly cellDelta: number
  readonly highestCell: number
  readonly lowestCell: number
  readonly packVoltage: number
  readonly current: number
  readonly power: number
  readonly stateOfCharge: number
  readonly remainingCapacity: number
  readonly nominalCapacity: number
  readonly cycleCount: number
  readonly cycledCapacity: number
  readonly mosfetTemperature: number
  readonly temperatureSensor1: number
  readonly temperatureSensor2: number
  readonly uptimeSeconds: number
  readonly chargingEnabled: boolean
  readonly dischargingEnabled: boolean
}

export interface DeviceInfo {
  readonly model: string
  readonly hardwareVersion: string
  readonly softwareVersion: string
  readonly serialNumber: string
  readonly uptimeSeconds: number
  readonly powerOnCount: number
}

export interface BmsSettings {
  readonly cellCount: number
  readonly nominalCapacity: number
  readonly cellOverVoltage: number
  readonly cellUnderVoltage: number
  readonly balanceTriggerDelta: number
  readonly startBalanceVoltage: number
  readonly maxBalanceCurrent: number
  readonly chargeOverTemperature: number
  readonly chargeUnderTemperature: number
  readonly mosfetOverTemperature: number
  readonly balancerEnabled: boolean
}
