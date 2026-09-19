import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { launch } from 'puppeteer-core'

const candidates = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
}
const executablePath = process.env.CHROME_PATH ?? candidates[process.platform]?.find(existsSync)
if (!executablePath) throw new Error('Set CHROME_PATH to an installed Chrome executable.')
const browser = await launch({ executablePath, headless: true, args: ['--no-sandbox'] })
try {
  const svg = await readFile(new URL('../public/icons/shunt.svg', import.meta.url), 'utf8')
  const page = await browser.newPage()
  for (const size of [180, 192, 512]) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
    await page.setContent(`<style>body{margin:0}svg{display:block;width:100%;height:100%}</style>${svg}`)
    await page.screenshot({ path: fileURLToPath(new URL(`../public/icons/shunt-${size}.png`, import.meta.url)) })
  }
} finally {
  await browser.close()
}
