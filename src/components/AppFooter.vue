<script setup lang="ts">
// Static footer: no props, no emits. The privacy paragraph is the product's core promise,
// stated verbatim so it never drifts from what the app actually does.
</script>

<template>
  <footer class="app-footer" data-testid="app-footer">
    <p class="privacy">
      Nothing leaves this page. It makes no network request after it loads: no backend, no
      telemetry, no analytics. Your encryption key and your log stay in this browser.
    </p>
    <p class="colophon">
      <span>Domain Software Solutions d.o.o</span>
      <span class="sep" aria-hidden="true">·</span>
      <a class="mail" href="mailto:ivan.pazanin1996@gmail.com">ivan.pazanin1996@gmail.com</a>
      <span class="sep" aria-hidden="true">·</span>
      <span>Free to use</span>
      <span class="sep" aria-hidden="true">·</span>
      <span>MIT license</span>
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

.mail {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  padding-inline: 0.35rem;
  margin-inline: -0.35rem;
  color: var(--ink-secondary);
  text-decoration: none;
}

.mail:hover {
  color: var(--ink);
  text-decoration: underline;
}
</style>
