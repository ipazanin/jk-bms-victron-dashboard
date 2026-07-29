export function volts(reading: number, digits = 3): string {
  return `${reading.toFixed(digits)} V`
}

/**
 * Signed current, with the sign decided AFTER rounding to the displayed precision. A reading
 * that rounds to zero carries no direction, so it is printed unsigned ('0.0 A') rather than as
 * a meaningless '−0.0 A' — the same honesty CellLadder's signedMv applies to millivolts.
 */
export function amps(reading: number, digits = 1): string {
  const rounded = Number(reading.toFixed(digits))
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : ''
  return `${sign}${Math.abs(rounded).toFixed(digits)} A`
}

export function ampsAbsolute(reading: number, digits = 1): string {
  return `${Math.abs(reading).toFixed(digits)} A`
}

export function watts(reading: number): string {
  return `${Math.round(Math.abs(reading))} W`
}

/**
 * Signed power, with the sign decided AFTER rounding to whole watts — the same honesty `amps`
 * applies to current, so a reading that rounds to zero is printed without a direction it does
 * not have. Every pack figure on the dashboard is signed; solar and boat are magnitudes.
 */
export function wattsSigned(reading: number): string {
  const rounded = Math.round(reading)
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : ''
  return `${sign}${Math.abs(rounded)} W`
}

export function millivolts(reading: number): string {
  return `${Math.round(reading * 1000)} mV`
}

export function milliohms(reading: number): string {
  return `${Math.round(reading * 1000)} mΩ`
}

export function celsius(reading: number, digits = 1): string {
  return `${reading.toFixed(digits)} °C`
}

export function ampHours(reading: number, digits = 1): string {
  return `${reading.toFixed(digits)} Ah`
}

/** The sign is decided after rounding, so a figure that rounds to zero carries no direction. */
export function ampHoursSigned(reading: number, digits = 1): string {
  const rounded = Number(reading.toFixed(digits))
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : ''
  return `${sign}${Math.abs(rounded).toFixed(digits)} Ah`
}

export function kilowattHours(reading: number): string {
  return `${reading.toFixed(2)} kWh`
}

/**
 * Energy left in the pack, at two significant figures.
 *
 * It is an estimate — a coulomb count valued at a nominal voltage — and good to a few percent of
 * the bank at best. Printing '2 614 Wh' would claim three digits the estimate cannot carry, so the
 * figure is deliberately coarse: tens of watt-hours under a kilowatt-hour, tenths of one above it.
 */
export function storedWattHours(wattHours: number): string {
  // Rounded first, then read: 996 Wh would otherwise print as a four-digit '1000 Wh'.
  const tens = Math.round(wattHours / 10) * 10
  if (tens >= 1000) return `${(wattHours / 1000).toFixed(1)} kWh`
  return `${tens} Wh`
}

export function duration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function hours(elapsedHours: number): string {
  if (elapsedHours < 1) return `${Math.round(elapsedHours * 60)} min`
  return `${elapsedHours.toFixed(1)} h`
}

export function clockTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function clockTimeWithSeconds(timestamp: number): string {
  return `${clockTime(timestamp)}:${String(new Date(timestamp).getSeconds()).padStart(2, '0')}`
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

/** Non-breaking spaces, so a count never wraps across the gap between its own digits. */
export function groupedCount(count: number): string {
  return String(Math.round(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
