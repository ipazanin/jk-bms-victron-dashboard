export function volts(value: number, digits = 3): string {
  return `${value.toFixed(digits)} V`
}

/**
 * Signed current, with the sign decided AFTER rounding to the displayed precision. A reading
 * that rounds to zero carries no direction, so it is printed unsigned ('0.0 A') rather than as
 * a meaningless '−0.0 A' — the same honesty CellLadder's signedMv applies to millivolts.
 */
export function amps(value: number, digits = 1): string {
  const rounded = Number(value.toFixed(digits))
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : ''
  return `${sign}${Math.abs(rounded).toFixed(digits)} A`
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

/** Coarse, human age of a past moment: 'moments ago', 'N min ago', 'N h ago', 'yesterday', 'N days ago'. */
export function relativeAge(fromMs: number, nowMs: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - fromMs) / 1000))
  if (seconds < 60) return 'moments ago'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}
