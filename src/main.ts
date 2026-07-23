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
