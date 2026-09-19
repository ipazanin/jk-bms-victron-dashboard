<script setup lang="ts">
import { useOfflineApp } from '../application/offlineApp'

const { state, status, updateReady, installed, canInstall, installing, installFailed, install } = useOfflineApp()
</script>

<template>
  <section class="offline-panel card" aria-labelledby="offline-heading">
    <h3 id="offline-heading">Install &amp; offline</h3>
    <p class="status" role="status">{{ status }}</p>
    <p>
      Open Shunt online once and wait for “Ready offline”. Then you can reopen the dashboard and
      saved Log without internet, including from an installed app.
    </p>
    <p v-if="updateReady" role="status">
      An update is ready. When you finish recording, close every Shunt tab and app window, then
      reopen Shunt to use it.
    </p>
    <p v-if="state === 'unavailable'">
      Open Shunt over HTTPS or localhost in a browser that allows offline storage, then reload while
      online. Check the browser’s site storage settings if this keeps happening.
    </p>
    <p v-if="installed">Shunt is running in its own app window.</p>
    <button v-else-if="canInstall || installing" type="button" :disabled="installing" @click="install">
      {{ installing ? 'Opening installer…' : 'Install Shunt' }}
    </button>
    <p v-if="installFailed" role="status">The installer could not open. Use your browser’s install menu.</p>
    <p v-if="!installed && !canInstall && !installing">
      Use your browser’s Install app or Add to Home Screen menu if offered. In Safari, use Share →
      Add to Home Screen on iPhone or iPad, or File → Add to Dock on Mac. Firefox on Mac can use the
      offline page in a normal tab.
    </p>
    <p>
      Bluetooth still needs a supported browser and nearby devices. Firefox and Safari cannot
      connect directly to the radios. Reloading ends the Bluetooth connection; saved readings stay
      marked as remembered until fresh readings arrive. Recording needs the app to remain running.
    </p>
    <p>
      Your key, readings and Log stay in this browser. Clearing site data removes them and the
      offline copy. Private browsing may keep them only until the window closes. Download important
      sessions from the Log as JSON.
    </p>
  </section>
</template>

<style scoped>
.offline-panel {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.85rem;
  padding: var(--pad);
}

h3, p { margin: 0; }
h3 { font-size: 1.05rem; }
p { max-width: 75ch; font-size: var(--text-copy); color: var(--ink-secondary); }
.status { color: var(--ink); font-weight: 600; }
button {
  min-height: var(--tap);
  padding: 0.45rem 1rem;
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  background: var(--raised);
  color: var(--ink);
  font: inherit;
}
button:disabled { opacity: 0.6; }
</style>
