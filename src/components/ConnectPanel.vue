<script setup lang="ts">
import { ref } from 'vue'

import type { BleCapabilities } from '../infrastructure/ble/capabilities'
import type { LinkState, Source } from '../application/telemetry'

const props = defineProps<{
  capabilities: BleCapabilities
  source: Source
  bmsState: LinkState
  solarState: LinkState
  bmsError: string | null
  solarError: string | null
  initialKey: string
}>()

const emit = defineEmits<{
  connectBms: [showAllDevices: boolean]
  disconnectBms: []
  startSolar: [key: string]
  stopSolar: []
  startDemo: []
  stopDemo: []
}>()

const advertisementKey = ref(props.initialKey)
const revealKey = ref(false)
const showAllDevices = ref(false)
</script>

<template>
  <section class="panel">
    <h2 class="plate">Connect</h2>

    <p v-if="!capabilities.hasBluetooth" class="notice">
      This browser can’t reach the battery over Bluetooth. Firefox and Safari don’t implement
      Web Bluetooth at all. Use Chrome or Edge on desktop, Chrome on Android, or Bluefy on iOS —
      or watch the demo below.
    </p>
    <p v-else-if="!capabilities.secureContext" class="notice">Open this page over HTTPS to use Bluetooth.</p>

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

      <button v-if="source !== 'demo'" type="button" @click="emit('startDemo')">Play demo</button>
      <button v-else type="button" @click="emit('stopDemo')">Stop demo</button>
    </div>

    <label v-if="capabilities.canConnect && bmsState !== 'live'" class="checkbox">
      <input v-model="showAllDevices" type="checkbox" />
      Show every nearby device — use this if your BMS doesn’t appear
    </label>

    <p v-if="bmsError" class="error">{{ bmsError }}</p>

    <div class="solar">
      <h3 class="plate">Solar controller</h3>

      <p v-if="!capabilities.canScan" class="notice">
        Reading the Victron needs Bluetooth advertisement scanning, which Chrome keeps behind a
        flag. Open <code>chrome://flags/#enable-experimental-web-platform-features</code>, turn it
        on, and reload. It works on Chrome for Android and macOS only.
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

        <div class="actions">
          <button
            v-if="solarState !== 'live'"
            type="button"
            :disabled="advertisementKey.trim().length !== 32 || solarState === 'connecting'"
            @click="emit('startSolar', advertisementKey)"
          >
            {{ solarState === 'connecting' ? 'Scanning…' : 'Connect solar' }}
          </button>
          <button v-else type="button" @click="emit('stopSolar')">Stop solar</button>
        </div>
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

button {
  background: transparent;
  border: 1px solid var(--baseline);
  color: var(--ink);
  border-radius: var(--radius);
  padding: 0.6rem 1rem;
  min-height: 44px;
  font-family: var(--font-label);
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 600;
}

button:hover:not(:disabled) {
  border-color: var(--ink-secondary);
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

button.primary {
  background: var(--pack);
  border-color: var(--pack);
  color: #ffffff;
}

button.ghost {
  min-height: 0;
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
  max-width: 56ch;
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
