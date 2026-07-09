export function volts(value: number, digits = 3): string {
  return `${value.toFixed(digits)} V`
}

export function amps(value: number, digits = 1): string {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)} A`
}

export function ampsAbsolute(value: number, digits = 1): string {
  return `${Math.abs(value).toFixed(digits)} A`
}

export function watts(value: number): string {
  return `${Math.round(Math.abs(value))} W`
}

export function millivolts(value: number): string {
  return `${Math.round(value * 1000)} mV`
}

export function milliohms(value: number): string {
  return `${Math.round(value * 1000)} mΩ`
}

export function celsius(value: number, digits = 1): string {
  return `${value.toFixed(digits)} °C`
}

export function ampHours(value: number, digits = 1): string {
  return `${value.toFixed(digits)} Ah`
}

export function kilowattHours(value: number): string {
  return `${value.toFixed(2)} kWh`
}

export function duration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function hours(value: number): string {
  if (value < 1) return `${Math.round(value * 60)} min`
  return `${value.toFixed(1)} h`
}

export function clockTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function chargeStateLabel(state: string): string {
  return state.charAt(0).toUpperCase() + state.slice(1)
}
