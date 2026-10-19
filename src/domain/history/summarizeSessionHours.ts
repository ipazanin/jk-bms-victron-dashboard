import { MAX_PAIRING_AGE_MS, pairSamples } from './join'
import type { SessionHour } from './SessionHour'
import { SessionHourAccumulator } from './SessionHourAccumulator'
import type { PackSample, SessionId, SolarSample } from './types'

export function summarizeSessionHours(
  sessionId: SessionId,
  pack: readonly PackSample[],
  solar: readonly SolarSample[],
): readonly SessionHour[] {
  const accumulator = new SessionHourAccumulator(sessionId, 'reconstructed')
  const orderedPack = [...pack].sort((earlier, later) => earlier.at - later.at)
  const orderedSolar = [...solar].sort((earlier, later) => earlier.at - later.at)
  for (const sample of pairSamples(orderedPack, orderedSolar, MAX_PAIRING_AGE_MS)) accumulator.push(sample)
  return accumulator.updatedHours()
}
