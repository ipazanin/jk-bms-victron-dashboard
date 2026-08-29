import type { SolarAdvertisementRejection } from './SolarAdvertisementRejection'
import type { SolarReading } from './types'

/**
 * What one manufacturer payload came to: the controller's reading, or the reason it was not one.
 *
 * A result rather than a nullable reading, because the reason is the part the owner acts on. Every
 * transport hands the rejection straight up to whoever is drawing the panel, so the sentence on
 * screen is the one that names the control that fixes it.
 */
export type SolarAdvertisementOutcome =
  | { readonly decoded: true; readonly reading: SolarReading }
  | { readonly decoded: false; readonly rejection: SolarAdvertisementRejection }
