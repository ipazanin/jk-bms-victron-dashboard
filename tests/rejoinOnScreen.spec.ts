// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from 'vue'
import type { App, Component } from 'vue'

import type { RejoinBlocker } from '../src/application/RejoinBlocker'
import ConnectPanel from '../src/components/ConnectPanel.vue'
import PackLinkPlate from '../src/components/bus/PackLinkPlate.vue'
import RequirementsList from '../src/components/RequirementsList.vue'
import type { SolarAdvertisementRejection } from '../src/domain/solar/SolarAdvertisementRejection'
import type { SolarAdvertisementSource } from '../src/domain/solar/SolarAdvertisementSource'
import type { BleCapabilities } from '../src/infrastructure/ble/capabilities'

/**
 * What the page says about going back to the boat on its own.
 *
 * Every claim here is one the owner acts on: whether the page is still looking, what Disconnect
 * costs, and which of the failures a tap would actually fix. They are asserted as printed text
 * because that is the only place the difference is visible — the refs behind them were already
 * proved by the supervisor specs, and a promise the page makes and cannot keep looks exactly like
 * a promise it keeps until you read it.
 */

const PACK_NAME = 'JK-BMS-Max'
const CONTROLLER_NAME = 'SmartSolar HQ22487VZHZ'

const EVERYTHING_WORKS: BleCapabilities = {
  hasBluetooth: true,
  secureContext: true,
  canConnect: true,
  canReconnect: true,
  canScan: false,
  canWatchAdvertisements: true,
  platformDeliversAdvertisements: true,
  canListenSolar: true,
  hasSubtleCrypto: true,
}

const PANEL = {
  capabilities: EVERYTHING_WORKS,
  adapterOn: true as boolean | null,
  source: 'none',
  bmsState: 'idle',
  solarState: 'idle',
  bmsBanner: null as string | null,
  solarError: null as string | null,
  solarRejection: null as SolarAdvertisementRejection | null,
  solarRejectionSource: 'this-controller' as SolarAdvertisementSource,
  initialKey: '',
  canReconnect: true,
  reconnectName: PACK_NAME as string | null,
  rejoinArmed: true,
  rejoinSearching: false,
  rejoinBlocker: null as RejoinBlocker | null,
  solarRejoinSearching: false,
  solarRejoinBlocker: null as RejoinBlocker | null,
  controllerName: CONTROLLER_NAME as string | null,
}

const PLATE = {
  packName: PACK_NAME as string | null,
  armed: true,
  searching: false,
  blocker: null as RejoinBlocker | null,
}

let host: HTMLElement
let app: App | null = null

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  app?.unmount()
  app = null
  host.remove()
})

/** Mounts one component and hands back the host, so a spec can read its copy and press its control. */
function mount(component: Component, props: Record<string, unknown>): HTMLElement {
  // A case that mounts twice is comparing two states of the same component, so the first goes.
  app?.unmount()
  app = createApp(component, props)
  app.mount(host)
  return host
}

/** Mounted text with its wrapping collapsed, so the copy can be asserted as one sentence. */
function textOf(element: HTMLElement): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ')
}

/** `onDisconnectBms` is the emit, handed in as a listener prop so a press can be counted. */
function panel(
  overrides: Partial<typeof PANEL> & { onDisconnectBms?: () => void } = {},
): HTMLElement {
  return mount(ConnectPanel, { ...PANEL, ...overrides })
}

/** `onRejoin` is the emit, handed in as a listener prop so a press can be counted. */
function plate(overrides: Partial<typeof PLATE> & { onRejoin?: () => void } = {}): HTMLElement {
  return mount(PackLinkPlate, { ...PLATE, ...overrides })
}

describe('what the Connect panel promises about reconnecting', () => {
  it('offers the standing search rather than one attempt per page load', () => {
    const text = textOf(panel())

    expect(text).toContain('while this page is in front of you it keeps looking for JK-BMS-Max')
    // A page that promises one attempt per load teaches the owner to reload to get their boat
    // back, which is the habit the standing search exists to remove.
    expect(text).not.toContain('tries once on its own')
    expect(text).not.toContain('each time this page loads')
  })

  it('names the pack it is looking for, and does not call it an error', () => {
    const showing = panel({ rejoinSearching: true })

    expect(textOf(showing)).toContain('Looking for JK-BMS-Max')
    // A pack out of range is the ordinary case on a boat. The error slot is for what the owner has
    // to act on, and there is nothing to act on here.
    expect(showing.querySelector('.error')).toBeNull()
  })

  // Which banners are worth printing is decided where both facts are known, so the panel's own
  // contract is only that it prints what it is handed — including while the search runs, because
  // an answer to a press outranks the search and arrives through this same slot.
  it('prints the banner it is handed, search or no search', () => {
    const refused = 'The BMS refused the connection. Close the JK app on your phone.'

    expect(textOf(panel({ bmsBanner: refused, rejoinSearching: true }))).toContain('refused')
    app?.unmount()
    expect(textOf(panel({ bmsBanner: null, rejoinSearching: true })).replace(/\s+/g, ' ')).not.toContain(
      'refused',
    )
  })

  it('leaves a way out of an attempt that is taking its time', () => {
    let ended = 0
    const showing = panel({ bmsState: 'connecting', onDisconnectBms: () => (ended += 1) })

    // A reconnect waits on the pack being heard from, which on a boat is minutes rather than
    // seconds. A row offering nothing but a disabled button leaves a page reload as the only move.
    const packControls = showing.querySelector('.actions')
    const live = [...(packControls?.querySelectorAll('button') ?? [])].filter(
      (control) => !control.disabled,
    )
    expect(live).not.toHaveLength(0)
    live[0].click()
    expect(ended).toBe(1)
  })

  it('says what Disconnect costs while the link is still up', () => {
    const text = textOf(panel({ bmsState: 'live' }))

    expect(text).toContain('stops this page going back to JK-BMS-Max on its own')
    expect(text).toContain('It stays off until you connect again')
  })

  it('says the search is off after a Disconnect, and what turns it back on', () => {
    const text = textOf(panel({ rejoinArmed: false }))

    expect(text).toContain('You pressed Disconnect, so this page has stopped looking for JK-BMS-Max')
    expect(text).toContain('Connecting again is what turns that back on')
  })

  it('sends the owner to the chooser when the permission is what has gone', () => {
    const text = textOf(panel({ rejoinBlocker: 'permission-gone' }))

    expect(text).toContain('This browser no longer has permission for JK-BMS-Max')
    expect(text).toContain('Pick it once more')
  })

  it('promises a browser that cannot list allowed devices nothing at all', () => {
    const text = textOf(
      panel({
        capabilities: { ...EVERYTHING_WORKS, canReconnect: false },
        canReconnect: false,
        reconnectName: null,
      }),
    )

    expect(text).toContain('cannot list the devices you have already allowed')
    expect(text).toContain('every connection starts from the chooser')
    expect(text).not.toContain('keeps looking for')
  })
})

describe('what the Connect panel says about the controller', () => {
  it('says Stop solar forgets the controller as well as ending the listening', () => {
    const text = textOf(panel({ solarState: 'listening' }))

    expect(text).toContain('forgets SmartSolar HQ22487VZHZ')
    expect(text).toContain('until you press Connect solar again')
  })

  it('stops promising the listening comes back once the owner has disconnected', () => {
    expect(textOf(panel())).toContain('puts the listening back up by itself')

    const disconnected = textOf(panel({ rejoinArmed: false }))

    // Disconnect is one answer about the boat and it stops both radios. A page that goes on
    // promising the controller comes back by itself is promising what it will not do, and the
    // owner has nothing on screen telling them which press turns it back on.
    expect(disconnected).not.toContain('puts the listening back up by itself')
    expect(disconnected).toContain(
      'You pressed Disconnect, so this page has stopped listening for SmartSolar HQ22487VZHZ',
    )
    // Disconnect was one answer about the boat, so the undo is one too: the press beside this
    // sentence arms both radios, and naming only the controller would understate it exactly as
    // the pack's own hint would if it named only the pack.
    expect(disconnected).toContain('Connect solar turns that back on, and the pack with it')
  })

  it('says Disconnect costs the controller too, beside the button that does it', () => {
    const text = textOf(panel({ bmsState: 'live', solarState: 'live' }))

    expect(text).toContain(
      'stops this page going back to JK-BMS-Max on its own, SmartSolar HQ22487VZHZ with it',
    )
  })

  /**
   * The three rejections cost the owner an afternoon on the boat, because one sentence about
   * neighbouring devices stood for all of them while the answer was a key VictronConnect had
   * quietly reissued. Each has to name the control that ends it, and none may blame the marina.
   */
  it('names the key, and only the key, when the check byte does not match', () => {
    const showing = panel({ solarState: 'listening', solarRejection: 'key-mismatch' })
    const complaint = (showing.querySelector('.solar .error')?.textContent ?? '').replace(/\s+/g, ' ')

    expect(complaint).toContain('the key stored here is not the one they were encrypted with')
    expect(complaint).toContain('a fresh key every time Instant Readout is switched off and on')
    // The watch route follows one device handle, so every advertisement it hears is this boat's
    // controller. There is no neighbour to blame and there never was.
    expect(complaint).not.toContain('other devices')
    expect(complaint).not.toContain('nearby')
  })

  it('names the Instant Readout toggle when the broadcasts are not readout records', () => {
    const text = textOf(panel({ solarState: 'listening', solarRejection: 'not-instant-readout' }))

    expect(text).toContain('not Instant Readout records')
    expect(text).toContain('Turn it back on in VictronConnect')
    // Nothing about the key: this is the Instant Readout toggle, and pasting a fresh key would
    // send the owner after something that is already right.
    expect(text).not.toContain('key stored here')
  })

  it('names the wrong product when the record is another kind of Victron', () => {
    const text = textOf(panel({ solarState: 'listening', solarRejection: 'other-record' }))

    expect(text).toContain('a different kind of Victron product, not a solar charger')
    expect(text).toContain('pick the SmartSolar from the list')
  })

  /**
   * The same three bytes mean something else on the browser's own scan, which hears every Victron
   * in the marina rather than the one handle a chooser picked. A sentence written for the watch and
   * printed on the scan tells an owner whose key is perfectly good to go and fetch another one —
   * the same wrong answer as before, aimed at the other route.
   */
  it('reads a mismatch as the marina, not a stale key, when the scan is listening', () => {
    const showing = panel({
      solarState: 'listening',
      solarRejection: 'key-mismatch',
      solarRejectionSource: 'anything-in-range',
    })
    const complaint = textOf(showing)

    expect(complaint).toContain('most likely a neighbour')
    // The owner's own key is only in question once their own controller is known to be awake, so
    // the instruction to fetch a fresh one may never stand on its own here.
    expect(complaint).toContain('If your own controller is awake and still missing')
    expect(complaint).not.toContain('The controller is broadcasting readings and this page cannot')
    // Nothing here is the owner's to act on yet, and the error slot is what says something is.
    expect(showing.querySelector('.solar .error')).toBeNull()
  })

  it('leaves the Instant Readout toggle as the owner’s only if the unit is theirs', () => {
    const text = textOf(
      panel({
        solarState: 'listening',
        solarRejection: 'not-instant-readout',
        solarRejectionSource: 'anything-in-range',
      }),
    )

    expect(text).toContain('as likely to be a neighbour')
    expect(text).toContain('turn it back on in VictronConnect')
  })

  it('does not send a scan-route owner to a device list that route never shows', () => {
    const text = textOf(
      panel({
        solarState: 'listening',
        solarRejection: 'other-record',
        solarRejectionSource: 'anything-in-range',
      }),
    )

    expect(text).toContain('a battery monitor or an inverter')
    // The scan raises a permission prompt and no list at all; the chooser is the watch route's.
    expect(text).not.toContain('pick the SmartSolar from the list')
  })

  it('says only that nothing has answered while nothing has failed to decode', () => {
    const text = textOf(panel({ solarState: 'listening' }))

    expect(text).toContain('Nothing has answered yet')
    expect(text).not.toContain('VictronConnect issues a fresh key')
  })

  it('withholds the prompt instructions from a watch it is putting back up itself', () => {
    const pressed = textOf(panel({ solarState: 'connecting' }))
    const byItself = textOf(panel({ solarState: 'connecting', solarRejoinSearching: true }))

    expect(pressed).toContain('Your browser is asking about nearby Bluetooth devices')
    // Nothing has raised a prompt, so telling the owner to answer one strands them looking for it.
    expect(byItself).not.toContain('Your browser is asking about nearby Bluetooth devices')
    expect(byItself).toContain('Listening again for SmartSolar HQ22487VZHZ')
  })
})

describe('the pack link plate on the Bus', () => {
  it('reports the search without offering a tap that would change nothing', () => {
    const showing = plate({ searching: true })

    expect(textOf(showing)).toContain('Looking for JK-BMS-Max')
    expect(showing.querySelector('button')).toBeNull()
  })

  it('offers the tap that asks for the boat back once the owner has disconnected', () => {
    let asked = 0
    const showing = plate({ armed: false, onRejoin: () => (asked += 1) })

    expect(textOf(showing)).toContain('You disconnected, so the page has stopped looking')
    const control = showing.querySelector('button')
    expect(control?.textContent).toContain('Reconnect')

    control?.click()
    expect(asked).toBe(1)
  })

  it('points at the chooser, and not at a tap, when the permission has gone', () => {
    const showing = plate({ blocker: 'permission-gone' })

    expect(textOf(showing)).toContain('cannot be rejoined without the chooser')
    expect(showing.querySelector('button')).toBeNull()
    expect(showing.querySelector('a')?.getAttribute('href')).toBe('#/connect')
  })

  it('blames the radio rather than the pack when the radio is off', () => {
    const text = textOf(plate({ blocker: 'radio-off' }))

    expect(text).toContain('Bluetooth is off')
    expect(text).toContain('picks JK-BMS-Max up again by itself')
  })
})

describe('what the requirements list says about listening', () => {
  it('says solar needs the window in front, on every platform', () => {
    const text = textOf(mount(RequirementsList, { capabilities: EVERYTHING_WORKS, adapterOn: true }))

    // Chromium tears every advertisement client down on hide and on blur, with no BUILDFLAG guard
    // and no event to say so. There is no platform where a backgrounded window still listens, so
    // the page must not let the owner discover that by leaving the app and coming back to nothing.
    expect(text).toContain('Solar only listens while this window is in front of you')
    expect(text).toContain('on every platform')
  })

  it('sends a Linux owner to another machine rather than to a flag that cannot help', () => {
    const onLinux: BleCapabilities = {
      ...EVERYTHING_WORKS,
      platformDeliversAdvertisements: false,
      canListenSolar: false,
    }

    const text = textOf(mount(RequirementsList, { capabilities: onLinux, adapterOn: true }))

    expect(text).toContain('Chromium on Linux never delivers an advertisement to a page')
    expect(text).toContain('Chrome on Android or macOS')
    // The flag is the answer everywhere else and the wrong errand here, where both APIs are
    // already present and already resolving.
    expect(text).not.toContain('enable-experimental-web-platform-features')
    // And the pack is a GATT connection, which none of this touches.
    expect(text).toContain('The battery works here as it does anywhere')
  })
})
