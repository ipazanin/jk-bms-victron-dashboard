import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'
import { launch } from 'puppeteer-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = process.env.VISUAL_OUTPUT_DIR ?? join(root, 'docs', 'google-sync')
const candidates = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
}
const executablePath = process.env.CHROME_PATH ?? candidates[process.platform]?.find(existsSync)
assert(executablePath, 'Chrome was not found. Set CHROME_PATH to an installed Chrome or Chromium executable.')
const scratch = await mkdtemp(join(tmpdir(), 'shunt-sync-ui-'))
const widths = [320, 390, 430, 834, 1440]
const states = ['disconnected', 'setup', 'connected', 'progress', 'error', 'conflict', 'legacy']
const longName = 'Boat archive with a long location name ' + 'UnbrokenArchiveName'.repeat(4)
const fixtureModule = `
import { ref, nextTick } from 'vue'
const defaults = {
  enabled: true, configured: true, prepared: true, preparing: false, connected: false,
  workspace: null, workspaces: [], revisions: [], sourceLabel: 'Boat tablet', includeSecret: false,
  autoSync: true, busy: false, progress: null, failure: null, notice: null, lastSyncAt: null,
  conflicts: [], conflictReason: null, destination: { id: 'root', name: 'My Drive' }
}
const sync = Object.fromEntries(Object.entries(defaults).map(([key, initial]) => [key, ref(initial)]))
for (const method of ['connect', 'prepare', 'disconnect', 'chooseDestination', 'createWorkspace', 'selectWorkspace',
  'chooseWorkspace', 'setSourceLabel', 'setIncludeSecret', 'setAutoSync', 'syncNow', 'cancel', 'openRevision',
  'resolveSettings', 'trashWorkspace']) sync[method] = () => {}
sync.setEnabled = enabled => { sync.enabled.value = enabled }
export const useGoogleSync = () => sync
window.setSyncFixture = async state => {
  for (const [key, initial] of Object.entries(defaults)) sync[key].value = initial
  const name = ${JSON.stringify(longName)}
  if (state !== 'disconnected') sync.connected.value = true
  if (!['disconnected', 'setup'].includes(state)) {
    sync.workspace.value = { id: 'archive', folderId: 'archive', name, version: state === 'legacy' ? 2 : 3 }
    sync.workspaces.value = [sync.workspace.value]
    sync.lastSyncAt.value = Date.UTC(2026, 9, 21, 9)
    sync.revisions.value = [{ id: 'copy', source: { id: 'phone', label: name }, exportedAt: Date.UTC(2026, 9, 21, 9),
      storage: state === 'legacy' ? 'snapshot' : 'json', sessions: 5, hours: 120, samples: 7200 }]
  }
  if (state === 'setup') sync.destination.value = { id: 'destination', name }
  if (state === 'progress') {
    sync.busy.value = true
    sync.progress.value = 'Uploading and verifying the latest history from this device.'
  }
  if (state === 'error') sync.failure.value = 'The selected Google Drive folder is no longer writable. Choose another folder and try again.'
  if (state === 'conflict') {
    sync.conflictReason.value = 'Settings changed on two devices. Choose the settings to share.'
    sync.conflicts.value = [{ id: 'settings', sourceId: 'phone', createdAt: Date.UTC(2026, 9, 21, 9), parents: [], preferences: [] }]
  }
  await nextTick()
}
`
const entry = `
import { createApp } from 'vue'
import Panel from ${JSON.stringify(join(root, 'src/components/backup/GoogleSyncPanel.vue'))}
import ${JSON.stringify(join(root, 'src/styles/tokens.css'))}
import '@fontsource/saira-semi-condensed/600.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
createApp(Panel).mount('#app')
`
let browser
try {
  const bundled = await build({
    root, configFile: false, logLevel: 'warn', define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [{
      name: 'google-sync-ui-fixture',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'sync-ui-entry' || id === join(root, 'sync-ui-entry')) return '\0sync-ui-entry'
        if (id.endsWith('/application/sync/useGoogleSync')) return '\0sync-ui-fixture'
      },
      load(id) {
        if (id === '\0sync-ui-entry') return entry
        if (id === '\0sync-ui-fixture') return fixtureModule
      },
    }, vue()],
    build: {
      outDir: scratch, emptyOutDir: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      lib: { entry: 'sync-ui-entry', name: 'SyncUiFixture', formats: ['iife'], fileName: () => 'fixture.js' },
    },
  })
  const outputs = (Array.isArray(bundled) ? bundled : [bundled]).flatMap(bundle => bundle.output)
  const script = await readFile(join(scratch, 'fixture.js'), 'utf8')
  const css = (await Promise.all(outputs.filter(asset => asset.fileName.endsWith('.css'))
    .map(asset => readFile(join(scratch, asset.fileName), 'utf8')))).join('\n')
  await mkdir(output, { recursive: true })
  browser = await launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const failures = []
  for (const width of widths) {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.setViewport({ width, height: width < 500 ? 844 : 1000, deviceScaleFactor: 1, isMobile: width < 500, hasTouch: width < 500 })
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main id="app"></main></body></html>')
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: script })
    assert.equal(errors.length, 0, errors.join('\n'))
    await page.evaluate(() => document.fonts.ready)
    for (const state of states) {
      await page.evaluate(async selected => {
        document.querySelectorAll('details').forEach(details => { details.open = false })
        await window.setSyncFixture(selected)
        window.scrollTo(0, 0)
      }, state)
      if (state === 'connected') {
        await page.focus('.workspace-setup > summary')
        await page.keyboard.press('Enter')
        assert(await page.$eval('.workspace-setup', details => details.open), `${width}px: keyboard cannot open workspace setup`)
        await page.keyboard.press('Enter')
        assert(!(await page.$eval('.workspace-setup', details => details.open)), `${width}px: keyboard cannot close workspace setup`)
      }
      for (const disclosures of ['default', 'expanded']) {
        if (disclosures === 'expanded') await page.evaluate(() => document.querySelectorAll('details').forEach(details => { details.open = true }))
        const findings = await page.evaluate(({ state, width }) => {
          const problems = []
          const panel = document.querySelector('[data-testid="google-sync-panel"]')
          const visible = element => element.checkVisibility()
          if (document.documentElement.scrollWidth > width + 1) problems.push('horizontal page overflow')
          for (const element of panel.querySelectorAll('*')) {
            if (!visible(element)) continue
            const rectangle = element.getBoundingClientRect()
            if (rectangle.left < -1 || rectangle.right > width + 1) problems.push('outside viewport: ' + element.tagName + ' ' + element.textContent.slice(0, 60))
            const style = getComputedStyle(element)
            if (['hidden', 'clip'].includes(style.overflowX) && element.scrollWidth > element.clientWidth + 1) problems.push('clipped horizontal content: ' + element.tagName)
            if (['hidden', 'clip'].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1) problems.push('clipped vertical content: ' + element.tagName)
          }
          for (const control of panel.querySelectorAll('button, input, select, summary, a')) {
            if (!visible(control)) continue
            const target = control.matches('input[type="checkbox"]') ? control.closest('label') : control
            const bounds = target.getBoundingClientRect()
            if (bounds.width < 43.5 || bounds.height < 43.5) problems.push('target smaller than 44px: ' + control.tagName + ' ' + (control.textContent || control.type).slice(0, 60))
          }
          const action = panel.querySelector('[data-testid="sync-now"]')
          if (['connected', 'progress', 'error', 'conflict'].includes(state)) {
            if (!action) problems.push('missing Sync now')
            else {
              const bounds = action.getBoundingClientRect()
              if (width === 390 && bounds.top - panel.getBoundingClientRect().top > 450) problems.push('Sync now is too far below the panel heading')
              const status = state === 'error' ? panel.querySelector('.failure') : state === 'progress' ? panel.querySelector('.actions[role="status"]') : null
              if (['error', 'progress'].includes(state) && !status) problems.push('missing progress or error near Sync now')
              if (status && status.getBoundingClientRect().top - bounds.bottom > 160) problems.push('progress or error is far from Sync now')
              if (state === 'progress' && !action.disabled) problems.push('Sync now remains enabled during a sync')
            }
          }
          if (state === 'legacy' && action) problems.push('legacy workspace offers uploads')
          return problems
        }, { state, width })
        failures.push(...findings.map(finding => `${width}px ${state} ${disclosures}: ${finding}`))
        await page.screenshot({ path: join(output, `${width}-${state}-${disclosures}.png`), fullPage: true })
      }
    }
    failures.push(...errors.map(error => `${width}px browser: ${error}`))
    await page.close()
  }
  assert.equal(failures.length, 0, failures.join('\n'))
  console.log(`Google sync UI: ${widths.length * states.length} browser fixtures passed with default and expanded disclosures. Screenshots: ${output}`)
  console.log('Chrome viewport and touch emulation does not validate Android installed-app behavior, Firefox, or the live Google Picker.')
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
