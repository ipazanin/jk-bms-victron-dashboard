<script setup lang="ts">
import { computed, ref } from 'vue'

import RequirementsList from './RequirementsList.vue'
import type { BleCapabilities } from '../infrastructure/ble/capabilities'
import { rejoinBlockerNote } from '../application/rejoinBlockerNote'
import type { RejoinBlocker } from '../application/RejoinBlocker'
import { solarRejectionNote } from '../application/solarRejectionNote'
import type { SolarAdvertisementRejection } from '../domain/solar/SolarAdvertisementRejection'
import type { SolarAdvertisementSource } from '../domain/solar/SolarAdvertisementSource'
import { hashOf } from '../application/route'
import type { LinkState, Source } from '../application/telemetry'

const props = defineProps<{
  capabilities: BleCapabilities
  adapterOn: boolean | null
  source: Source
  bmsState: LinkState
  solarState: LinkState
  /** The pack banner as the application layer says it should read, silences already applied. */
  bmsBanner: string | null
  solarError: string | null
  /** Why the last advertisement did not decode, or null while nothing has failed to. */
  solarRejection: SolarAdvertisementRejection | null
  /** Which radio heard it, which is what decides whether the reason is about this boat at all. */
  solarRejectionSource: SolarAdvertisementSource
  initialKey: string
  /** True when a last pack is remembered and this browser can rejoin it without the chooser. */
  canReconnect: boolean
  /** The remembered pack's name for the reconnect button, or null when it has none. */
  reconnectName: string | null
  /** Whether this browser goes back to the pack on its own, as the owner last answered it. */
  rejoinArmed: boolean
  /** Looking for the pack right now, backoff waits included. Never an error — it is working. */
  rejoinSearching: boolean
  /** The one thing standing in the way that the owner could act on, or null while none is. */
  rejoinBlocker: RejoinBlocker | null
  /** The controller's side of the same two, and the name to call it by. */
  solarRejoinSearching: boolean
  solarRejoinBlocker: RejoinBlocker | null
  controllerName: string | null
}>()

const emit = defineEmits<{
  connectBms: [showAllDevices: boolean]
  reconnectBms: []
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

/**
 * What each radio is called in a sentence about it. A pack that advertised no name still has to be
 * referred to as something, and "the pack" is the honest stand-in — inventing an identifier out of
 * the opaque browser id would name a thing the owner has never seen.
 */
const packSubject = computed(() => props.reconnectName ?? 'the pack')
const controllerSubject = computed(() => props.controllerName ?? 'the controller')

const packBlockerNote = computed(() =>
  props.rejoinBlocker === null ? null : rejoinBlockerNote(props.rejoinBlocker, packSubject.value),
)
/**
 * The same sentence, for the browser that has nothing to report a blocker about yet: no permitted
 * device list means no automatic anything, whether or not a pack has ever been connected here.
 */
const packCannotRejoinNote = computed(() =>
  rejoinBlockerNote('browser-cannot-rejoin', packSubject.value),
)
const solarBlockerNote = computed(() =>
  props.solarRejoinBlocker === null
    ? null
    : rejoinBlockerNote(props.solarRejoinBlocker, controllerSubject.value),
)
const solarRejectionSentence = computed(() =>
  props.solarRejection === null
    ? null
    : solarRejectionNote(props.solarRejection, props.solarRejectionSource),
)
/**
 * A rejection is only the owner's to act on when the radio that heard it was following their own
 * controller. Heard off the marina it is news about somebody else's equipment, and the error slot
 * is reserved for what the owner has to do something about.
 */
const solarRejectionIsTheirs = computed(() => props.solarRejectionSource === 'this-controller')
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
      <button v-if="bmsState === 'live'" type="button" @click="emit('disconnectBms')">
        Disconnect BMS
      </button>
      <!-- An attempt in flight always has the way out beside it. A reconnect waits on the pack
           being heard from, which on a boat can be minutes, and a row that offered nothing but a
           disabled button would leave a page reload as the owner's only move. -->
      <template v-else-if="bmsState === 'connecting'">
        <button type="button" class="primary" disabled>Connecting…</button>
        <button type="button" @click="emit('disconnectBms')">Cancel</button>
      </template>
      <template v-else>
        <!-- The remembered pack, rejoined without the chooser. Primary when it exists; the chooser
             is then the escape hatch for connecting a different pack. -->
        <button
          v-if="canReconnect"
          type="button"
          class="primary"
          :disabled="!capabilities.canConnect"
          @click="emit('reconnectBms')"
        >
          Reconnect to {{ reconnectName ?? 'last pack' }}
        </button>
        <button
          type="button"
          :class="{ primary: !canReconnect }"
          :disabled="!capabilities.canConnect"
          @click="emit('connectBms', showAllDevices)"
        >
          {{ canReconnect ? 'Choose a different pack' : 'Connect BMS' }}
        </button>
      </template>

      <!-- Withheld only while a stored session is on the instruments: the log is where that
           session was opened from, and the banner above already carries the way back. -->
      <a v-if="source !== 'history'" class="button" :href="logHref">Browse the log</a>
    </div>

    <!-- What Disconnect actually does, said next to the button rather than discovered afterwards.
         It is the one control on this page that changes what the page will do tomorrow, and it is
         one answer about the boat rather than about a radio: the controller stops coming back too,
         so a page naming only the pack would be understating the press. -->
    <p v-if="bmsState === 'live'" class="hint">
      Disconnect drops the link <em>and</em> stops this page going back to {{ packSubject }} on its
      own<template v-if="controllerName !== null">, {{ controllerSubject }} with it</template>. It
      stays off until you connect again.
    </p>

    <!-- A blocker is the page saying it has stopped; the promise below is the page saying it has
         not. Whichever is true, only one of them may be on screen, so the promise yields to it. -->
    <template v-if="canReconnect && bmsState !== 'live'">
      <p v-if="rejoinArmed && rejoinBlocker === null" class="hint">
        Reconnect rejoins the pack you used last without the chooser. It is only ever a shortcut:
        while this page is in front of you it keeps looking for {{ packSubject }} by itself, and
        goes live the moment the pack answers.
      </p>
      <p v-else-if="!rejoinArmed" class="hint">
        You pressed Disconnect, so this page has stopped looking for {{ packSubject }}. Connecting
        again is what turns that back on.
      </p>
    </template>

    <!-- Quiet, and never the error slot: a pack behind a bulkhead or halfway up the pontoon is the
         ordinary case on a boat, and the honest thing to show for it is that the search is running. -->
    <p v-if="rejoinSearching" class="searching">
      <span class="pulse" aria-hidden="true" />
      Looking for {{ packSubject }}…
    </p>

    <p v-if="packBlockerNote" class="hint acting">{{ packBlockerNote }}</p>
    <!-- A browser with no list of allowed devices is never promised anything automatic, whether or
         not a pack has ever been connected on it — and it is the same condition the blocker above
         reports once one has been, so it is said in the same words. -->
    <p v-else-if="capabilities.canConnect && !capabilities.canReconnect" class="hint acting">
      {{ packCannotRejoinNote }}
    </p>

    <label v-if="capabilities.canConnect && bmsState !== 'live'" class="checkbox">
      <input v-model="showAllDevices" type="checkbox" />
      Show every nearby device — use this if your BMS doesn’t appear
    </label>

    <p v-if="bmsBanner" class="error">{{ bmsBanner }}</p>

    <div class="solar">
      <h3 class="plate">Solar controller</h3>

      <p v-if="!capabilities.canListenSolar || !capabilities.hasSubtleCrypto" class="notice">
        The solar controller can’t be read in this browser. See <em>What this page needs</em>
        above — the battery works regardless, it just can’t show boat load.
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

        <!-- Cancel stops this page listening; it cannot withdraw a prompt the browser has already
             put up. Answering that prompt afterwards — allowing the scan, or picking the
             controller — starts the listen, and the panel then says it is listening. -->
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

        <!-- Stop solar is the controller's Disconnect, and it forgets which controller this was —
             otherwise the page would put the watch straight back up a second later. -->
        <p v-if="solarState === 'listening' || solarState === 'live'" class="hint">
          Stop solar ends the listening <em>and</em> forgets {{ controllerSubject }}, so the page
          will not go back to it until you press Connect solar again.
        </p>

        <!-- The pack's pair, said about the controller. Disconnect disarms the one intent both
             radios read, so a promise made without asking it would be a promise about the wrong
             half of the boat. -->
        <template v-if="solarState === 'idle' && controllerName !== null">
          <p v-if="rejoinArmed && solarRejoinBlocker === null" class="hint">
            Connect solar is a one-off. After it, this page puts the listening back up by itself
            whenever it is in front of you — no chooser, no key to type again.
          </p>
          <p v-else-if="!rejoinArmed" class="hint">
            You pressed Disconnect, so this page has stopped listening for
            {{ controllerSubject }} by itself. Connect solar turns that back on, and the pack with
            it.
          </p>
        </template>

        <p v-if="solarRejoinSearching" class="searching">
          <span class="pulse" aria-hidden="true" />
          Listening again for {{ controllerSubject }}…
        </p>

        <p v-if="solarBlockerNote" class="hint acting">{{ solarBlockerNote }}</p>

        <!-- Only ever true of a press: a watch this page put back up by itself raises no prompt at
             all, and telling the owner to answer one that is not there is worse than silence. -->
        <p v-if="solarState === 'connecting' && !solarRejoinSearching" class="hint">
          Your browser is asking about nearby Bluetooth devices. Allow the scan, or pick the
          controller from the list, to start listening; dismissing the prompt cancels.
        </p>

        <p v-if="solarState === 'listening' && solarRejectionSentence === null" class="hint">
          Listening. Nothing has answered yet — the controller may be out of range.
        </p>
        <!-- Which of the three reasons it was is decided in the domain, where the bytes are, and
             whose broadcast it could have been by the transport, which is the only place that is
             known. The panel prints the sentence they make between them, and files it as an error
             only when the radio was following this boat's own controller. -->
        <p
          v-else-if="solarState === 'listening'"
          :class="solarRejectionIsTheirs ? 'error' : 'hint'"
        >
          {{ solarRejectionSentence }}
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
  border: 1px solid var(--card-border);
  color: var(--ink);
  text-decoration: none;
  border-radius: var(--r-sm);
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
  border-color: var(--card-border);
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
  border: 1px solid var(--card-border);
  color: var(--ink);
  border-radius: var(--r-sm);
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

/* Something the owner has to do about it — a chooser tap, a radio switched on. Full ink rather than
   the error red: none of these is a fault, and painting them as one is what the boat asked us to
   stop doing. */
.hint.acting {
  color: var(--ink);
}

/* The search running, which is work rather than a fault, so it wears the ordinary copy colour and
   the annunciator's unassessed pulse instead of anything in the status palette. */
.searching {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.5rem 0;
  font-size: 0.875rem;
  color: var(--ink-secondary);
}

.pulse {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--ink-muted);
  animation: breathe 2.4s ease-in-out infinite;
}

@keyframes breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
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
