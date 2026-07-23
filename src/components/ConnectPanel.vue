<script setup lang="ts">
import { computed, ref } from 'vue'

import RequirementsList from './RequirementsList.vue'
import type { BleCapabilities } from '../infrastructure/ble/capabilities'
import { hashOf } from '../application/route'
import type { LinkState, Source } from '../application/telemetry'

const props = defineProps<{
  capabilities: BleCapabilities
  adapterOn: boolean | null
  source: Source
  bmsState: LinkState
  solarState: LinkState
  bmsError: string | null
  solarError: string | null
  foreignDeviceSeen: boolean
  initialKey: string
}>()

const emit = defineEmits<{
  connectBms: [showAllDevices: boolean]
  disconnectBms: []
  startSolar: [key: string]
  stopSolar: []
}>()

const advertisementKey = ref(props.initialKey)
const revealKey = ref(false)
const showAllDevices = ref(false)

const logHref = hashOf({ name: 'log' })

/**
 * The gate has to forgive exactly what parseAdvertisementKey forgives. VictronConnect shows the
 * key in spaced pairs, so a pasted key is routinely 47 characters of perfectly good hex, and a
 * button measuring the raw field refuses it while the parser behind it would not — greyed out,
 * with nothing on screen saying why.
 */
const normalisedKey = computed(() => advertisementKey.value.trim().toLowerCase().replace(/\s+/g, ''))
const keyLooksComplete = computed(() => /^[0-9a-f]{32}$/.test(normalisedKey.value))
</script>

<template>
  <section class="panel">
    <h2 class="plate">Connect</h2>

    <RequirementsList :capabilities="capabilities" :adapter-on="adapterOn" />

    <p class="notice">
      <strong>Close the JK app on your phone first.</strong> The BMS accepts one Bluetooth
      connection at a time, so while the app holds it, nothing else can connect.
    </p>

    <div class="actions">
      <button
        v-if="bmsState !== 'live'"
        type="button"
        class="primary"
        :disabled="!capabilities.canConnect || bmsState === 'connecting'"
        @click="emit('connectBms', showAllDevices)"
      >
        {{ bmsState === 'connecting' ? 'Connecting…' : 'Connect BMS' }}
      </button>
      <button v-else type="button" @click="emit('disconnectBms')">Disconnect BMS</button>

      <!-- Withheld only while a stored session is on the instruments: the log is where that
           session was opened from, and the banner above already carries the way back. -->
      <a v-if="source !== 'history'" class="button" :href="logHref">Browse the log</a>
    </div>

    <label v-if="capabilities.canConnect && bmsState !== 'live'" class="checkbox">
      <input v-model="showAllDevices" type="checkbox" />
      Show every nearby device — use this if your BMS doesn’t appear
    </label>

    <p v-if="bmsError" class="error">{{ bmsError }}</p>

    <div class="solar">
      <h3 class="plate">Solar controller</h3>

      <p v-if="!capabilities.canScan || !capabilities.hasSubtleCrypto" class="notice">
        The solar controller can’t be read in this browser. See <em>What this page needs</em>
        above — the battery works regardless, it just can’t show house load.
      </p>

      <template v-else>
        <label class="field">
          <span>Instant Readout encryption key</span>
          <span class="input-row">
            <input
              v-model="advertisementKey"
              :type="revealKey ? 'text' : 'password'"
              autocomplete="off"
              spellcheck="false"
              placeholder="32 hex characters"
              :disabled="solarState === 'live'"
            />
            <button type="button" class="ghost" @click="revealKey = !revealKey">
              {{ revealKey ? 'Hide' : 'Show' }}
            </button>
          </span>
        </label>

        <p class="hint">
          Find it in VictronConnect: connect to the controller, tap the gear icon, then Product info,
          then Instant readout via Bluetooth. It is not the Bluetooth PIN. It stays in this browser
          and is never sent anywhere.
        </p>

        <!-- Cancel stops this page listening; it cannot withdraw a permission prompt the browser
             has already put up. Allowing that prompt afterwards starts the scan, and the panel
             then says it is listening. -->
        <div class="actions">
          <button
            v-if="solarState === 'idle'"
            type="button"
            :disabled="!keyLooksComplete"
            @click="emit('startSolar', normalisedKey)"
          >
            Connect solar
          </button>
          <button v-else type="button" @click="emit('stopSolar')">
            {{ solarState === 'connecting' ? 'Cancel' : 'Stop solar' }}
          </button>
        </div>

        <p v-if="solarState === 'connecting'" class="hint">
          Your browser is asking whether this page may scan for nearby Bluetooth devices. Allow it
          to start listening; dismissing the prompt cancels.
        </p>

        <p v-if="solarState === 'listening' && !foreignDeviceSeen" class="hint">
          Listening. Nothing has answered yet — the controller may be out of range.
        </p>
        <p v-if="solarState === 'listening' && foreignDeviceSeen" class="error">
          Receiving Victron broadcasts, but none match this key. They belong to other
          devices nearby. Check the key against VictronConnect.
        </p>
      </template>

      <p v-if="solarError" class="error">{{ solarError }}</p>
    </div>
  </section>
</template>

<style scoped>
.panel {
  padding: var(--pad);
  border-top: 1px solid var(--gridline);
}

h2,
h3 {
  margin: 0 0 0.75rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin: 0.75rem 0;
}

/* The log link is an anchor so it can be opened in a new tab and copied, and wears the button
   shape so the row of controls reads as one row. */
button,
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--baseline);
  color: var(--ink);
  text-decoration: none;
  border-radius: var(--radius);
  padding: 0.6rem 1rem;
  min-height: var(--tap);
  font-family: var(--font-label);
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 600;
}

button:hover:not(:disabled),
.button:hover {
  border-color: var(--ink-secondary);
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* --pack is a mark colour and this is a label on a fill: white on it measures 3.21:1 at 13px/600,
   which is normal-size text on the page's main control. The ink pair is the one that clears AA. */
button.primary {
  background: var(--pack-ink);
  border-color: var(--pack-ink);
  color: var(--on-pack);
}

button.ghost {
  padding: 0.35rem 0.6rem;
  border-color: var(--gridline);
  color: var(--ink-secondary);
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--ink-secondary);
}

.solar {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--gridline);
}

.field {
  display: grid;
  gap: 0.35rem;
  max-width: 30rem;
}

.field > span:first-child {
  font-family: var(--font-label);
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-secondary);
}

.input-row {
  display: flex;
  gap: 0.5rem;
}

input[type='password'],
input[type='text'] {
  flex: 1;
  min-width: 0;
  background: var(--raised);
  border: 1px solid var(--gridline);
  color: var(--ink);
  border-radius: var(--radius);
  padding: 0.6rem 0.7rem;
  font-family: var(--font-mono);
  font-size: 0.875rem;
}

.notice,
.hint {
  margin: 0.5rem 0;
  font-size: 0.875rem;
  color: var(--ink-secondary);
  max-width: 62ch;
}

.notice strong {
  color: var(--ink);
  font-weight: 600;
}

.hint {
  color: var(--ink-muted);
}

.error {
  margin: 0.5rem 0 0;
  font-size: 0.875rem;
  color: var(--status-serious);
}

code {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  background: var(--raised);
  padding: 0.1rem 0.3rem;
  border-radius: 2px;
  overflow-wrap: anywhere;
}
</style>
