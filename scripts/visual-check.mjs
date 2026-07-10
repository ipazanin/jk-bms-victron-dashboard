/**
 * Renders the built site in real Chrome at several widths and asserts the things a
 * screenshot cannot: no horizontal overflow, no console errors, no clipped text, and that
 * the demo actually produces live numbers.
 *
 * Run against `npm run preview`:  node scripts/visual-check.mjs http://localhost:4173/jk-bms-victron-dashboard/
 */

import { existsSync } from 'node:fs'
import { launch } from 'puppeteer-core'

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

const failures = []

function fail(viewport, message) {
  failures.push(`[${viewport}] ${message}`)
}

const browser = await launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars'] })

for (const viewport of VIEWPORTS) {
  const page = await browser.newPage()
  await page.setViewport({ width: viewport.width, height: viewport.height })

  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(String(error)))

  await page.goto(`${BASE}?demo`, { waitUntil: 'networkidle0' })
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const report = await page.evaluate(() => {
    const doc = document.documentElement
    const overflowing = [...document.querySelectorAll('*')]
      .filter((element) => element.getBoundingClientRect().right > doc.clientWidth + 1)
      .map((element) => `${element.tagName.toLowerCase()}.${element.className?.toString().split(' ')[0] ?? ''}`)

    const text = document.body.innerText
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflowing: [...new Set(overflowing)].slice(0, 6),
      hasHouseLoad: /HOUSE/i.test(text),
      hasNegativeZero: /−0\b/.test(text),
      soc: (text.match(/(\d+)\s*%/) ?? [])[1] ?? null,
      showsNoLink: /NO LINK/.test(text),
    }
  })

  if (report.scrollWidth > report.clientWidth + 1) {
    fail(viewport.name, `horizontal overflow: scrollWidth ${report.scrollWidth} > clientWidth ${report.clientWidth}`)
    if (report.overflowing.length) fail(viewport.name, `overflowing: ${report.overflowing.join(', ')}`)
  }
  if (errors.length) fail(viewport.name, `console errors: ${errors.slice(0, 3).join(' | ')}`)
  if (!report.hasHouseLoad) fail(viewport.name, 'demo did not render the house-load row')
  if (report.hasNegativeZero) fail(viewport.name, 'rendered a negative zero')
  if (report.showsNoLink) fail(viewport.name, 'annunciator says NO LINK while the demo is running')
  if (!report.soc) fail(viewport.name, 'no state-of-charge figure rendered')

  console.log(
    `${viewport.name.padEnd(12)} ${String(viewport.width).padStart(4)}px  ` +
      `scroll=${report.scrollWidth} client=${report.clientWidth}  soc=${report.soc ?? '—'}%  ` +
      `errors=${errors.length}`,
  )

  await page.close()
}

await browser.close()

if (failures.length) {
  console.error(`\n${failures.length} problem(s):`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('\nall viewports clean')
