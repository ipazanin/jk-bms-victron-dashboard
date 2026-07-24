/**
 * Opens a real Chrome window with the app seeded full of fake data, for a walkthrough of the new
 * UI without any radios. Nothing here is committed data; it writes to a throwaway Chrome profile
 * and leaves the window open until you close it.
 *
 *   node scripts/seed-demo.mjs            # against the dev server on :5173
 *   node scripts/seed-demo.mjs http://localhost:4179/jk-bms-victron-dashboard/
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from 'puppeteer-core'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'tests', 'fixtures')
const BASE = process.argv[2] ?? 'http://localhost:5173/jk-bms-victron-dashboard/'

const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
}

const CHROME =
  process.env.CHROME_PATH ?? (CHROME_CANDIDATES[process.platform] ?? []).find((path) => existsSync(path))
if (!CHROME) {
  console.error('Could not find Chrome. Set CHROME_PATH and retry.')
  process.exit(1)
}

const remembered = JSON.parse(readFileSync(join(FIXTURES, 'rememberedSession.json'), 'utf8'))
const stored = JSON.parse(readFileSync(join(FIXTURES, 'storedSession.json'), 'utf8'))

const DAY = 86_400_000
const HOUR = 3_600_000
const now = Date.now()

// ── build three days of sessions from the one real fixture session ────────────

const device = stored.device

/** A closed session on `day`, spanning `hours`, carrying `ledger`, with the fixture's chunks moved. */
function sessionOn(id, startedAt, hours, ledger) {
  const endedAt = startedAt + hours * HOUR
  const session = {
    ...stored.session,
    id,
    state: 'closed',
    startedAt,
    endedAt,
    heartbeatAt: endedAt,
    retainedFrom: null,
    ledger: { ...stored.session.ledger, ...ledger },
  }
  // The fixture's two chunks, moved to this session and day so the ribbon draws at its start.
  const shift = startedAt - stored.session.startedAt
  const chunks = stored.chunks.map((chunk) => ({ ...chunk, sessionId: id, baseAt: chunk.baseAt + shift }))
  return { session, chunks }
}

const built = [
  sessionOn('demo-today', now - 2 * HOUR, 1.5, {
    packAh: 8, solarAh: 46, houseWh: 380, foreignAhFloor: 0, stateOfChargeMin: 79, pvPowerPeakW: 182,
  }),
  sessionOn('demo-yesterday', now - DAY - 5 * HOUR, 6, {
    packAh: -24, solarAh: 58, houseWh: 690, foreignAhFloor: 2, stateOfChargeMin: 58, pvPowerPeakW: 214,
  }),
  sessionOn('demo-2daysago', now - 2 * DAY - 3 * HOUR, 4, {
    packAh: 5, solarAh: 31, houseWh: 250, foreignAhFloor: 0, stateOfChargeMin: 84, pvPowerPeakW: 151,
  }),
]

const sessions = built.map((b) => b.session)
const chunks = built.flatMap((b) => b.chunks)

const snapshot = (over) => ({
  packCurrentA: -42.6, packVoltageV: 13.2, stateOfCharge: 61, cellDeltaMv: 14, highestCell: 1, lowestCell: 3,
  mosfetTemperatureC: 58, temperature1C: 31, temperature2C: 30, chargingEnabled: true, dischargingEnabled: true,
  solarChargeState: 'float', pvPowerW: 64, solarBatteryCurrentA: 4.6, housePowerW: 620, houseCurrentA: 47,
  houseLoadPlausible: true, ...over,
})

const warnings = [
  { sessionId: 'demo-today', seq: 0, at: now - 2 * HOUR + 20 * 60_000, level: 'warning', title: 'MOSFET warm', detail: '58.0 °C. Watch it under sustained load.', snapshot: snapshot() },
  { sessionId: 'demo-yesterday', seq: 0, at: now - DAY - 4 * HOUR, level: 'serious', title: 'Cell imbalance', detail: 'Spread 62 mV at −40.2 A, cell 3 low. Check the balance leads.', snapshot: snapshot({ cellDeltaMv: 62, packCurrentA: -40.2 }) },
  { sessionId: 'demo-yesterday', seq: 1, at: now - DAY - 3.5 * HOUR, level: 'critical', title: 'Charger error', detail: 'Error 33. Charging may be paused.', snapshot: snapshot({ solarChargeState: 'fault', pvPowerW: 0 }) },
]

const logbook = {
  fetchedAt: now,
  uptimeSecondsAtFetch: 5_702_500,
  events: [
    { secondsSinceBoot: 0, code: 1, label: 'Boot' },
    { secondsSinceBoot: 1023, code: 68, label: 'Discharge overcurrent protection III' },
    { secondsSinceBoot: 152792, code: 100, label: 'Cell 1 overcharge protection' },
    { secondsSinceBoot: 3005777, code: 18, label: 'Cell overcharge protection released' },
    { secondsSinceBoot: 5686763, code: 45, label: 'Turned off by button' },
  ],
}

const lastDevice = { id: 'demo-device', name: 'JK_B2A8S20P', at: now }
const rememberedFresh = { ...remembered, capturedAt: now - 4 * 60_000 }
const meta = { ...stored.meta }

// ── seeded in the page ────────────────────────────────────────────────────────

function seedInPage(payload) {
  const COLUMN_TYPES = {
    offsetMs: Uint32Array, currentMa: Int32Array, packVoltageMv: Uint32Array, remainingCapacityMah: Uint32Array,
    cellDeltaMv: Uint16Array, mosfetDeciC: Int16Array, temperature1DeciC: Int16Array, temperature2DeciC: Int16Array,
    stateOfCharge: Uint8Array, highestCell: Uint8Array, lowestCell: Uint8Array, switches: Uint8Array,
    batteryVoltageCv: Int16Array, batteryCurrentDa: Int16Array, yieldTodayHwh: Uint16Array, pvPowerW: Uint16Array,
    loadCurrentDa: Uint16Array, chargeStateCode: Uint8Array, chargerError: Uint8Array, rssiDbm: Int8Array,
  }
  localStorage.setItem('shunt.rememberedSession', JSON.stringify(payload.remembered))
  localStorage.setItem('shunt.logbook', JSON.stringify(payload.logbook))
  localStorage.setItem('shunt.lastBmsDevice', JSON.stringify(payload.lastDevice))

  return new Promise((resolve, reject) => {
    const request = indexedDB.open('shunt.log', 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' })
        s.createIndex('byStartedAt', 'startedAt')
        s.createIndex('byDevice', ['groupKey', 'startedAt'])
        s.createIndex('byState', 'state')
        const c = db.createObjectStore('chunks', { keyPath: ['sessionId', 'stream', 'seq'] })
        c.createIndex('bySession', 'sessionId')
        const d = db.createObjectStore('devices', { keyPath: 'key' })
        d.createIndex('byLastSeen', 'lastSeenAt')
        db.createObjectStore('meta', { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains('warnings')) {
        const w = db.createObjectStore('warnings', { keyPath: ['sessionId', 'seq'] })
        w.createIndex('byTime', 'at')
      }
    }
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(['devices', 'sessions', 'meta', 'chunks', 'warnings'], 'readwrite')
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
      tx.objectStore('devices').put(payload.device)
      tx.objectStore('meta').put(payload.meta)
      for (const session of payload.sessions) tx.objectStore('sessions').put(session)
      for (const warning of payload.warnings) tx.objectStore('warnings').put(warning)
      for (const chunk of payload.chunks) {
        const widened = { ...chunk }
        for (const [column, Type] of Object.entries(COLUMN_TYPES)) {
          const value = chunk[column]
          if (value !== undefined) widened[column] = new Type(Array.isArray(value) ? value : Object.values(value))
        }
        tx.objectStore('chunks').put(widened)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

// ── drive the browser ─────────────────────────────────────────────────────────

const browser = await launch({
  executablePath: CHROME,
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1440,900'],
})
browser.on('disconnected', () => process.exit(0))

const [page] = await browser.pages()
await page.goto(BASE, { waitUntil: 'networkidle0' })
await page.evaluate(seedInPage, {
  remembered: rememberedFresh, logbook, lastDevice, device, meta, sessions, chunks, warnings,
})
await page.reload({ waitUntil: 'networkidle0' })

console.log('Seeded. The window is yours — close it when you are done.')
await new Promise(() => {})
