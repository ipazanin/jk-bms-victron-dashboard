/**
 * Which name this build claims a piece of browser state under.
 *
 * The fake-radio dev mode is served from the same origin as the real page — both are
 * `http://localhost:5173`, and the boat is worked on from that origin — so every store the browser
 * scopes by origin and name is one shared drawer, and playback would write straight over the state
 * the real page depends on. Two localStorage entries are expensive to lose: the Victron encryption
 * key is thirty-two characters that can only be read back out of VictronConnect, and the remembered
 * session is what the dashboard paints at first load, before it has talked to any hardware at all.
 * The recording lease is a Web Lock and shares the same trap, held rather than written: one name
 * lets a playback session keep the real page from recording. Under the flag each gets its own
 * suffixed name, so a playback session and a real one never meet.
 *
 * The theme and the sidebar are deliberately left unsuffixed. They are chrome — preferences about
 * this browser rather than claims about a boat — and a dev tab that forgets the owner's theme is a
 * worse bug than one that shares it.
 *
 * The comparison is written in place rather than behind a shared constant, for the reason
 * `scripts/assert-no-fake-bytes.mjs` gives.
 */

export function storageKey(name: string): string {
  return import.meta.env.VITE_FAKE_BLE === 'true' ? `${name}.fake` : name
}
