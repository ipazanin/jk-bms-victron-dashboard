/**
 * The build-time environment this app reads, declared so a misspelled variable is a compile error
 * rather than silently `undefined`.
 *
 * Vite's own `ImportMetaEnv` indexes every unknown key as `any` unless `strictImportMetaEnv` is
 * declared on `ViteTypeOptions`. Declaring it here turns that index signature off, which is the whole
 * point: `import.meta.env.VITE_FAKE_BLE` is compared against the string `'true'` at several sites, and
 * a typo at any one of them would otherwise read as a permanently false branch that no test can see.
 *
 * The value is typed `'true'` rather than `string` because that is the only value `.env.fake` ever
 * sets, and the flag is absent — not `'false'` — in every other mode.
 */

interface ViteTypeOptions {
  strictImportMetaEnv: unknown
}

interface ImportMetaEnv {
  readonly VITE_FAKE_BLE?: 'true'
}
