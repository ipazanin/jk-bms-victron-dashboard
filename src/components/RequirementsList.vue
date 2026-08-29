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

// The '?' glyph is aria-hidden, so the announced text must carry the same uncertainty:
// an unknown radio state is 'status unknown', not the false 'not satisfied' a two-way split gives.
const SCREEN_READER_STATUS: Record<Level, string> = {
  ok: 'satisfied',
  blocked: 'not satisfied',
  unknown: 'status unknown',
}

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
    label: 'Devices you have allowed can be listed',
    needed: 'battery',
    level: props.capabilities.canReconnect ? 'ok' : 'blocked',
    remedy:
      'Without it the page cannot reach a pack it has already been given permission for, so every ' +
      'connection starts from the chooser and none of the automatic reconnecting works. In Chrome ' +
      'it lives behind chrome://flags/#enable-web-bluetooth-new-permissions-backend. Permissions ' +
      'granted before that flag was turned on are invisible to it, so pair the pack once more after ' +
      'enabling it.',
  },
  {
    label: 'Advertisement listening enabled',
    needed: 'solar',
    level: props.capabilities.canListenSolar ? 'ok' : 'blocked',
    // A platform that never delivers and a browser that has not been given the flag are both
    // blocked and take entirely different answers: one is a setting away, the other is a machine
    // away. Saying "turn the flag on" to a Linux user would send them after something that cannot
    // help, which is the whole reason this list exists.
    remedy: props.capabilities.platformDeliversAdvertisements
      ? 'The Victron broadcasts rather than accepting a connection, so reading it needs the browser ' +
        'to hear advertisements — by scanning for every device or by watching one picked from the chooser. ' +
        'Both sit behind chrome://flags/#enable-experimental-web-platform-features; turn it on and relaunch. ' +
        'Where the scan is silent, as on macOS, the page uses the chooser instead.'
      : 'Chromium on Linux never delivers an advertisement to a page. Both APIs are present and ' +
        'both resolve, but the layer underneath reports advertisements through an interface the ' +
        'browser does not implement, so nothing ever arrives — no flag and no permission changes ' +
        'it. Reading the controller needs Chrome on Android or macOS. The battery works here as ' +
        'it does anywhere.',
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
        <span class="sr-only">{{ SCREEN_READER_STATUS[item.level] }}</span>
      </li>
    </ul>

    <!-- The standing condition no probe can report on, so it is said rather than measured. It is
         not a row because it is never unsatisfied while anyone is reading it — a list only gets
         looked at by someone whose window is in front. It is still the thing most likely to make
         solar look broken, so it shows whenever solar could work at all, and is withheld when it
         cannot, where the remedy below already carries the whole story. -->
    <!-- Whether the page can put the listening back is a property of the route it took, which this
         list cannot see; only the chooser route hands back a device to go to again. So the teardown
         is stated here, where it is true of every browser, and the promise to undo it is left to the
         solar panel, which knows whether it has a controller to return to. -->
    <p v-if="capabilities.canListenSolar" class="standing">
      <strong>Solar only listens while this window is in front of you.</strong> Every browser tears
      the listening down the moment the tab is hidden or the window loses focus — on every platform,
      by either route — and says nothing about having done it. The battery link is not affected.
    </p>

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

.standing,
.remedies {
  margin-top: 0.75rem;
  border-left: 2px solid var(--gridline);
  padding-left: 0.75rem;
}

.standing {
  margin-bottom: 0;
  font-size: 0.875rem;
  color: var(--ink-secondary);
  max-width: 62ch;
}

.standing strong {
  color: var(--ink);
  font-weight: 600;
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
