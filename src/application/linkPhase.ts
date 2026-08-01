import type { LinkState } from './telemetry'

/**
 * What a radio is doing, as the instruments need to say it. `LinkState` alone cannot express the
 * gap that matters most: 'live' is set when the GATT connect resolves, which is one to several
 * seconds before the first cell frame arrives.
 */
export type LinkPhase = 'absent' | 'connecting' | 'listening' | 'waiting' | 'reading'

/** A reading in hand outranks the link state: a remembered or browsed snapshot arrives with both radios idle. */
export function linkPhase(state: LinkState, hasReading: boolean): LinkPhase {
  if (hasReading) return 'reading'
  if (state === 'connecting') return 'connecting'
  if (state === 'listening') return 'listening'
  if (state === 'live') return 'waiting'
  return 'absent'
}

/** Committed to a radio, with nothing to show for it yet — the window the page used to spend silent. */
export function isPending(phase: LinkPhase): boolean {
  return phase === 'connecting' || phase === 'listening' || phase === 'waiting'
}
