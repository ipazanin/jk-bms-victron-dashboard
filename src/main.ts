import '@fontsource/saira-semi-condensed/600.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'

import './styles/tokens.css'

import { createApp } from 'vue'
import App from './App.vue'
import { applyInitialTheme } from './application/theme'

// Before the mount, not inside it: the stylesheet's :root is the dark plane, so resolving this
// from a component would paint dark and correct itself a frame later for anyone who chose light.
applyInitialTheme()

createApp(App).mount('#app')

// A build serving playback radios carries the controls for them, in a host outside #app and mounted
// as an application of its own; DevControlPanel.vue says what that placement buys. Fetched rather
// than imported for the reason loadPlaybackFixture.ts gives — a development server folds no flag —
// which is what makes this a load that can fail.
if (import.meta.env.VITE_FAKE_BLE === 'true') {
  const host = document.createElement('div')
  host.id = 'dev-controls'
  document.body.append(host)

  void import('./components/dev/DevControlPanel.vue')
    .then((panel) => createApp(panel.default).mount(host))
    // Catching after the mount, not as the second argument to then: a panel that throws while
    // mounting fails in the handler itself, and a rejection handler passed alongside cannot see it.
    // Both halves are the one failure the panel cannot report, being the panel. So it is written
    // into the host the panel would have filled: a build serving playback radios with no controls on
    // it is indistinguishable from the real dashboard, and nobody opens a console to find out why a
    // page looks exactly as it should. The tokens are in the document already, so this paints in
    // whichever theme is up.
    .catch((rejection: unknown) => {
      const cause = rejection instanceof Error ? rejection.message : String(rejection)
      host.style.cssText =
        'position:fixed;right:0;bottom:0;left:0;z-index:70;padding:0.75rem 1rem;' +
        'background:var(--surface);border-top:1px solid var(--card-border);' +
        'color:var(--status-critical-ink);font-family:var(--font-body);font-size:0.8125rem'
      host.textContent = `The fake radio controls would not load — ${cause}`
    })
}
