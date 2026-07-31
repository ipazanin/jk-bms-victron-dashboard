import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// The plugin is here so a spec can mount a view and read what it actually paints. Nothing else in
// the suite needs it: everything below the components is plain TypeScript and stays that way.
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
