import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

export function offlineApp(): Plugin {
  let config: ResolvedConfig

  return {
    name: 'shunt-offline-app',
    apply: 'build',
    configResolved(resolvedConfig) {
      config = resolvedConfig
    },
    async closeBundle() {
      if (config.env.VITE_FAKE_BLE === 'true') return
      if (!config.base.startsWith('/') || !config.base.endsWith('/')) {
        throw new Error('Offline builds require an absolute base path ending in a slash.')
      }

      const outputDirectory = resolve(config.root, config.build.outDir)
      const filenames = (await readdir(outputDirectory, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name !== 'sw.js' && !entry.name.endsWith('.map'))
        .map((entry) => resolve(entry.parentPath, entry.name).slice(outputDirectory.length + 1).replaceAll('\\', '/'))
        .sort()
      const worker = await readFile(new URL('./service-worker.js', import.meta.url), 'utf8')
      const release = createHash('sha256').update(worker).update(config.base)
      for (const filename of filenames) {
        release.update(filename).update(await readFile(resolve(outputDirectory, filename)))
      }

      const configuration = {
        cachePrefix: `shunt-app:${config.base}:`,
        release: release.digest('hex').slice(0, 20),
        shell: `${config.base}index.html`,
        assets: filenames.map((filename) => `${config.base}${filename}`),
      }
      await writeFile(
        resolve(outputDirectory, 'sw.js'),
        worker.replace('/* BUILD_CONFIGURATION */', `const configuration = ${JSON.stringify(configuration)};`),
      )
    },
  }
}
