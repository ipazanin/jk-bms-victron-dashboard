// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'

import type { LinkPhase } from '../src/application/linkPhase'
import type { Fault, FaultLevel, Source } from '../src/application/telemetry'
import AnnunciatorStrip from '../src/components/AnnunciatorStrip.vue'
import EnergyFlow from '../src/components/bus/EnergyFlow.vue'
import ShuntAmmeter from '../src/components/ShuntAmmeter.vue'
import SolarRow from '../src/components/SolarRow.vue'
import type { StoredEnergy } from '../src/domain/dcBus'
import type { Reach } from '../src/domain/reach'
import type { SolarReading } from '../src/domain/solar/types'
import { textOf, unmountComponent } from './support/mountComponent'

// The gap between pressing connect and the first frame is the state these components exist to
// narrate, and it is the one state a BusView-level spec cannot reach: 'connecting', 'listening'
// and 'waiting' come off link states telemetry exports readonly. So each component is mounted on
// its own with the phase set by hand, and what it says is read off the rendered text.

const REACH: Reach = { low: -8, high: 2, latest: -4.9, net: -3.2, count: 30, spanMs: 30_000 }

const AMMETER = {
  packCurrent: null as number | null,
  packVoltage: null as number | null,
  packPhase: 'absent' as LinkPhase,
  solarCurrent: null as number | null,
  solarPhase: 'absent' as LinkPhase,
  houseCurrent: null as number | null,
  housePower: null as number | null,
  houseLoadPlausible: null as boolean | null,
  pvPower: null as number | null,
  packReach: null as Reach | null,
  solarReach: null as Reach | null,
}

/** A pack frame in hand, which is the only thing that lets the pack row print anything. */
const PACK_READS = { packPhase: 'reading' as LinkPhase, packCurrent: -4.9, packVoltage: 13.4 }
const SOLAR_READS = { solarPhase: 'reading' as LinkPhase, solarCurrent: 6.2 }

function ammeter(overrides: Partial<typeof AMMETER> = {}): string {
  return textOf(ShuntAmmeter, { ...AMMETER, ...overrides })
}

const CONTROLLER: SolarReading = {
  chargeState: 'bulk',
  chargerError: 0,
  batteryVoltage: 13.42,
  batteryCurrent: 6.2,
  yieldTodayKwh: 0.42,
  pvPower: 85,
  loadCurrent: null,
}

const SOLAR_ROW = {
  solar: null as SolarReading | null,
  solarPhase: 'absent' as LinkPhase,
  bus: null,
  packVoltage: null,
  rssi: 0,
  canListenSolar: true,
}

function solarRow(overrides: Partial<typeof SOLAR_ROW> = {}): string {
  return textOf(SolarRow, { ...SOLAR_ROW, ...overrides })
}

const STRIP = {
  source: 'none' as Source,
  packPhase: 'absent' as LinkPhase,
  solarPhase: 'absent' as LinkPhase,
  faults: [] as Fault[],
  worstFault: 'good' as FaultLevel,
}

function strip(overrides: Partial<typeof STRIP> = {}): string {
  return textOf(AnnunciatorStrip, { ...STRIP, ...overrides })
}

const FLOW = {
  packCurrent: null as number | null,
  packVoltage: null as number | null,
  packPhase: 'absent' as LinkPhase,
  solarCurrent: null as number | null,
  solarPhase: 'absent' as LinkPhase,
  busVoltage: null as number | null,
  pvPower: null as number | null,
  houseCurrent: null as number | null,
  housePower: null as number | null,
  houseLoadPlausible: null as boolean | null,
  packStored: null as StoredEnergy | null,
  packReach: null as Reach | null,
  solarReach: null as Reach | null,
}

function energyFlow(overrides: Partial<typeof FLOW> = {}): string {
  return textOf(EnergyFlow, { ...FLOW, ...overrides })
}

afterEach(unmountComponent)

describe('what the shunt says while a radio is still coming up', () => {
  it('draws the chassis with no ticks and no figures when neither radio has reported', () => {
    const text = ammeter()

    expect(text).toContain('PACK')
    expect(text).toContain('SOLAR')
    expect(text).toContain('BOAT')
    expect(text).toContain('Connect the battery to see charge and cells')
    expect(text).toContain('Connect the Victron to see boat load')
    expect(text).toContain('needs both radios')
    expect(text).toContain('This is the instrument. It fills in when you connect.')
    // Nothing measured, so nothing printed in amps or volts. A zero here would be a fabrication.
    expect(text).not.toMatch(/\d ?[AVW]/)
  })

  it('withholds the axis tick labels until at least one row reads', () => {
    // The default ladder stop prints 5 / 2.5 / 0 / 2.5 / 5, a scale over nothing measured.
    expect(ammeter()).not.toContain('2.5')
    expect(ammeter({ ...PACK_READS, packCurrent: -1.2 })).toContain('2.5')
  })

  it('tells the owner to connect the battery while only solar reads', () => {
    const text = ammeter({ ...SOLAR_READS, pvPower: 85 })

    expect(text).toContain('Connect the battery to see charge and cells')
    expect(text).toContain('+6.2 A')
    expect(text).not.toContain('This is the instrument')
  })

  it('says the pack link is open and waiting while the first frame has not arrived', () => {
    const text = ammeter({ packPhase: 'waiting' })

    expect(text).toContain('linked — waiting for the first frame')
    expect(text).not.toContain('Connect the battery')
  })

  it('says the scan is listening while nothing has decoded', () => {
    const text = ammeter({ solarPhase: 'listening' })

    expect(text).toContain('listening for the controller')
    expect(text).not.toContain('Connect the Victron')
  })

  it('names the radio the boat row is missing rather than always asking for both', () => {
    const packOnly = ammeter(PACK_READS)
    expect(packOnly).toContain('needs the solar controller')
    expect(packOnly).not.toContain('needs both radios')

    const solarOnly = ammeter(SOLAR_READS)
    expect(solarOnly).toContain('needs the pack')
    expect(solarOnly).not.toContain('needs both radios')

    expect(ammeter()).toContain('needs both radios')
  })

  it('prints the pack figure and drops the chassis caption once a frame arrives', () => {
    const text = ammeter(PACK_READS)

    expect(text).toContain('−4.9 A')
    expect(text).toContain('Pack 13.40 V')
    expect(text).not.toContain('This is the instrument')
  })

  it('keeps the not-connected legend key out of the footer while a radio is mid-connect', () => {
    // The solar row is already pulsing 'starting the scan'; the legend saying it again is noise.
    const connecting = ammeter({ ...PACK_READS, solarPhase: 'connecting' })
    expect(connecting).toContain('starting the scan')
    expect(connecting).not.toContain('Solar not connected')

    expect(ammeter(PACK_READS)).toContain('Solar not connected')
  })

  it('withholds a band for a side that is not reading', () => {
    // The reach outlives the reading that justified it, so an ungated band would shade a row that
    // is currently printing nothing.
    expect(ammeter({ ...SOLAR_READS, packReach: REACH })).not.toContain('shaded')
    expect(ammeter({ ...PACK_READS, packReach: REACH })).toContain(
      'shaded — range over the last 30 s',
    )
  })
})

describe('what the solar panel says', () => {
  it('names the scan as starting while the controller is being connected', () => {
    const text = solarRow({ solarPhase: 'connecting' })

    expect(text).toContain('Starting the scan for the Victron.')
    expect(text).not.toContain('Solar not connected')
  })

  it('says it is listening rather than not connected once an advertisement goes stale', () => {
    // onStale nulls the reading and falls the state back to 'listening', which is where a boat
    // that decoded a frame a minute ago lands. 'Solar not connected' would be a lie about it.
    const text = solarRow({ solarPhase: 'listening' })

    expect(text).toContain('Listening — the scan is up, nothing decoded from the controller right now.')
    expect(text).not.toContain('Solar not connected')
  })

  it('keeps the browser-capability hint on every phase that is not reading', () => {
    const hint = 'This browser cannot read Bluetooth advertisements.'

    for (const phase of ['absent', 'connecting', 'listening', 'waiting'] as LinkPhase[]) {
      expect(solarRow({ solarPhase: phase, canListenSolar: false })).toContain(hint)
    }

    expect(solarRow({ solarPhase: 'reading', solar: CONTROLLER, canListenSolar: false })).not.toContain(hint)
  })
})

describe('what the annunciator names', () => {
  it('names only the radios that are delivering data', () => {
    const packOnly = strip({ source: 'live', packPhase: 'reading', solarPhase: 'connecting' })
    expect(packOnly).toContain('BMS')
    expect(packOnly).not.toContain('SOLAR')
    expect(packOnly).toContain('solar connecting')

    expect(strip({ source: 'live', packPhase: 'reading', solarPhase: 'reading' })).toContain(
      'BMS + SOLAR',
    )
  })

  it('names a connecting radio in lower case rather than reading NO LINK', () => {
    const text = strip({ packPhase: 'connecting' })

    expect(text).toContain('bms connecting')
    expect(text).not.toContain('NO LINK')
    expect(strip()).toContain('NO LINK')
  })

  it('reads Connecting rather than Idle while a chooser is open', () => {
    const text = strip({ packPhase: 'connecting' })

    expect(text).toContain('Connecting')
    expect(text).not.toContain('Idle')
    expect(strip()).toContain('Idle')
  })

  it('withholds the clean bill while a scan is merely listening', () => {
    // source flips to 'live' the moment the scan resolves, before anything decodes.
    const text = strip({ source: 'live', solarPhase: 'listening' })

    expect(text).not.toContain('No active faults')
    expect(text).not.toContain('Watching')
    expect(text).toContain('Waiting for a first reading')
  })

  it('withholds the pack watch list until a frame has arrived', () => {
    const waiting = strip({ source: 'live', packPhase: 'waiting', solarPhase: 'reading' })
    expect(waiting).toContain('Charger faults reported by the controller.')
    expect(waiting).not.toContain('Cell balance')

    expect(strip({ source: 'live', packPhase: 'reading', solarPhase: 'reading' })).toContain(
      'Cell balance, path resistance, MOSFET and cell temperature, breakers, charge level.',
    )
  })

  it('says nothing connected only when both radios are absent', () => {
    expect(strip()).toContain('Nothing connected')

    const listening = strip({ solarPhase: 'listening' })
    expect(listening).not.toContain('Nothing connected')
    expect(listening).toContain('Waiting for a first reading')
  })
})

describe('what the energy flow ghosts', () => {
  it('ghosts the pack edge and names the reason when no pack is connected', () => {
    const text = energyFlow({ ...SOLAR_READS, pvPower: 85, busVoltage: 13.42 })

    expect(text).toContain('no pack')
    expect(text).toContain('the pack is not connected')
    // A ghost edge carries no readout: the direction word is what the live pack edge prints.
    expect(text).not.toContain('charging')
    expect(text).not.toContain('at rest')
  })

  it('reads the bus voltage the controller reports when the pack is absent', () => {
    expect(energyFlow({ ...SOLAR_READS, busVoltage: 13.42 })).toContain('DC BUS13.4 V')
  })

  it('prints an em dash on the hub when neither radio has a voltage', () => {
    expect(energyFlow()).toContain('DC BUS—')
    expect(energyFlow({ busVoltage: 13.42 })).not.toContain('DC BUS—')
  })
})

describe('the silent gap itself', () => {
  // The one state the live page is guaranteed to pass through: connect pressed, nothing decoded,
  // every figure prop null. A formatter reached by any unguarded path throws here and takes the
  // whole instrument stack down with it.
  it('mounts every instrument mid-connect with no figure to print', () => {
    expect(energyFlow({ packPhase: 'connecting', solarPhase: 'listening' })).toContain('listening')
    unmountComponent()
    expect(ammeter({ packPhase: 'connecting', solarPhase: 'listening' })).toContain(
      'connecting to the pack',
    )
    unmountComponent()
    expect(solarRow({ solarPhase: 'listening' })).toContain('Listening')
  })
})
