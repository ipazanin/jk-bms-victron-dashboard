/**
 * Renders the built site in real Chrome at several widths and asserts the things a screenshot
 * cannot: no horizontal overflow, no console errors, no clipped text, that a seeded session
 * actually produces numbers, and that the instrument then holds still.
 *
 * The seed is written into `localStorage` and IndexedDB before the app boots, so each state below
 * is reached through the persistence path the page really uses rather than through a replay. The
 * page has no third source of data — it shows what its own radios recorded and nothing else — so a
 * check that invented one would be checking a state no owner can ever be in.
 *
 * Run against `npm run preview`:  node scripts/visual-check.mjs http://localhost:4173/jk-bms-victron-dashboard/
 *
 * The seed payloads are the fixtures the unit suite loads, so a schema change breaks the specs and
 * this check together instead of leaving one of them quietly asserting against a shape that no
 * longer exists. Their shape:
 *
 *   tests/fixtures/rememberedSession.json   a RememberedSession, exactly as `shunt.rememberedSession`
 *                                           holds it. Its `capturedAt` is restamped below, because
 *                                           the loader drops a snapshot older than its age bound and
 *                                           a fixed stamp would expire.
 *   tests/fixtures/storedSession.json       { device, session, chunks[], meta } — one row for each
 *                                           store of `shunt.log`. Chunk columns arrive as plain
 *                                           arrays and are widened to typed arrays here.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from 'puppeteer-core'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures')
const SCREENSHOT_DIR = join(ROOT, 'docs')

const BASE = process.argv[2] ?? 'http://localhost:4173/jk-bms-victron-dashboard/'

// puppeteer-core ships no bundled Chromium, so the executable path must be explicit.
// Well-known install locations per platform; the first that exists wins.
const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
}

function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const found = (CHROME_CANDIDATES[process.platform] ?? []).find((path) => existsSync(path))
  if (found) return found
  console.error(
    'Could not find Chrome. Set CHROME_PATH to your Chrome/Chromium/Edge executable and re-run.',
  )
  process.exit(1)
}

const CHROME = resolveChrome()

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'phone-large', width: 430, height: 932 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'desktop', width: 1440, height: 900 },
]

/** The width the steadiness run is measured at, matching the capture the targets came from. */
const STEADY_VIEWPORT = 'desktop'

/** Long enough to cross forty sample intervals, which is what the original capture covered. */
const STEADY_RUN_MS = 40_000
/** Every event of the original 0.3564 was a banner insert or removal. What is left is first paint. */
const MAX_LAYOUT_SHIFT = 0.02
const HEIGHT_SAMPLE_MS = 250

/** Fresh enough that the loader keeps it, old enough that the banner reads as memory. */
const REMEMBERED_AGE_MS = 3 * 60_000

const seeds = readSeeds()

const failures = []

function fail(scope, message) {
  failures.push(`[${scope}] ${message}`)
}

// ── the four states the page can be in with no radios attached ────────────────

const PASSES = [
  {
    name: 'cold',
    /** Nothing seeded: the state a first-time visitor lands in. */
    archive: false,
    remembered: false,
    hash: '',
    ready: '[data-testid="shunt-chassis"]',
    check(scope, report) {
      if (report.hasAmmeter) fail(scope, 'the live ammeter rendered with nothing connected')
      if (!report.hasChassis) fail(scope, 'the unpowered instrument did not render')
      if (!/read your dc bus/i.test(report.text)) fail(scope, 'the landing copy did not render')
      // The proof that the page fabricates nothing from nothing: no charge figure exists to print.
      if (report.soc !== null) {
        fail(scope, `a state-of-charge figure (${report.soc} %) rendered with nothing connected`)
      }
      if (/all nominal/i.test(report.text)) {
        fail(scope, 'the annunciator claimed all nominal over no data')
      }
    },
  },
  {
    name: 'remembered',
    archive: false,
    remembered: true,
    hash: '',
    ready: '[data-testid="shunt-ammeter"]',
    check(scope, report) {
      if (!report.hasHouseLoad) {
        fail(scope, 'the remembered session did not render the house-load row')
      }
      if (!report.soc) fail(scope, 'no state-of-charge figure rendered')
      if (!/not live data/i.test(report.text)) fail(scope, 'the remembered banner did not render')
    },
  },
  {
    name: 'log',
    archive: true,
    remembered: true,
    hash: '#/log',
    ready: 'a[href^="#/log/"]',
    check(scope, report) {
      if (report.sessionRows < 1) fail(scope, 'the seeded session did not render as a row')
      if (!report.text.includes(seeds.deviceName)) {
        fail(scope, `the device name "${seeds.deviceName}" did not render`)
      }
      if (!/both radios/i.test(report.text)) fail(scope, 'the coverage legend did not render')
    },
  },
  {
    name: 'session',
    archive: true,
    remembered: true,
    hash: `#/log/${encodeURIComponent(seeds.sessionId)}`,
    ready: '[data-testid="shunt-ledger"]',
    check(scope, report) {
      if (report.ledgerFigures.length < 2) {
        fail(scope, `the ledger printed ${report.ledgerFigures.length} figures`)
      }
      if (report.ribbonPath === '') fail(scope, "the ribbon's pack trace carries an empty path")
    },
  },
  {
    name: 'stats',
    archive: true,
    remembered: true,
    hash: '#/stats',
    ready: '[data-testid="stats-view"]',
    check(scope, report) {
      if (!/daily energy/i.test(report.text)) fail(scope, 'the daily energy panel did not render')
      if (!/device logbook/i.test(report.text)) fail(scope, 'the logbook panel did not render')
      if (!/boot/i.test(report.text)) fail(scope, 'the seeded logbook events did not render')
    },
  },
  {
    name: 'warnings',
    archive: true,
    remembered: true,
    hash: '#/warnings',
    ready: '[data-testid="warnings-view"]',
    check(scope, report) {
      if (!/mosfet warm/i.test(report.text)) fail(scope, 'the seeded warning did not render')
    },
  },
]

mkdirSync(SCREENSHOT_DIR, { recursive: true })

const browser = await launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars'] })

for (const viewport of VIEWPORTS) {
  for (const pass of PASSES) {
    const scope = `${viewport.name} ${pass.name}`
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    const errors = watchForErrors(page)

    await page.setViewport({ width: viewport.width, height: viewport.height })
    // Dark is the instrument's own default; headless Chrome would otherwise report a light
    // preference and every screenshot would show the theme the design does not lead with.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])

    await page.goto(BASE, { waitUntil: 'networkidle0' })
    await seedOrigin(page, pass)
    await page.reload({ waitUntil: 'networkidle0' })
    const rendered = await page
      .waitForSelector(pass.ready, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false)

    const report = await readPage(page)
    if (report.scrollWidth > report.clientWidth + 1) {
      fail(
        scope,
        `horizontal overflow: scrollWidth ${report.scrollWidth} > clientWidth ${report.clientWidth}`,
      )
      if (report.overflowing.length) fail(scope, `overflowing: ${report.overflowing.join(', ')}`)
    }
    if (errors.length) fail(scope, `console errors: ${errors.slice(0, 3).join(' | ')}`)
    if (report.hasNegativeZero) fail(scope, 'rendered a negative zero')
    // A state that never rendered fails once, for the reason it never rendered. Grading its
    // contents as well would report one cause three times.
    if (rendered) pass.check(scope, report)
    else fail(scope, `nothing matched ${pass.ready} within 10 s`)

    await page.screenshot({ path: join(SCREENSHOT_DIR, `${viewport.name}-${pass.name}.png`) })

    console.log(
      `${scope.padEnd(24)} ${String(viewport.width).padStart(4)}px  ` +
        `scroll=${report.scrollWidth} client=${report.clientWidth}  soc=${report.soc ?? '—'}%  ` +
        `errors=${errors.length}`,
    )

    await context.close()
  }
}

await measureSteadiness()

await browser.close()

if (failures.length) {
  console.error(`\n${failures.length} problem(s):`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('\nall viewports clean')

// ── the steadiness run ────────────────────────────────────────────────────────

/**
 * The three measurements the layout work was aimed at, taken the same way they were taken on the
 * hardware, so a regression shows up as the same number rather than as a proxy for it.
 *
 * Layout shift is counted from first paint, because the figure it replaces was. The height and the
 * label are sampled from a settled page: a webfont swapping in is a load artefact, and the toggle
 * being guarded against is one that repeats every second for as long as the page is open.
 */
async function measureSteadiness() {
  const viewport = VIEWPORTS.find((each) => each.name === STEADY_VIEWPORT)
  const scope = `${viewport.name} steady`
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  const errors = watchForErrors(page)

  await page.setViewport({ width: viewport.width, height: viewport.height })
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await page.evaluateOnNewDocument(installInstruments, HEIGHT_SAMPLE_MS)

  await page.goto(BASE, { waitUntil: 'networkidle0' })
  await seedOrigin(page, { remembered: true, archive: true, hash: '' })
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-testid="shunt-ammeter"]', { timeout: 10_000 })

  await page.evaluate(async () => {
    await document.fonts.ready
    window.__shuntSteady.start()
  })
  await new Promise((resolve) => setTimeout(resolve, STEADY_RUN_MS))
  const measured = await page.evaluate(() => window.__shuntSteady.read())

  if (measured.layoutShift > MAX_LAYOUT_SHIFT) {
    fail(scope, `cumulative layout shift ${measured.layoutShift.toFixed(4)} > ${MAX_LAYOUT_SHIFT}`)
  }
  if (measured.heights.length !== 1) {
    fail(scope, `document height took ${measured.heights.length} values: ${measured.heights.join(' ↔ ')}`)
  }
  if (measured.labelX.length === 0) {
    fail(scope, 'the pack value label never rendered')
  } else if (measured.labelX.length > 1) {
    fail(scope, `the pack value label moved through ${measured.labelX.length} x values: ${measured.labelX.join(' → ')}`)
  }
  if (errors.length) fail(scope, `console errors: ${errors.slice(0, 3).join(' | ')}`)

  console.log(
    `${scope.padEnd(24)} ${STEADY_RUN_MS / 1000}s  ` +
      `cls=${measured.layoutShift.toFixed(4)}  heights=${measured.heights.length}  ` +
      `labelX=${measured.labelX.length}`,
  )

  await context.close()
}

/**
 * Runs before anything on the page does, so the layout-shift observer is registered ahead of the
 * first paint it has to count. Sampling starts later, on `start()`, once the page has settled.
 */
function installInstruments(sampleMs) {
  const PACK_LABEL = '[data-testid="shunt-ammeter"] text.value.pack-ink'
  const heights = new Set()
  const labelX = new Set()
  let layoutShift = 0
  let sampler

  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) layoutShift += entry.value
    }
  }).observe({ type: 'layout-shift', buffered: true })

  const sample = () => {
    heights.add(document.documentElement.scrollHeight)
    const label = document.querySelector(PACK_LABEL)
    if (label !== null) labelX.add(label.getAttribute('x'))
  }

  window.__shuntSteady = {
    start() {
      sample()
      sampler = setInterval(sample, sampleMs)
      // The poll would miss a value that appeared and left between two ticks; an attribute write
      // is exactly what the label must never make, so it is caught on the write itself.
      new MutationObserver(() => sample()).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['x'],
      })
    },
    read() {
      clearInterval(sampler)
      return { layoutShift, heights: [...heights], labelX: [...labelX] }
    },
  }
}

// ── seeding, reading, reporting ───────────────────────────────────────────────

function watchForErrors(page) {
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(String(error)))
  return errors
}

/**
 * Writes the seed into the stores the app reads, on an origin the page has already established.
 *
 * `evaluateOnNewDocument` would be wrong here. It works for the synchronous `localStorage` write
 * and races the app's own IndexedDB open, because nothing on the page awaits the promise it
 * returns — so the seed can land after the archive has already been listed as empty.
 */
async function seedOrigin(page, pass) {
  if (!pass.remembered && !pass.archive) return
  await page.evaluate(
    seedStores,
    pass.remembered ? { ...seeds.remembered, capturedAt: Date.now() - REMEMBERED_AGE_MS } : null,
    pass.archive ? seeds.archive : null,
  )
  if (pass.hash) await page.evaluate((hash) => (window.location.hash = hash), pass.hash)
}

/**
 * Runs in the page. The schema is built here rather than waited for, so the seed does not depend
 * on the app having opened the database first; it is deliberately the same shape the adapter
 * builds, and a drift between the two shows up as a Log that lists nothing.
 */
async function seedStores(remembered, archive) {
  const DATABASE = 'shunt.log'
  const VERSION = 2
  const STORES = ['sessions', 'chunks', 'devices', 'meta', 'warnings']

  // JSON carries no typed arrays. Each column is widened back to the width the archive stores it
  // at, so what the page reads back is byte-for-byte what a recording would have left behind.
  const COLUMN_TYPES = {
    offsetMs: Uint32Array,
    currentMa: Int32Array,
    packVoltageMv: Uint32Array,
    remainingCapacityMah: Uint32Array,
    cellDeltaMv: Uint16Array,
    mosfetDeciC: Int16Array,
    temperature1DeciC: Int16Array,
    temperature2DeciC: Int16Array,
    stateOfCharge: Uint8Array,
    highestCell: Uint8Array,
    lowestCell: Uint8Array,
    switches: Uint8Array,
    batteryVoltageCv: Int16Array,
    batteryCurrentDa: Int16Array,
    yieldTodayHwh: Uint16Array,
    pvPowerW: Uint16Array,
    loadCurrentDa: Uint16Array,
    chargeStateCode: Uint8Array,
    chargerError: Uint8Array,
    rssiDbm: Int8Array,
  }

  if (remembered !== null) {
    localStorage.setItem('shunt.rememberedSession', JSON.stringify(remembered))
  }
  if (archive === null) return

  // The device logbook the Stats tab shows, in the shape telemetry persists it.
  localStorage.setItem(
    'shunt.logbook',
    JSON.stringify({
      fetchedAt: archive.session.startedAt + 3_600_000,
      uptimeSecondsAtFetch: 5_702_500,
      events: [
        { secondsSinceBoot: 0, code: 1, label: 'Boot' },
        { secondsSinceBoot: 1023, code: 68, label: 'Discharge overcurrent protection III' },
        { secondsSinceBoot: 152792, code: 100, label: 'Cell 1 overcharge protection' },
        { secondsSinceBoot: 3005777, code: 18, label: 'Cell overcharge protection released' },
      ],
    }),
  )

  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION)
    request.onupgradeneeded = () => {
      const created = request.result
      const sessions = created.createObjectStore('sessions', { keyPath: 'id' })
      sessions.createIndex('byStartedAt', 'startedAt')
      sessions.createIndex('byDevice', ['groupKey', 'startedAt'])
      sessions.createIndex('byState', 'state')

      const chunks = created.createObjectStore('chunks', {
        keyPath: ['sessionId', 'stream', 'seq'],
      })
      chunks.createIndex('bySession', 'sessionId')

      const devices = created.createObjectStore('devices', { keyPath: 'key' })
      devices.createIndex('byLastSeen', 'lastSeenAt')

      created.createObjectStore('meta', { keyPath: 'key' })

      const warnings = created.createObjectStore('warnings', { keyPath: ['sessionId', 'seq'] })
      warnings.createIndex('byTime', 'at')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORES, 'readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)

    transaction.objectStore('devices').put(archive.device)
    transaction.objectStore('sessions').put(archive.session)
    transaction.objectStore('meta').put(archive.meta)
    // One warning tied to the seeded session, so the Warnings view renders a row with its readings.
    transaction.objectStore('warnings').put({
      sessionId: archive.session.id,
      seq: 0,
      at: archive.session.startedAt + 90_000,
      level: 'warning',
      title: 'MOSFET warm',
      detail: '58.0 °C. Watch it under sustained load.',
      snapshot: {
        packCurrentA: -42.6,
        packVoltageV: 13.2,
        stateOfCharge: 61,
        cellDeltaMv: 12,
        highestCell: 1,
        lowestCell: 3,
        mosfetTemperatureC: 58,
        temperature1C: 31,
        temperature2C: 30,
        chargingEnabled: true,
        dischargingEnabled: true,
        solarChargeState: 'float',
        pvPowerW: 64,
        solarBatteryCurrentA: 4.6,
        housePowerW: 620,
        houseCurrentA: 47,
        houseLoadPlausible: true,
      },
    })
    for (const chunk of archive.chunks) {
      const widened = { ...chunk }
      for (const [column, Type] of Object.entries(COLUMN_TYPES)) {
        const stored = chunk[column]
        if (stored === undefined) continue
        widened[column] = new Type(Array.isArray(stored) ? stored : Object.values(stored))
      }
      transaction.objectStore('chunks').put(widened)
    }
  })
  database.close()
}

function readPage(page) {
  return page.evaluate(() => {
    const doc = document.documentElement
    const overflowing = [...document.querySelectorAll('*')]
      .filter((element) => element.getBoundingClientRect().right > doc.clientWidth + 1)
      .map(
        (element) =>
          `${element.tagName.toLowerCase()}.${element.className?.toString().split(' ')[0] ?? ''}`,
      )

    const text = document.body.innerText
    const ribbon = document.querySelector('[data-testid="session-ribbon"] path.trace.pack')
    const figures = [...document.querySelectorAll('[data-testid="shunt-ledger"] text.value')]

    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflowing: [...new Set(overflowing)].slice(0, 6),
      text,
      hasAmmeter: document.querySelector('[data-testid="shunt-ammeter"]') !== null,
      hasChassis: document.querySelector('[data-testid="shunt-chassis"]') !== null,
      hasHouseLoad: /HOUSE/i.test(text),
      // A figure that rounds to zero must carry no direction. A real −0.3 A is not that, and
      // matching it would fail the check on the very reading the sign rule exists to print.
      hasNegativeZero: /−0(?:\.0+)?(?![.\d])/.test(text),
      soc: (text.match(/(\d+)\s*%/) ?? [])[1] ?? null,
      sessionRows: document.querySelectorAll('a[href^="#/log/"]').length,
      ledgerFigures: figures.map((node) => node.textContent.trim()).filter(Boolean),
      ribbonPath: ribbon?.getAttribute('d')?.trim() ?? '',
    }
  })
}

function readSeeds() {
  const remembered = readFixture('rememberedSession.json')
  const archive = readFixture('storedSession.json')

  for (const key of ['device', 'session', 'chunks', 'meta']) {
    if (archive[key] === undefined) {
      console.error(`storedSession.json is missing "${key}"; the check seeds one row per store.`)
      process.exit(1)
    }
  }
  // A chunk keyed to another session is unreachable from the session view, and the ribbon would
  // draw empty with nothing to say why.
  const stray = archive.chunks.find((chunk) => chunk.sessionId !== archive.session.id)
  if (stray !== undefined) {
    console.error(`storedSession.json has a chunk for "${stray.sessionId}", not "${archive.session.id}".`)
    process.exit(1)
  }

  return {
    remembered,
    archive,
    sessionId: archive.session.id,
    deviceName: archive.device.userLabel ?? archive.device.defaultLabel,
  }
}

function readFixture(name) {
  const path = join(FIXTURE_DIR, name)
  if (!existsSync(path)) {
    console.error(
      `Missing ${path}. The visual check seeds the real stores from the fixtures the unit suite loads.`,
    )
    process.exit(1)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}
