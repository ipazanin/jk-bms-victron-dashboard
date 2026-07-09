import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Project site: https://ipazanin.github.io/jk-bms-victron-dashboard/
// The leading and trailing slashes are both required, or every asset 404s once deployed.
export default defineConfig({
  base: '/jk-bms-victron-dashboard/',
  plugins: [vue()],
})
