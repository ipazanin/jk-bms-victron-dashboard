# Shunt — a JK-BMS + Victron dashboard in your browser

A static, installable web app that talks Bluetooth directly to a **JK-BMS** and a **Victron SmartSolar MPPT**,
and reconciles them. No account, no backend, no cloud.

**[Open it →](https://ipazanin.github.io/jk-bms-victron-dashboard/)** — needs Chrome or Edge and the
two radios. With no hardware you get the instrument drawn empty, the copy explaining what it will
show, and nothing else: no numbers, no charge figure, no sample data. The page shows what its own
radios recorded, and until they have recorded something there is nothing honest to draw.

`npm run check:visual` renders the dashboard and Log from the built app, driving a recorded session
through the same `localStorage` and IndexedDB the page uses in the field. It generates local
screenshots in `docs/`.

---

## The point

Your charge controller knows what the panels make. Your BMS knows what the pack does. Neither
knows what the *boat* is drawing.

Difference them and you do:

```
house = solar − pack        7.9 A − (−8.4 A) = 16.3 A ≈ 222 W
```

That is a house-load meter on your DC bus, derived from two radios you already own, without
installing a shunt. Neither the VictronConnect app nor the JK app can show it, because each sees
only one half of the bus.

The dashboard makes this the hero: **one centre-zero current axis.** The pack bar runs from zero to
its own signed current, the solar bar from zero to what the panels deliver, and the house load is
the *span between the two tips*. It reads the same whether the pack is charging or discharging.

## Hardware

| Device | Transport | Auth |
|---|---|---|
| JK-BMS (tested: `JK-B2A8S20P`, fw 19.10, 4S) | GATT connection, service `0xFFE0`, characteristic `0xFFE1` | none — no PIN, no pairing |
| Victron SmartSolar MPPT (tested: 100/50) | "Instant Readout" BLE advertisement, company id `0x02E1` | AES-CTR, per-device encryption key |

Other JK models on the same `55 AA EB 90` protocol should work. Other Victron products broadcast
different record types and are **not** decoded — only the solar-charger record (`0x01`) is.

## Browser support — read this before filing an issue

Installing Shunt does not add Bluetooth APIs to a browser. Direct Bluetooth access needs a
supported Chromium browser or a specialist browser such as Bluefy; offline viewing works more widely.

| Browser | Battery (GATT) | Solar (live advertisements) |
|---|---|---|
| Chrome / Edge, macOS | ✅ | ⚠️ flagged — pick the controller from the chooser, or [the bridge](bridge/README.md) for no tap |
| Chrome, Android | ✅ | ⚠️ behind a flag |
| Chrome / Edge, Windows · ChromeOS | ✅ | ⚠️ flagged, untested here — both routes exist; the page takes whichever this browser reports |
| Chrome / Edge, Linux | ✅ | ❌ nothing is ever delivered — see below |
| Firefox, any platform | ❌ | ❌ |
| Safari, macOS & iOS | ❌ | ❌ |
| Bluefy (iOS) | ✅ | ❌ neither route |

- **Firefox and Safari have no native Web Bluetooth.** Their offline app shell and browser storage
  work, but installing the page cannot enable direct radio access. See the
  [Web Bluetooth implementation status](https://github.com/whatwg/bluetooth/blob/main/implementation-status.md).
  On iOS, [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) provides the battery
  GATT connection; installing Shunt in Safari does not inherit Bluefy's Bluetooth support.
- **Solar needs a flag.** Both routes to a live advertisement — the device-free scan
  (`requestLEScan`) and watching one chosen device (`watchAdvertisements`) — sit behind
  `chrome://flags/#enable-experimental-web-platform-features`. The page detects each separately and
  offers solar if either exists. Per the
  [WebBluetoothCG implementation status](https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md)
  the scan is listed for **Android and macOS**, but the macOS entry is an open implementation issue
  ([crbug.com/897312](https://crbug.com/897312)).
- **On macOS the scan is silent, so the page watches one device instead.** The flag is honoured and
  the permission dialog appears, but it sits on *Scanning…* with an empty device list forever. So on
  a Mac **Connect solar** raises the ordinary Bluetooth chooser: pick your controller and the page
  reads its advertisements through the browser's own radio. That tap is once per browser, not once
  per page load — afterwards the page puts the listening back up by itself, as
  [Staying connected](#staying-connected) describes. The battery is unaffected either way; GATT
  works fine on macOS.
- **Reconnecting on its own needs a second flag**,
  `chrome://flags/#enable-web-bluetooth-new-permissions-backend`, and one more pairing after you
  turn it on — see [Staying connected](#staying-connected). Without it the battery still works; it
  just starts from the chooser every time.
- **Linux never delivers an advertisement**, by either route, however many flags are on. BlueZ hands
  advertisement data to Chromium through a raw-EIR callback the Web Bluetooth service does not
  implement, so the observer never fires and both APIs sit there resolving into silence. The page
  detects the platform and withholds the solar controls rather than offering something that cannot
  work; the battery is a GATT connection and is unaffected.
- **The bridge is the option with no chooser tap.** Run the native helper in
  [`bridge/`](bridge/README.md): it scans with CoreBluetooth (which does see the advertisements) and
  relays the raw payload to the page over `ws://localhost`, where the same code decodes it with your
  key exactly as a browser scan would. Serve the app locally and open it with `?bridge=1`.

The Log is per-origin and per-browser: a session recorded in Chrome is invisible from Firefox or
Safari, a different profile, or a different site address. Installing may use a separate storage
container on some platforms, so check the installed app before relying on existing recordings.
Private browsing may provide temporary storage or refuse it. The local [bridge](bridge/README.md)
supplies solar advertisements only; it is not a native replacement for the battery connection.

Browser storage can be evicted. Shunt asks for persistent storage without delaying the Log or
recorder while a permission prompt is unanswered. The Log shows the browser's answer; a grant
protects against ordinary storage-pressure eviction, not clearing site data. Safari also has
proactive eviction policies for inactive sites. Export important sessions
as JSON. See [browser storage policies](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

The page feature-detects all of this and degrades honestly. With no solar it is still a complete,
correct battery instrument — it withholds the house-load span rather than faking it to zero.

A **What this page needs** checklist under *Connect* shows the live state of every precondition —
Web Bluetooth, HTTPS, whether the radio is actually switched on, whether the devices you have
allowed can be listed, advertisement listening, Web Crypto — tagged by whether it gates the battery
or only the solar half, with the remedy for each.

## Install, offline use and refresh recovery

Open Shunt online and wait for **Ready offline** in the footer. This downloads the app, fonts and
icons into this browser. After that, a normal reload or reopening the same address works without
internet, including the saved Log and Stats. Installation is optional for offline use.

In **Connect → Install & offline**, use **Install Shunt** when the browser offers it, or the browser's
own install menu:

| Browser | Installation |
|---|---|
| Chrome / Edge on desktop; Chrome on Android | Install app from the browser menu or Shunt's install button |
| Safari on macOS Sonoma or later | File → Add to Dock |
| Safari on iPhone / iPad | Share → Add to Home Screen |
| Firefox on Windows | Web-app windows where offered; Mozilla documents Firefox 143+, or 150+ for Microsoft Store builds |
| Firefox on Android | Menu → Install → Add to Home Screen |
| Firefox on macOS | Use the offline page in a normal tab |

Installation controls vary by platform; Shunt only shows its install button when the browser
supplies an installer. See [MDN installability](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable),
[Firefox Windows](https://support.mozilla.org/en-US/kb/web-apps-firefox-windows), and
[Firefox Android](https://support.mozilla.org/en-US/kb/use-web-apps-firefox-android).

**What survives a refresh:** the last battery and/or solar reading, its observation timestamp,
up to ten minutes of recorded trend, device/key/reconnect preferences, theme/sidebar preferences,
the Log, the current hash route, and Stats range/custom dates/pack selection. Older readings remain
available until forgotten or replaced, with a **STALE — not live data** label and observation date.
Rejoining the same remembered battery keeps the recent trend and its real gaps. Rate estimates
start with fresh observations because an old rate is not evidence of what the boat is doing now.

**What must restart:** browser Bluetooth connections end on reload. Shunt attempts to reconnect
using the existing permissions and remembered devices; a chooser may still be required by the
browser. Offline Bluetooth works while the app is running and the radios are available, under the
same browser restrictions as online. Closing the app, locking a phone, or suspending its browser
does not provide continuous background recording. The native solar bridge must still be running
when used. A PWA is not a replacement for a continuously running native logger.

Snapshots are saved periodically and synchronously when the page is hidden or left; the archive
checkpoints every ten seconds. An abrupt process kill without lifecycle events can still lose the
latest uncheckpointed samples (up to 15 seconds of snapshot state or ten seconds of Log samples).
These are recovery checkpoints, not a guarantee against browser storage refusal, device failure,
or clearing site data. The existing JSON export is the independent backup. Browsers recommend
[saving on visibility changes](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
because unload callbacks are not guaranteed.

**Updates wait for you.** New app files download into a separate cache. Shunt never reloads an
open recording to install them. When the update notice appears, finish recording, close **all**
Shunt tabs and app windows, then reopen. Reloading while another Shunt window remains open keeps
the current version. This follows the [service-worker lifecycle](https://web.dev/articles/service-worker-lifecycle).
Only Shunt's own app caches are cleaned up; readings and the Log are not part of that cache.

The first visit needs internet, and offline support needs HTTPS or localhost. If **Offline copy
unavailable** appears, check site storage permissions and reload online. Clearing site data removes
the offline app as well as saved state, so it must be downloaded again.

## Before you connect

**Close the JK app on your phone.** The BMS accepts one Bluetooth connection at a time; while the
app holds it, nothing else can connect. This is the single most common failure, and the browser
reports it as an unhelpful `NotFoundError` or `NetworkError` — the app translates both.

## Staying connected

Once you have connected a pack, the page goes back to it on its own. There is nothing to switch on:
as long as the radio is on it keeps looking for the pack you used last, waiting a second after the
first failure and doubling to half a minute. It never gives up — this is a boat. The Victron
controller comes back the same way whenever the page is in front of you, so its chooser tap is one
per browser rather than one per page load.

**It keeps going while you work in another application.** Chromium tears down every advertisement
watch when the tab goes behind another or the window loses focus, and fires no event to say so — so
there the page stops listening for the pack and asks the radio straight out instead, about once a
minute. That half needs no focus, and a link once made is not affected by focus at all, so the pack
can come back while you are in another application and still be there when you look. Bring the page
forward and it returns to the fast schedule at once. The controller cannot follow: advertisements
are the only thing it has, so its watch waits for the page to come back.

**While it is looking, it stays quiet.** A pack out of range is the ordinary case on a boat, so the
Bus view says it is looking and the recording is held open across the gap: a link that comes back
within two minutes continues the session it dropped out of rather than filing a fragment of one.
Only the three things you could actually act on interrupt — the radio switched off, a permission
that has lapsed, a browser that cannot rejoin at all.

**Disconnect is the off switch, and it sticks.** It drops the link *and* stops the page going back
to that pack — the controller with it, because that is one answer about the boat rather than about
a radio — and it is stored in this browser, so a reload does not quietly undo it. Connecting again
is the only thing that does, and any of the connect buttons will: the pack's on Connect, the one on
the Bus view which arms it and tries immediately, or **Connect solar**, which brings the pack back
as well. **Stop solar** ends the listening and forgets which controller it was, so the page has
nothing to go back to until you press Connect solar again.

### What the permissions flag buys, and what it does not

Reconnecting without the chooser needs `navigator.bluetooth.getDevices()`, which sits behind
`chrome://flags/#enable-web-bluetooth-new-permissions-backend`. With it, the page can reach a device
you have already allowed across reloads and across browser restarts, with no prompt and no tap.

Two things it does not do:

- **It cannot see the permissions you already had.** Grants made before the flag was enabled are
  invisible to it. After turning it on, pair each device once more from the chooser — until you do,
  `getDevices()` returns an empty list and the page reports that it has no permission to rejoin.
- **It is not a scan.** Chromium purges any device that is neither paired nor connected after 180 s
  without an advertisement, and nothing in a connect starts a scan on the page's behalf, so a
  remembered handle taken straight to `gatt.connect()` fails with *Bluetooth Device is no longer in
  range* however good the permission is — but only once the pack has been quiet that long. So the
  page tries the remembered handle first, which is both cheap and usually right in the minutes after
  a drop, and falls back to watching for an advertisement: a sighting proves the pack is there and
  re-seeds the adapter. Only that second half needs the page in front of you.

With the flag off, **What this page needs** says so and every connection starts from the chooser.

## The Victron encryption key

The advertisement payload is encrypted. The key is **not** the Bluetooth PIN and is **not** printed
on the product label.

> VictronConnect → connect to the controller → gear icon → **Product info** →
> **Instant readout via Bluetooth** → encryption key

It is 32 hex characters. The page verifies it before trusting it: byte 7 of every advertisement is a
check byte equal to the key's first byte, so a wrong key is rejected instead of rendering plausible
garbage.

**Where the key lives.** In your browser's `localStorage`, and nowhere else — alongside the last
frame each radio sent, and beside the Log in IndexedDB. Shunt downloads its own static app files
for offline use and checks for updates. It sends no readings, keys or recordings to a backend and
has no analytics. Fonts are bundled; no font CDN is contacted.

**Why the check byte matters.** Every Victron device on earth advertises under company id `0x02E1`.
In a marina you will receive your neighbours' broadcasts too. The check byte is what separates your
controller from theirs, and nothing that fails it is ever rendered as a reading. What the page says
about one depends on which radio heard it: watching the one controller you picked, a broadcast that
will not open can only be this controller's own key gone stale, and the panel says so; scanning for
the company id, the same broadcast is most likely a neighbour's, and the panel says that instead.

## The Log

Every session is recorded, browsable at `#/log`, and kept in this browser only.

Recording starts on its own — no button — the moment either radio produces its first sample, and
ends when both links go idle. A session is one continuous recording period bounded by the radios,
not by the pack link: a BMS that drops and reconnects stays one session with a gap drawn in it,
whether the solar scan carried on through the gap or the page simply spent it looking for the pack
again. Past two minutes the session is closed with the reason the link gave, and the pack coming
back opens a new one.

**One tab records at a time.** A second tab rejoins the pack on its own, without being asked to, and
two recorders on one archive would store the same watch twice — doubling every figure folded out of
it and letting a single day claim more recorded time than the day holds. So a recorder takes a lease
before it writes anything down. The tab that does not get it keeps every instrument and says plainly
that another tab is keeping the log. It takes over as soon as that tab announces it has stopped, and
within the retry interval when it cannot — a tab that is killed outright announces nothing.

**What is stored is what the radios said.** The pack and the controller are two separate streams,
never one joined row, because they run on separate cadences and a joined row would have to invent
whichever half had not spoken yet. Each stream is columnar — 28 bytes a pack row, 17 a solar row,
every field at the integer scale its radio transmits, so 3.394 V comes back as 3.394 V. There is no
`housePower` column: house load is `solar − pack`, and deriving it on read is what lets a correction
to the noise floor correct recordings already on disk.

**The budget is 2,000,000 samples**, about 48 MB, which is roughly 278 hours of both radios at 1 Hz.
Past that the oldest session is deleted whole, down to 90% of the cap so the next sample does not
trigger another eviction. A single session larger than the entire budget loses its oldest chunks
instead, and the row then says where its retained data really starts. The session being viewed and
any session a tab is still writing are never evicted.

**`[ DOWNLOAD JSON ]`** writes every sample exactly as the radios reported it, in engineering units,
with the stored ledger and a ledger recomputed from the samples side by side so the two can be
compared. Keep exports outside the browser for recordings you cannot afford to lose.

**Where it degrades, it says so.** Storage blocked by private browsing, a disk too full to accept
another chunk, or a database written by a newer build of this page each get their own sentence
naming the real cause. In all three the live instruments are unaffected: a full disk stops the Log,
never the instrument.

## Safety

The app is **read-only by construction**. The JK protocol uses one characteristic for both reads and
settings writes, so `buildCommand()` refuses any opcode that is not `0x96` (cell info) or `0x97`
(device info). It is not possible for this code to emit a settings frame. There is a unit test for
exactly that.

Note that the JK-BMS accepts **one BLE connection at a time**. Close the JK phone app first, or the
browser cannot connect.

## How the decoders were verified

Protocol offsets are easy to get subtly wrong, so none of them are taken on trust.

- **Settings frames** are validated offline against a `.jkcfg` export whose values were cross-checked
  against the vendor app. All 17 fields reproduce, including the low-temperature charge cutoff, which
  is stored as a *signed* int32 (`−10.0 °C`).
- **Live frames** are validated by physics. The cell voltages must sum to the reported pack voltage
  within sense-wire drop, and pack voltage × current must equal the reported power. Both are asserted
  in the test suite against a captured frame.
- **Current sign** was settled empirically against the BMS's own coulomb counter: over 114 s the
  remaining capacity fell at an implied −8.49 A while the decoder read a mean of −8.24 A. Positive is
  charging.
- **Pack power is an unsigned magnitude**, even though the current beside it is signed. A captured
  discharge frame carries current bytes `0e e2 ff ff` (−7.666 A) next to power bytes `41 98 01 00`
  (104.513 W = |V × I|). Reading power as `int32` "for consistency" is a plausible-sounding change
  that this frame refutes; it is committed as a regression fixture.
- **The Victron record** is checked against a synthetic AES-CTR test vector encrypted under a
  throwaway key, so the fixture is self-contained and leaks nothing.

A detail worth knowing if you port this: the ciphertext is 12 bytes, under one AES block, so the CTR
counter never increments. WebCrypto's big-endian counter and the reference implementation's
little-endian one therefore produce identical keystream. Only the initial counter block matters —
the 2-byte nonce little-endian, then fourteen zero bytes.

## Develop

```bash
npm install
npm run dev            # http://localhost:5173/jk-bms-victron-dashboard/
npm run dev:fake       # the same page, driven by a recording instead of radios
npm test               # decoder tests against real captured frames
npm run typecheck
npm run build
npm run check:visual   # renders in real Chrome, asserts no overflow, no console errors, no jitter
npm run check:pwa      # built app: offline reload, stored Log, update lifecycle, failed downloads
```

`localhost` is a secure context, so Web Bluetooth works on the dev server as-is. Viewing the dev
build from a phone needs a real HTTPS origin: run
`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.trycloudflare.com npm run dev` and point
`cloudflared tunnel --url http://localhost:5173` at it. The tunnel URL changes per run, and each
new URL is a new origin — Bluetooth permissions reset with it.

Offline caching is enabled only in production builds, never in `dev` or fake-radio mode. Run
`npm run build && npm run check:pwa` for the isolated browser check; it starts its own temporary
local server and browser profile. `CHROME_PATH` selects the Chrome executable. To try the install
and offline experience manually, run `npm run build && npm run preview`. Keep preview and dev on
different ports so a production service worker cannot serve cached files over your development
server. The build derives its cache version and asset list from the emitted files, including lazy
chunks and self-hosted fonts. No PWA runtime dependency is required.
Run `npm run check:pwa -- --firefox` for the same checks in Firefox; `FIREFOX_PATH` selects its executable.

Install icons are generated from `public/icons/shunt.svg`; regenerate with
`CHROME_PATH=/path/to/chrome node scripts/generate-icons.mjs` after editing the vector.

`check:visual` drives the *built* site, so run `npm run build && npm run preview` first and leave the
preview server up (it serves `http://localhost:4173/jk-bms-victron-dashboard/`, the script's default
target). It launches your installed Chrome, resolved per platform; set `CHROME_PATH` to point at a
different binary if the check cannot find one.
Set `VISUAL_OUTPUT_DIR=/tmp/shunt-visual` to keep verification screenshots outside the repository.

It seeds `localStorage` and IndexedDB from `tests/fixtures/`, the same payloads the unit suite
loads, and checks Connect/install, the cold landing, remembered readings, the Log list and session
detail, Stats with and without stored ring history, and Warnings at four widths. Screenshots land in `docs/`.
It then runs the instrument for forty seconds at desktop width and fails on cumulative layout shift
above 0.02, on the document height taking more than one value, or on the pack value label's `x`
moving. Those three are the measurements the layout work was aimed at, taken the way they were taken
on the boat, so a regression reads as the same number rather than as a proxy for it.

Routes ride in the hash, because the page is served as static files: `#/` is the dashboard, `#/log`
the archive, `#/log/<sessionId>` one session.

Dark is the designed plane, not a fallback. With no choice recorded the page follows the system
preference and keeps following it, so a machine that turns light at dusk takes the page with it.
The toggle records a choice in `localStorage` under `shunt.theme`, which then wins over the system
until you clear it. `?theme=light` and `?theme=dark` pin one visit's rendering — for a screenshot
or a shared link — without recording anything; clicking the toggle releases the pin. The choice is
resolved and applied before the app mounts, so a page opened in light mode never flashes dark
first.

Architecture is layered, and the layering is load-bearing:

```
src/domain/          pure decoders, the reconciliation and the archive's own arithmetic.
                     No browser APIs. Unit-tested.
src/infrastructure/  Web Bluetooth adapters and the IndexedDB session store.
src/application/     reactive store, fault derivation, the recorder, rolling history.
src/components/      hand-rolled inline SVG. No chart library.
```

## Fake radios

`npm run dev:fake` serves the whole page with every Bluetooth adapter swapped for playback of a
recording taken off the boat. No hardware, no chooser, no key — and a dev panel bottom-right that
makes the hardware-only states reachable by clicking.

```bash
npm run dev:fake
npm run dev:fake:tunnel   # the same, reachable from a phone through a cloudflared tunnel
```

The tunnel variant exists because the panel is worth driving from the phone, and a phone needs the
tunnel host allowed — the same variable as the `npm run dev` note above.

Across the top is a playback strip — the two scenarios, pause, single step, 0.5×/1×/4× — and under
it ten groups of controls:

- **Capabilities** — the ten flags the page feature-detects, and the adapter as on, off or unknown.
  The flags take effect on reload; the adapter is live, as it is on real hardware. It also remembers
  or forgets a last pack, which is what gives the silent reconnect below anything to try.
- **Pack link** — every way a connection or a silent reconnect can settle, including the one that
  raises no banner at all; a slow attempt; a link that connects and then says nothing; drops, stalls,
  a frame that will not decode, and a pack with no name to file it under.
- **Going back on its own** — the intent armed and disarmed, the pack taken out of earshot and
  brought back, and the page put behind another tab or left showing without focus. It prints what
  both loops are doing, so a search that says nothing on screen is still visible here.
- **Solar link** — the three ways a scan can fail, advertisements going stale, each of the three
  reasons an advertisement reaches the decoder and does not come out a reading — a reissued key,
  Instant Readout switched off, another kind of Victron product — heard as either route hears them,
  an identity announcement, a reading that will not decrypt, and the key present or gone.
- **Pack values** — cell spread, path resistance on one cell, MOSFET and cell temperature, both
  switches, state of charge.
- **Solar values** — charger error, every charge stage, a load output, blanked measurements, a bus
  voltage that disagrees with the pack's, an implausible house load, no signal.
- **Stored log** — each way the `0xA7` read can answer, and each way filing the result can land: a
  gap, an overlap, a shifted ring, a run too short to place.
- **Stored solar history** — each way the sweep of the controller's 31 days can answer.
- **Source and view** — review a stored session, restore or forget the remembered one, move the
  clock (only while both radios are down, so the recorder cannot write into the future).
- **Archive** — each reason it can be unavailable, an archive that rejects every call, seeded rows
  playback cannot reach on its own, a sample count pushed up against the storage budget, and wipe.

Two things behave differently from `npm run dev`, both deliberate:

- **It records for real.** Sessions, chunks, warnings and ring reads go through the same recorder
  and the same store the real page uses, so the Log, Stats and export all work and survive a reload.
- **Nothing it writes can reach the real page.** The archive is the separate database `shunt.log.fake`,
  and every `localStorage` key holding a measurement or a device is suffixed `.fake`, so a playback
  session cannot overwrite the remembered snapshot, the last connected pack, the logbook, or — the
  one that costs real effort to recover — the Victron advertisement key. The recording lease is
  suffixed too: it is a Web Lock, scoped by origin and name, and on one shared name a playback run
  would hold the real page off its own archive for as long as it played. Theme and sidebar layout
  are chrome and stay shared on purpose.

None of this reaches a deployed build. The recording and the panel's stylesheet both carry a marker
string, and `npm run build` fails if either appears in `dist/`.

### Regenerating the fixture

```bash
node --import ./scripts/support/typescriptResolve.mjs scripts/distill-fake-fixture.mjs
node --import ./scripts/support/typescriptResolve.mjs scripts/distill-fake-fixture.mjs --pack-hz 1
```

Reads the gitignored `captures/` and writes three files under
`src/infrastructure/ble/fake/fixture/`: the live streams as decoded production types, and the pack's
stored log and the controller's stored history as wire bytes the real transports parse back. It
refuses to write anything carrying a device serial, and the committed fixture names the pack
`DEMO00000000001`.

The pack records at about 3.76 Hz and native is what is committed (475 KB). `--pack-hz 1` thins it to
146 KB, at the cost of two things worth knowing: the fixture then emits on the app's own sampling
interval and hides the jitter the dashboard exists to absorb, and float's cell spread collapses from
46 mV to 5 mV, because the imbalance excursions live between the samples.

## Support

If Shunt is useful to you, you can [buy me a coffee](https://buymeacoffee.com/ipazanin).
Support is completely optional.

## Credits

Protocol work stands on the shoulders of the [ESPHome JK-BMS component](https://github.com/syssi/esphome-jk-bms)
and [`victron-ble`](https://github.com/keshavdv/victron-ble). Neither is used at runtime — this page
ships no third-party JavaScript beyond Vue. The fonts are self-hosted via `@fontsource`, so no CDN
is ever contacted.

## Licence

MIT.
