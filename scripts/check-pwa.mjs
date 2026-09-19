import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from 'puppeteer-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = join(root, 'dist')
const html = await readFile(join(outputDirectory, 'index.html'), 'utf8')
const manifestPath = html.match(/rel="manifest"[^>]*href="([^"]+)"/)?.[1]
assert.ok(manifestPath?.startsWith('/'), 'Build the production app before running this check.')
const base = manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1)
const filenames = (await readdir(outputDirectory, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && !entry.name.endsWith('.map'))
  .map((entry) => join(entry.parentPath, entry.name).slice(outputDirectory.length + 1).replaceAll('\\', '/'))
const builtFiles = new Map(await Promise.all(filenames.map(async (filename) => [
  filename, await readFile(join(outputDirectory, filename)),
])))
assert.ok(builtFiles.has('sw.js'), 'The production build must contain a service worker.')
const missingAsset = filenames.find((filename) => filename.endsWith('.woff2'))
assert.ok(missingAsset, 'Expected bundled fonts to exercise a failed precache installation.')
const archive = JSON.parse(await readFile(join(root, 'tests/fixtures/storedSession.json'), 'utf8'))
const mimeTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff',
}
let release = 'initial'
let serverUnavailable = false
const server = createServer((request, response) => {
  if (serverUnavailable) {
    request.socket.destroy()
    return
  }
  const pathname = new URL(request.url, 'http://localhost').pathname
  if (pathname === '/probe') {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
    response.end('<!doctype html><title>Browser storage probe</title>')
    return
  }
  const filename = pathname.startsWith(base) ? pathname.slice(base.length) || 'index.html' : null
  let body = builtFiles.get(filename)
  if (release === 'broken' && filename === missingAsset) body = undefined
  if (!body) {
    response.writeHead(404)
    response.end()
    return
  }
  if (filename === 'sw.js' && release !== 'initial') {
    const source = body.toString()
    const changed = source.replace(/("release"\s*:\s*")([^"]+)(")/, `$1$2-${release}$3`)
    assert.notEqual(changed, source, 'The update fixture must create a distinct release cache.')
    body = Buffer.from(`${changed}\n// Browser regression fixture: ${release}\n`)
  }
  response.writeHead(200, {
    'Content-Type': mimeTypes[extname(filename)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  })
  response.end(body)
})

const candidates = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
}
const browserName = process.argv.includes('--firefox') ? 'firefox' : 'chrome'
const firefoxCandidates = {
  darwin: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
  linux: ['/usr/bin/firefox'],
  win32: ['C:\\Program Files\\Mozilla Firefox\\firefox.exe'],
}
const executablePath = browserName === 'firefox'
  ? process.env.FIREFOX_PATH ?? firefoxCandidates[process.platform]?.find(existsSync)
  : process.env.CHROME_PATH ?? candidates[process.platform]?.find(existsSync)
assert.ok(executablePath, `Set ${browserName === 'firefox' ? 'FIREFOX_PATH' : 'CHROME_PATH'} to an installed browser executable.`)
let browser
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  const appUrl = origin + base
  browser = await launch({ browser: browserName, executablePath, headless: true, args: browserName === 'chrome' ? ['--no-sandbox'] : [] })
  console.log(`Checking ${await browser.version()}`)
  const context = await browser.createBrowserContext()
  const probe = await context.newPage()
  await probe.goto(`${origin}/probe`)
  await probe.evaluate(async () => {
    const cache = await caches.open('another-project-cache')
    await cache.put('/unrelated', new Response('Keep another app intact'))
  })
  const errors = []
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.setCacheEnabled(false)
  await page.goto(appUrl)
  await waitUntilReady(page)
  const manifest = await page.evaluate(async () => {
    const url = document.querySelector('link[rel="manifest"]').href
    const manifest = await (await fetch(url)).json()
    const icons = await Promise.all(manifest.icons.map(async (icon) => {
      const bitmap = await createImageBitmap(await (await fetch(new URL(icon.src, url))).blob())
      return { declared: icon.sizes, actual: `${bitmap.width}x${bitmap.height}` }
    }))
    return { ...manifest, url, icons }
  })
  assert.equal(new URL(manifest.scope, manifest.url).href, appUrl)
  assert.equal(new URL(manifest.start_url, manifest.url).href, appUrl)
  assert.equal(new URL(manifest.id, manifest.url).href, appUrl)
  assert.equal(manifest.display, 'standalone')
  for (const size of ['192x192', '512x512']) {
    assert.ok(manifest.icons.some((icon) => icon.declared === size && icon.actual === size), `Missing valid ${size} icon`)
  }
  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope), appUrl)
  const assets = filenames.filter((filename) => filename !== 'sw.js').map((filename) => appUrl + filename)
  assert.deepEqual(await page.evaluate(async (urls) => {
    const missing = []
    for (const url of urls) if (!await caches.match(url)) missing.push(url)
    return missing
  }, assets), [], 'Every built asset, including lazy chunks and fonts, must be available offline.')

  await page.waitForFunction(async () => (await indexedDB.databases()).some((database) => database.name === 'shunt.log'))
  await page.evaluate(seedArchive, archive)
  // Firefox's WebDriver offline emulation rejects navigation before service-worker handling.
  serverUnavailable = true
  if (browserName === 'chrome') await page.setOfflineMode(true)
  await page.goto(`${appUrl}?offline-check=1#/log`, { waitUntil: 'networkidle0' })
  await waitUntilReady(page)
  assert.equal(await page.evaluate(() => localStorage.getItem('shunt.theme')), 'light')
  await page.waitForSelector(`a[href="#/log/${archive.session.id}"]`)
  await page.click(`a[href="#/log/${archive.session.id}"]`)
  await page.waitForSelector('[data-testid="shunt-ledger"]')
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-testid="shunt-ledger"]')
  assert.deepEqual(errors, [], 'Offline navigation and restored recordings must not produce browser errors.')
  console.log('PASS: manifest, icons, scoped worker, complete precache, offline reload, saved preferences and recorded Log detail')

  serverUnavailable = false
  if (browserName === 'chrome') await page.setOfflineMode(false)
  const secondWindow = await context.newPage()
  await secondWindow.goto(appUrl)
  await waitUntilReady(secondWindow)
  const originalCaches = await probe.evaluate(() => caches.keys())
  const originalDocument = await page.evaluate(() => {
    window.pwaCheckDocument = crypto.randomUUID()
    return window.pwaCheckDocument
  })
  release = 'updated'
  await page.evaluate(async () => (await navigator.serviceWorker.ready).update())
  await probe.waitForFunction(async (scope) => Boolean((await navigator.serviceWorker.getRegistration(scope))?.waiting), { polling: 100 }, appUrl)
  assert.equal(await page.evaluate(() => window.pwaCheckDocument), originalDocument, 'An update must not reload the page.')
  const cachesWithUpdate = await probe.evaluate(() => caches.keys())
  for (const cacheName of originalCaches) assert.ok(cachesWithUpdate.includes(cacheName), 'Waiting updates must retain active caches.')
  assert.ok(cachesWithUpdate.some((cacheName) => !originalCaches.includes(cacheName)), 'The next release must have its own complete cache.')
  await page.close()
  assert.ok(await probe.evaluate(async (scope) => Boolean((await navigator.serviceWorker.getRegistration(scope))?.waiting), appUrl), 'Another open app window must hold the update waiting.')
  await secondWindow.close()
  await probe.waitForFunction(async (scope) => {
    const registration = await navigator.serviceWorker.getRegistration(scope)
    return registration?.active?.state === 'activated' && !registration.waiting
  }, { polling: 100 }, appUrl)
  const activeCaches = await probe.evaluate(() => caches.keys())
  for (const cacheName of originalCaches.filter((name) => name !== 'another-project-cache')) {
    assert.ok(!activeCaches.includes(cacheName), 'Old app caches should be removed after activation.')
  }
  assert.equal(await probe.evaluate(async () => (await caches.match('/unrelated'))?.text()), 'Keep another app intact')
  const reopened = await context.newPage()
  await reopened.setCacheEnabled(false)
  serverUnavailable = true
  if (browserName === 'chrome') await reopened.setOfflineMode(true)
  await reopened.goto(`${appUrl}?offline-check=updated#/log/${archive.session.id}`)
  await waitUntilReady(reopened)
  await reopened.waitForSelector('[data-testid="shunt-ledger"]')
  await context.close()
  console.log('PASS: updates wait for every app window, preserve saved recordings, activate on close, and preserve unrelated caches')

  release = 'broken'
  serverUnavailable = false
  const failedContext = await browser.createBrowserContext()
  const failedPage = await failedContext.newPage()
  await failedPage.goto(`${origin}/probe`)
  const failedInstallation = await failedPage.evaluate(async (scope) => {
    try {
      const registration = await navigator.serviceWorker.register(`${scope}sw.js`, { scope })
      const worker = registration.installing
      if (worker) await new Promise((resolve) => {
        if (worker.state === 'redundant' || worker.state === 'activated') resolve()
        else worker.addEventListener('statechange', () => {
          if (worker.state === 'redundant' || worker.state === 'activated') resolve()
        })
      })
      return { active: Boolean(registration.active), state: worker?.state, caches: await caches.keys() }
    } catch {
      return { active: false, state: 'rejected', caches: await caches.keys() }
    }
  }, appUrl)
  assert.equal(failedInstallation.active, false, 'An incomplete shell must not become available offline.')
  assert.ok(['redundant', 'rejected'].includes(failedInstallation.state))
  assert.deepEqual(failedInstallation.caches, [], 'An unsuccessful first install must not leave a partial app cache.')
  await failedPage.goto(appUrl)
  await failedPage.waitForFunction(() => document.querySelector('[data-testid="offline-status"]')?.textContent.includes('Offline copy unavailable'))
  await failedContext.close()
  console.log('PASS: a missing precache asset rejects installation and removes the incomplete cache')
} finally {
  await browser?.close()
  if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function waitUntilReady(page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  await page.waitForFunction(() => /Ready offline|Offline · saved app ready/.test(
    document.querySelector('[data-testid="offline-status"]')?.textContent ?? '',
  ))
}

async function seedArchive(archive) {
  localStorage.setItem('shunt.theme', 'light')
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('shunt.log')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(['devices', 'sessions', 'chunks', 'meta'], 'readwrite')
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
      transaction.objectStore('devices').put(archive.device)
      transaction.objectStore('sessions').put(archive.session)
      transaction.objectStore('meta').put(archive.meta)
      for (const chunk of archive.chunks) {
        const restored = { ...chunk }
        for (const [column, type] of Object.entries(archive.columnTypes[chunk.stream])) {
          restored[column] = new globalThis[type](chunk[column])
        }
        transaction.objectStore('chunks').put(restored)
      }
    })
  } finally {
    database.close()
  }
}
