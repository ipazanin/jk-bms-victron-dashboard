// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import type { App } from 'vue'

import WarningLedger from '../src/components/bus/WarningLedger.vue'
import type { SessionId, WarningRecord, WarningSnapshot } from '../src/domain/history/types'

/**
 * The dashboard's record of faults the annunciator has already stopped showing. Two claims matter
 * and neither is visible in the rendered text: the card holds a fixed height whatever the archive
 * holds, and it mounts only the rows in view — a thousand-row archive that mounted a thousand rows
 * would cost a phone more than the card is worth.
 */

const ROW_HEIGHT = 60

let app: App | null = null
let host: HTMLElement | null = null

function mount(warnings: readonly WarningRecord[]): HTMLElement {
  unmount()
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(WarningLedger, { warnings })
  app.mount(host)
  return host
}

function unmount(): void {
  app?.unmount()
  app = null
  host?.remove()
  host = null
}

afterEach(unmount)

/** The card prints none of this — the readings live in the standalone log — so one shape does. */
const SNAPSHOT: WarningSnapshot = {
  packCurrentA: -8.4,
  packVoltageV: 13.2,
  stateOfCharge: 74,
  cellDeltaMv: 11,
  highestCell: 1,
  lowestCell: 4,
  mosfetTemperatureC: 41,
  temperature1C: 22,
  temperature2C: 23,
  chargingEnabled: true,
  dischargingEnabled: true,
  solarChargeState: 'bulk',
  pvPowerW: 104,
  solarBatteryCurrentA: 7.9,
  housePowerW: 215,
  houseCurrentA: 16.3,
  houseLoadPlausible: true,
}

function warning(index: number): WarningRecord {
  return {
    sessionId: `session-${Math.floor(index / 10)}` as SessionId,
    seq: index,
    at: 1_700_000_000_000 - index * 60_000,
    level: index % 3 === 0 ? 'critical' : index % 3 === 1 ? 'serious' : 'warning',
    title: `Fault ${index}`,
    detail: `What was standing behind fault ${index}.`,
    snapshot: SNAPSHOT,
  }
}

function warnings(count: number): WarningRecord[] {
  return Array.from({ length: count }, (_unused, index) => warning(index))
}

function rowsIn(element: HTMLElement): string[] {
  return [...element.querySelectorAll('li.row')].map((row) => row.textContent ?? '')
}

async function scrollTo(element: HTMLElement, top: number): Promise<void> {
  const viewport = element.querySelector('.viewport')!
  viewport.scrollTop = top
  viewport.dispatchEvent(new Event('scroll'))
  await nextTick()
}

describe('WarningLedger', () => {
  it('says what it is for rather than showing an empty box', () => {
    const element = mount([])

    expect(element.textContent).toContain('Nothing recorded')
    expect(element.querySelector('.viewport')).toBeNull()
  })

  it('shows the warnings it is given, in the order it is given them', () => {
    const rows = rowsIn(mount(warnings(3)))

    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('Fault 0')
    expect(rows[0]).toContain('What was standing behind fault 0.')
    expect(rows[2]).toContain('Fault 2')
  })

  it('names the severity in words, so the dot is never the only channel carrying it', () => {
    const element = mount([warning(0), warning(1), warning(2)])

    expect(element.textContent).toContain('Critical')
    expect(element.textContent).toContain('Serious')
    expect(element.textContent).toContain('Warning')
  })

  it('mounts only the rows in view, whatever the archive holds', () => {
    const element = mount(warnings(1000))

    // Six in view plus an overscan band either side: bounded, and nowhere near a thousand.
    expect(rowsIn(element).length).toBeLessThan(20)
    expect(rowsIn(element)[0]).toContain('Fault 0')
  })

  it('reserves the whole list in the runway, so the scrollbar describes the archive', () => {
    const element = mount(warnings(1000))
    const runway = element.querySelector('.runway') as HTMLElement

    expect(runway.style.height).toBe(`${1000 * ROW_HEIGHT}px`)
  })

  it('moves the window as the card is scrolled', async () => {
    const element = mount(warnings(1000))

    await scrollTo(element, 500 * ROW_HEIGHT)

    const rows = rowsIn(element)
    expect(rows.some((row) => row.includes('Fault 500'))).toBe(true)
    expect(rows.some((row) => row.includes('Fault 0'))).toBe(false)
    // The rendered block is offset by exactly the rows it skipped, or every row would sit wrong.
    const list = element.querySelector('.rows') as HTMLElement
    expect(list.style.transform).toBe(`translateY(${(500 - 4) * ROW_HEIGHT}px)`)
  })

  it('does not scroll off the top when the window would run before the first row', async () => {
    const element = mount(warnings(1000))

    await scrollTo(element, 0)

    expect(rowsIn(element)[0]).toContain('Fault 0')
    expect((element.querySelector('.rows') as HTMLElement).style.transform).toBe('translateY(0px)')
  })

  it('announces the count, which is what a virtualised list costs a screen reader', () => {
    const element = mount(warnings(42))
    const region = element.querySelector('.viewport')!

    expect(region.getAttribute('aria-label')).toContain('42')
    expect(region.getAttribute('aria-label')).toContain('most recent first')
  })
})
