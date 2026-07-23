# Shunt — a JK-BMS + Victron dashboard in your browser

A static web page that talks Bluetooth directly to a **JK-BMS** and a **Victron SmartSolar MPPT**,
and reconciles them. No app, no account, no backend, no cloud.

**[Open it →](https://ipazanin.github.io/jk-bms-victron-dashboard/)** — needs Chrome or Edge and the
two radios. With no hardware you get the instrument drawn empty, the copy explaining what it will
show, and nothing else: no numbers, no charge figure, no sample data. The page shows what its own
radios recorded, and until they have recorded something there is nothing honest to draw.

| The bus, reconciled | The Log |
|---|---|
| ![The dashboard, with both radios seen](docs/desktop-remembered.png) | ![The Log, listing one recorded session](docs/desktop-log.png) |

Both are rendered from the built app by `npm run check:visual`, which drives a recorded session
through the same `localStorage` and IndexedDB the page uses in the field.

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

Web Bluetooth is a Chromium-only API. This is not something the page can work around.

| Browser | Battery (GATT) | Solar (advertisements) |
|---|---|---|
| Chrome / Edge, macOS | ✅ | ⚠️ flagged, but the scan finds nothing — [use the bridge](bridge/README.md) |
| Chrome, Android | ✅ | ⚠️ behind a flag |
| Chrome / Edge, Windows · Linux · ChromeOS | ✅ | ❌ not implemented |
| Firefox, any platform | ❌ | ❌ |
| Safari, macOS & iOS | ❌ | ❌ |
| Bluefy (iOS) | ✅ | ❌ |

- **Firefox will never work.** Mozilla's [standards position on Web Bluetooth](https://github.com/mozilla/standards-positions/issues/95)
  is *negative*; there is no implementation to enable.
- **Safari ships nothing**, and Apple requires iOS browsers to use WebKit, so Chrome-on-iOS
  inherits the gap. iOS users need [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055).
- **Solar needs a flag.** Advertisement scanning (`requestLEScan`) is still behind
  `chrome://flags/#enable-experimental-web-platform-features`, and per the
  [WebBluetoothCG implementation status](https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md)
  it is listed for **Android and macOS** — but the macOS entry is an open implementation issue
  ([crbug.com/897312](https://crbug.com/897312)), so in practice only Android delivers.
- **On macOS the scan opens its prompt and finds nothing.** The flag is honoured and the permission
  dialog appears, but it sits on *Scanning…* with an empty device list forever — no advertisement
  ever reaches the page, so the encryption key is never even consulted. The battery is unaffected;
  GATT works fine on macOS. To read solar on a Mac, run the native helper in
  [`bridge/`](bridge/README.md): it scans with CoreBluetooth (which does see the advertisements) and
  relays the raw payload to the page over `ws://localhost`, where the same code decodes it with your
  key exactly as a real scan would. Serve the app locally and open it with `?bridge=1`.

Storage is the opposite shape, and it changes what the Log can be. Firefox and Safari have perfect
IndexedDB and no Web Bluetooth at all, so they can never record — and having never recorded, they
have nothing to browse. The Log is per-origin and per-browser: a session recorded in Chrome is
invisible from Safari on the same machine, and from a different Chrome profile, and there is no
mechanism that could make it otherwise. Private browsing usually blocks storage outright; the page
says so in a sentence and keeps working as a live instrument.

**On iOS the JSON export is the durability story.** Bluefy is a WKWebView app, and WebKit wipes
script-writable storage — IndexedDB included — after seven days without a visit. Nothing the page
can do prevents that, so the download button sits in the session header on every platform rather
than being shouted about on the one where it matters most. Bluefy also has GATT but no advertisement
scanning, so every iOS session is pack-only.

The page feature-detects all of this and degrades honestly. With no solar it is still a complete,
correct battery instrument — it withholds the house-load span rather than faking it to zero.

A **What this page needs** checklist under *Connect* shows the live state of every precondition —
Web Bluetooth, HTTPS, whether the radio is actually switched on, advertisement scanning, Web Crypto —
tagged by whether it gates the battery or only the solar half, with the remedy for each.

## Before you connect

**Close the JK app on your phone.** The BMS accepts one Bluetooth connection at a time; while the
app holds it, nothing else can connect. This is the single most common failure, and the browser
reports it as an unhelpful `NotFoundError` or `NetworkError` — the app translates both.

## The Victron encryption key

The advertisement payload is encrypted. The key is **not** the Bluetooth PIN and is **not** printed
on the product label.

> VictronConnect → connect to the controller → gear icon → **Product info** →
> **Instant readout via Bluetooth** → encryption key

It is 32 hex characters. The page verifies it before trusting it: byte 7 of every advertisement is a
check byte equal to the key's first byte, so a wrong key is rejected instead of rendering plausible
garbage.

**Where the key lives.** In your browser's `localStorage`, and nowhere else — alongside the last
frame each radio sent, and beside the Log in IndexedDB. **The page issues zero network requests
after it loads.** That is a statement about the code, not a policy: nothing in `src/` calls `fetch`,
the fonts are bundled, and the site is static, so there is no server to send anything to even if it
wanted to.

**Why the check byte matters.** Every Victron device on earth advertises under company id `0x02E1`.
In a marina you will receive your neighbours' broadcasts too. The check byte is what separates your
controller from theirs; foreign advertisements are silently dropped.

## The Log

Every session is recorded, browsable at `#/log`, and kept in this browser only.

Recording starts on its own — no button — the moment either radio produces its first sample, and
ends when both links go idle. A session is one continuous recording period bounded by the radios,
not by the pack link: a BMS that drops and reconnects while the solar scan is still up stays one
session with a gap drawn in it.

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
compared. On iOS it is the only durable copy — see the storage note above.

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
npm test               # decoder tests against real captured frames
npm run typecheck
npm run build
npm run check:visual   # renders in real Chrome, asserts no overflow, no console errors, no jitter
```

`check:visual` drives the *built* site, so run `npm run build && npm run preview` first and leave the
preview server up (it serves `http://localhost:4173/jk-bms-victron-dashboard/`, the script's default
target). It launches your installed Chrome, resolved per platform; set `CHROME_PATH` to point at a
different binary if the check cannot find one.

It seeds `localStorage` and IndexedDB from `tests/fixtures/`, the same payloads the unit suite
loads, and asserts four states at four widths: the cold landing (which must print no charge figure
at all), the remembered session, the Log list and one session's detail. Screenshots land in `docs/`.
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

## Credits

Protocol work stands on the shoulders of the [ESPHome JK-BMS component](https://github.com/syssi/esphome-jk-bms)
and [`victron-ble`](https://github.com/keshavdv/victron-ble). Neither is used at runtime — this page
ships no third-party JavaScript beyond Vue. The fonts are self-hosted via `@fontsource`, so no CDN
is ever contacted.

## Licence

MIT.
