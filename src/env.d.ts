/** Strict environment keys make misspelled build configuration a compile error. */

interface ViteTypeOptions {
  strictImportMetaEnv: unknown
}

interface ImportMetaEnv {
  readonly VITE_FAKE_BLE?: 'true'
  readonly VITE_GOOGLE_CLIENT_ID?: string
  readonly VITE_GOOGLE_API_KEY?: string
  readonly VITE_GOOGLE_PROJECT_NUMBER?: string
}
