<script setup lang="ts">
/**
 * Every precondition this page depends on, and what to do when one is missing.
 *
 * Two of these were previously computed and never shown: whether the Bluetooth radio is
 * switched on, and whether Web Crypto is present. A user whose Bluetooth was off saw only
 * an empty device chooser.
 */
import { computed } from 'vue'

import type { BleCapabilities } from '../infrastructure/ble/capabilities'

const props = defineProps<{
  capabilities: BleCapabilities
  adapterOn: boolean | null
}>()

type Level = 'ok' | 'blocked' | 'unknown'

interface Requirement {
  readonly label: string
  readonly needed: 'battery' | 'solar'
  readonly level: Level
  readonly remedy: string
}

const GLYPHS: Record<Level, string> = { ok: '✓', blocked: '✕', unknown: '?' }

const requirements = computed<Requirement[]>(() => [
  {
    label: 'Browser speaks Web Bluetooth',
    needed: 'battery',
    level: props.capabilities.canConnect ? 'ok' : 'blocked',
    remedy:
      'Firefox and Safari ship no Web Bluetooth, and Mozilla has declined to implement it. ' +
      'Use Chrome or Edge on desktop, Chrome on Android, or Bluefy on iOS.',
  },
  {
    label: 'Page served over HTTPS',
    needed: 'battery',
    level: props.capabilities.secureContext ? 'ok' : 'blocked',
    remedy: 'Bluetooth and Web Crypto are only exposed in a secure context. Open the page over HTTPS.',
  },
  {
    label: 'Bluetooth is switched on',
    needed: 'battery',
    level: props.adapterOn === null ? 'unknown' : props.adapterOn ? 'ok' : 'blocked',
    remedy:
      props.adapterOn === null
        ? 'This browser will not report the radio state. If the chooser stays empty, check Bluetooth is on.'
        : 'Turn Bluetooth on in your system settings, then reload.',
  },
  {
    label: 'Advertisement scanning enabled',
    needed: 'solar',
    level: props.capabilities.canScan ? 'ok' : 'blocked',
    remedy:
      'The Victron broadcasts rather than accepting a connection, so reading it needs scanning. ' +
      'Open chrome://flags/#enable-experimental-web-platform-features, turn it on and relaunch. ' +
      'It exists only on Chrome for Android and macOS — not Windows, Linux or ChromeOS, and not iOS.',
  },
  {
    label: 'Web Crypto available',
    needed: 'solar',
    level: props.capabilities.hasSubtleCrypto ? 'ok' : 'blocked',
    remedy: 'The Victron payload is AES-encrypted. Without crypto.subtle it cannot be decoded.',
  },
])

const blocking = computed(() => requirements.value.filter((item) => item.level !== 'ok'))
</script>

<template>
  <section class="requirements">
    <h3 class="plate">What this page needs</h3>

    <ul>
      <li v-for="item in requirements" :key="item.label" :class="item.level">
        <span class="glyph" aria-hidden="true">{{ GLYPHS[item.level] }}</span>
        <span class="label">
          {{ item.label }}
          <span class="scope">{{ item.needed }}</span>
        </span>
        <span class="sr-only">{{ item.level === 'ok' ? 'satisfied' : 'not satisfied' }}</span>
      </li>
    </ul>

    <div v-if="blocking.length" class="remedies">
      <p v-for="item in blocking" :key="item.label" class="remedy">
        <strong>{{ item.label }}.</strong> {{ item.remedy }}
      </p>
    </div>
    <p v-else class="all-good">Everything this page needs is present.</p>
  </section>
</template>

<style scoped>
.requirements {
  margin-bottom: 1.25rem;
}

h3 {
  margin: 0 0 0.6rem;
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.3rem;
}

li {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
}

.glyph {
  font-weight: 700;
  width: 1ch;
}

li.ok .glyph {
  color: var(--status-good);
}
li.blocked .glyph {
  color: var(--status-critical);
}
li.unknown .glyph {
  color: var(--status-warning);
}

li.blocked .label {
  color: var(--ink);
}

.label {
  color: var(--ink-secondary);
}

.scope {
  font-family: var(--font-label);
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-muted);
  border: 1px solid var(--gridline);
  border-radius: 2px;
  padding: 0 0.3rem;
  margin-left: 0.4rem;
}

.remedies {
  margin-top: 0.75rem;
  border-left: 2px solid var(--gridline);
  padding-left: 0.75rem;
}

.remedy {
  margin: 0 0 0.5rem;
  font-size: 0.875rem;
  color: var(--ink-secondary);
  max-width: 62ch;
}

.remedy:last-child {
  margin-bottom: 0;
}

.remedy strong {
  color: var(--ink);
  font-weight: 600;
}

.all-good {
  margin: 0.6rem 0 0;
  font-size: 0.875rem;
  color: var(--ink-muted);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
