export const SESSION_HOUR_METRICS = [
  'packCurrentA',
  'solarCurrentA',
  'houseCurrentA',
  'housePowerW',
  'stateOfCharge',
  'cellDeltaV',
  'mosfetTemperatureC',
  'packVoltageV',
  'pvPowerW',
] as const

export type SessionHourMetric = (typeof SESSION_HOUR_METRICS)[number]
