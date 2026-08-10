import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { BUNDLE_MARKER } from '../scripts/support/fakeMarker.mjs'

const MARKER_CUSTOM_PROPERTY = /--fake-marker:\s*'([^']+)'/

describe('the marker a production build is grepped for', () => {
  it('is spelled in the dev panel exactly as the grep spells it', () => {
    // Read as text: a `<style>` block never reaches the test runner, so there is no rendered value
    // to assert on.
    const panel = readFileSync(
      new URL('../src/components/dev/DevControlPanel.vue', import.meta.url),
      'utf8',
    )

    expect(MARKER_CUSTOM_PROPERTY.exec(panel)?.[1]).toBe(BUNDLE_MARKER)
  })
})
