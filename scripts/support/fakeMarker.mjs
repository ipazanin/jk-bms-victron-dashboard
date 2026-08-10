/**
 * The sentinel that says a byte of the fake-BLE dev mode reached a production bundle.
 *
 * The string means nothing by itself. All it is worth is that every spelling of it agrees: the
 * playback fixture carries it, the dev panel's stylesheet carries it, and the build greps a bundle
 * for it. Spelled two ways, the grep goes quiet over exactly the route it was written to catch, and
 * neither file looks wrong on its own. So everything that can import takes the string from here.
 *
 * The panel is the one carrier that cannot: a CSS custom property imports nothing, so its literal is
 * held to this one by `tests/devPanelMarker.spec.ts`, which reads the component as text.
 */

export const BUNDLE_MARKER = 'FAKE-BLE-ONLY-DO-NOT-SHIP'
