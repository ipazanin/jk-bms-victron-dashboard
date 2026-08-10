/**
 * Fails the build if any byte of the fake-BLE dev mode reached the bundle.
 *
 * The playback fake and its control panel are meant to fall out of a production build entirely, but
 * that elimination is a property of how the flag is written rather than anything the compiler
 * promises, and both shapes that break it read as tidying. Lift
 * `import.meta.env.VITE_FAKE_BLE === 'true'` out of `browserDeps` into a shared exported constant
 * and the dead branch stops being eliminated: the build then emits the recording and both wire
 * captures — chunks of 435 kB, 84 kB and 3 kB that the inline form leaves out altogether — while
 * the main chunk and the stylesheet come out byte for byte identical, so nothing about the page's
 * own weight says anything went wrong. Constructing anything at module scope under
 * `src/infrastructure/ble/fake/` emits the same three by the other route, being a top-level side
 * effect nothing can prove pure. Neither shows its cost at the site that caused it. Hence the
 * comparison written inline at every site that reads the flag, nothing in the fake's directory
 * built at import time, and the proof taken from the output rather than from the source.
 *
 * The marker rides in the recording and in the panel's stylesheet because the two travel
 * separately. The branch in `browserDeps` reaches the recording and never the panel, so the panel's
 * stylesheet is not in that build to be found at all; hoisting the mount guard in `main.ts` instead
 * gives the panel a chunk and a stylesheet of its own.
 *
 * Runs as the tail of `npm run build`, so a local build catches this and not only CI. With no
 * `dist/` there is nothing to inspect and it says nothing.
 *
 *   node scripts/assert-no-fake-bytes.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUNDLE_MARKER } from './support/fakeMarker.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'dist')

if (!existsSync(BUNDLE)) process.exit(0)

function* filesUnder(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* filesUnder(path)
    else if (entry.isFile()) yield path
  }
}

const contaminated = [...filesUnder(BUNDLE)].filter((path) => readFileSync(path, 'utf8').includes(BUNDLE_MARKER))

if (contaminated.length > 0) {
  console.error(`Dev-mode bytes shipped: ${BUNDLE_MARKER} appears in ${contaminated.length} bundled file(s).`)
  for (const path of contaminated) console.error(`  dist/${relative(BUNDLE, path)}`)
  console.error('Check that every VITE_FAKE_BLE comparison is written inline and that nothing under src/infrastructure/ble/fake/ is constructed at import time.')
  process.exit(1)
}
