/**
 * Lets a plain `node` script import this repo's TypeScript modules by their source specifier.
 *
 * Node strips the types out of a `.ts` file on its own, but it will not guess at an extension the
 * specifier does not carry, and every relative import in `src/` is written without one — so
 * `decode.ts` fails on its own `import { MAX_CELLS } from './protocol'` before a single byte is
 * decoded. The alternative is a bundler in the dev dependencies to run one development script,
 * which is a large answer to a small problem.
 *
 * Only extensionless relative specifiers are touched. A bare package name, a `node:` builtin and
 * anything that already names a file all go to the next resolver untouched, so a mistyped import
 * still fails as a mistyped import rather than as a missing `.ts`.
 *
 *   node --import ./scripts/support/typescriptResolve.mjs scripts/<script>.mjs
 */

import { registerHooks } from 'node:module'

const RELATIVE = /^\.\.?\//
const HAS_EXTENSION = /\.[^./]+$/

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (RELATIVE.test(specifier) && !HAS_EXTENSION.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})
