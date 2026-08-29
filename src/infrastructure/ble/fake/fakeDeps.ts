/**
 * Where the fake is handed to the app, and the one place it is built.
 *
 * The controller is created on the first call and never at import time. That is load-bearing rather
 * than a lifecycle preference — `scripts/assert-no-fake-bytes.mjs` says what construction at import
 * time costs here, and fails the build when it happens.
 *
 * Only the radio half of the dependencies is offered, and `historyStore` is left alone on purpose:
 * playback records for real, into an archive of its own, so the recorder wants the store the rest
 * of the page is already writing through. What the panel's levers put in front of that store is
 * `archiveFor`'s business, decided where the page opens it.
 */

import type { TelemetryDeps } from '../../../application/telemetry'
import { FakeRadioController } from './FakeRadioController'
import { loadPlaybackFixture } from './fixture/loadPlaybackFixture'

let controller: FakeRadioController | null = null

/** The single controller this page's panel and its radios share. */
export function fakeRadioController(): FakeRadioController {
  controller ??= new FakeRadioController(loadPlaybackFixture())
  return controller
}

export function fakeRadioDeps(): Pick<
  TelemetryDeps,
  | 'createBmsLink'
  | 'createSolarScan'
  | 'createSolarHistoryLink'
  | 'bleEnvironment'
  | 'pageActivity'
  | 'now'
> {
  const radios = fakeRadioController()
  return {
    createBmsLink: (handlers) => radios.createBmsLink(handlers),
    createSolarScan: (handlers) => radios.createSolarScan(handlers),
    createSolarHistoryLink: (handlers) => radios.createSolarHistoryLink(handlers),
    bleEnvironment: radios.bleEnvironment,
    // The page as the two rejoin loops are told to see it. It answers with the browser's own truth
    // until a lever takes the page away, which is a state one screen cannot both cause and watch.
    pageActivity: radios.pageActivity,
    now: () => radios.now(),
  }
}
