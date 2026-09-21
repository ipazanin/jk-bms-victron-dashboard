<script setup lang="ts">
import { useOfflineApp } from '../application/offlineApp'

const { state, status, updateReady } = useOfflineApp()
</script>

<template>
  <footer class="app-footer" data-testid="app-footer">
    <p v-if="state !== 'development'" class="privacy" data-testid="offline-status" role="status">
      <a href="#/connect">{{ status }}</a>
      <span v-if="updateReady"> · Update ready. Finish recording, close all Shunt windows, then reopen.</span>
    </p>
    <p class="privacy">
      Your encryption key and your log stay in this browser. Shunt downloads app files for offline
      use and checks for updates. No backend, telemetry or analytics.
    </p>
    <p class="colophon">
      <span>Domain Software Solutions d.o.o</span>
      <span class="sep" aria-hidden="true">·</span>
      <a href="mailto:ivan.pazanin1996@gmail.com">ivan.pazanin1996@gmail.com</a>
      <span class="sep" aria-hidden="true">·</span>
      <span>Free to use</span>
      <span class="sep" aria-hidden="true">·</span>
      <span>MIT license</span>
      <span class="sep" aria-hidden="true">·</span>
      <a href="https://github.com/ipazanin/jk-bms-victron-dashboard" target="_blank" rel="noopener noreferrer">
        Source on GitHub
      </a>
      <span class="sep" aria-hidden="true">·</span>
      <a href="https://buymeacoffee.com/ipazanin" target="_blank" rel="noopener noreferrer">
        Buy me a coffee
      </a>
    </p>
  </footer>
</template>

<style scoped>
.app-footer {
  border-top: 1px solid var(--card-border);
  padding: 1.5rem clamp(1rem, 3.5vw, 2.5rem) 2rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.privacy {
  font-family: var(--font-body);
  font-size: var(--text-copy);
  color: var(--ink-secondary);
  max-width: 70ch;
  margin: 0;
}

.privacy a {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  color: var(--ink-secondary);
}

.colophon {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--ink-muted);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
}

.sep {
  color: var(--ink-muted);
}

.colophon a {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  padding-inline: 0.35rem;
  margin-inline: -0.35rem;
  color: var(--ink-secondary);
  text-decoration: none;
}

.colophon a:hover {
  color: var(--ink);
  text-decoration: underline;
}
</style>
