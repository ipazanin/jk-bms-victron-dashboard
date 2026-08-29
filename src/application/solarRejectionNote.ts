/**
 * What the owner has to do about advertisements that arrive and will not decode.
 *
 * One sentence for all three would be wrong about every one of them, and naming them apart is only
 * half of it: what each one means depends on which radio heard it, and a sentence that assumes the
 * wrong route sends the owner after a key that is fine.
 *
 * On the watch route the page follows a single device handle, so every advertisement it hears is
 * this boat's controller: nothing arriving there is a neighbour, and each of the three reasons
 * names a control the owner can actually reach. On the scan route the page hears every Victron in
 * the marina, so the same three are usually somebody else's equipment behaving normally — the fix
 * is offered only for the case where the unit could be theirs, and the chooser is never mentioned,
 * because a scan raises a permission prompt with no device list behind it.
 *
 * Each sentence names one fix and stops. Where the fix is in VictronConnect it says so, because
 * neither the key nor the Instant Readout toggle exists anywhere else.
 */

import type { SolarAdvertisementRejection } from '../domain/solar/SolarAdvertisementRejection'
import type { SolarAdvertisementSource } from '../domain/solar/SolarAdvertisementSource'

export function solarRejectionNote(
  rejection: SolarAdvertisementRejection,
  heardFrom: SolarAdvertisementSource,
): string {
  return heardFrom === 'this-controller'
    ? aboutTheWatchedController(rejection)
    : aboutWhateverIsInRange(rejection)
}

function aboutTheWatchedController(rejection: SolarAdvertisementRejection): string {
  switch (rejection) {
    case 'key-mismatch':
      return (
        'The controller is broadcasting readings and this page cannot open them: the key stored ' +
        'here is not the one they were encrypted with. VictronConnect issues a fresh key every ' +
        'time Instant Readout is switched off and on, so copy it again from the controller’s ' +
        'Product info and paste it above.'
      )
    case 'not-instant-readout':
      return (
        'The controller is broadcasting, but not Instant Readout records — which is what it does ' +
        'while Instant Readout is switched off. Turn it back on in VictronConnect, under Product ' +
        'info, and the readings start arriving.'
      )
    case 'other-record':
      return (
        'These Instant Readout broadcasts come from a different kind of Victron product, not a ' +
        'solar charger. Press Stop solar, then Connect solar, and pick the SmartSolar from the list.'
      )
  }
}

function aboutWhateverIsInRange(rejection: SolarAdvertisementRejection): string {
  switch (rejection) {
    case 'key-mismatch':
      return (
        'Readings are being broadcast that this page cannot open, and this browser is listening ' +
        'to every Victron in range — so they are most likely a neighbour’s. If your own ' +
        'controller is awake and still missing, its key has been reissued: VictronConnect issues ' +
        'a fresh one every time Instant Readout is switched off and on, so copy it again from ' +
        'Product info and paste it above.'
      )
    case 'not-instant-readout':
      return (
        'A Victron unit in range is broadcasting something other than Instant Readout ' +
        'records, which on this browser is as likely to be a neighbour’s equipment as yours. ' +
        'If it is your controller, Instant Readout is switched off — turn it back on in ' +
        'VictronConnect, under Product info.'
      )
    case 'other-record':
      return (
        'Instant Readout broadcasts are arriving from a different kind of Victron product — a ' +
        'battery monitor or an inverter, yours or a neighbour’s. Nothing needs doing about it: ' +
        'this page goes on listening for the solar charger.'
      )
  }
}
