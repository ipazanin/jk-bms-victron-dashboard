# Shunt — a JK-BMS + Victron dashboard in your browser

A static, installable web app that talks Bluetooth directly to a **JK-BMS** and a **Victron SmartSolar MPPT**,
and reconciles them. Recording works locally without an account or backend. Optional Google sync
keeps hourly history in your own Drive and shares it between devices. Detailed samples stay local.

**[Open it →](https://ipazanin.github.io/jk-bms-victron-dashboard/)** — live Bluetooth needs Chrome or
Edge and the two radios. Saved and imported history can be viewed in Firefox and Safari. Without
hardware or saved data, the instrument starts empty and explains what it will show. No sample
readings are presented as live measurements.

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

The Log is stored per-origin and per-browser. Use **Connect → Data & backup** to export it from
Chrome and open it in Firefox, Safari, another profile, or another device. Installing may use a separate storage
container on some platforms, so check the installed app before relying on existing recordings.
Private browsing may provide temporary storage or refuse it. The local [bridge](bridge/README.md)
supplies solar advertisements only; it is not a native replacement for the battery connection.

Browser storage can be evicted. Shunt asks for persistent storage without delaying the Log or
recorder while a permission prompt is unanswered. The Log shows the browser's answer; a grant
protects against ordinary storage-pressure eviction, not clearing site data. Safari also has
proactive eviction policies for inactive sites. Keep a complete JSON archive or individual session
JSON exports outside the browser. See [browser storage policies](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

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
or clearing site data. JSON archives and session JSON exports provide independent backups. Browsers recommend
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

## JSON archives and device transfers

Open **Connect → Data & backup** to export this browser's complete saved history and preferences.
Exports are compressed JSON files (`.json.gz`). Import accepts these files and uncompressed
Shunt JSON archives (`.json`). One file can contain one source snapshot or an array of snapshots
from different sources. The transfer works offline after the app is cached and does not need
Bluetooth, including in Firefox.

Archives include sessions, retained raw sample chunks, hourly summaries and selected moments,
device names, warnings, battery and solar history reads,
stored totals, theme, sidebar, Stats preferences, the last instrument snapshot and the lifetime
logbook. Raw sample columns retain their original typed arrays and integer units. Import validates
the complete archive before showing a preview. Malformed records and duplicate source identifiers
are rejected. Individual-session JSON exports from the Log are a separate format and cannot be
imported as complete archives. Older Excel and ZIP archives are no longer accepted.

Import first shows a preview. Confirming saves a separate, read-only source that you can select in
Log, Stats and Warnings. Your current recording stays in this browser's own source. Reimporting
the same source replaces its saved copy, so the preview shows that replacement explicitly. A
recording captured while open remains labelled **Open at capture**, with its duration fixed at
the export time. Imported recordings do not resume and are not combined with local recordings.

**Apply saved settings** copies portable settings to this browser after the radios are
disconnected. Bluetooth permissions, remembered browser device handles and automatic reconnect
intent are not transferred. Pair the radios in each browser. The Victron advertisement key is
excluded from exports unless you opt in, and applying it requires a separate opt-in. An archive
without a key leaves this browser's existing key unchanged.

An imported copy of this browser's own source can also replace its local history, after an
explicit confirmation. Both the saved copy and the current history must have no open sessions.
This restore replaces history only. Apply its settings separately if wanted.

**Export current sources** includes the current browser and saved sources from other browsers.
To preserve an older saved copy of this same browser, select it and use **Export selected source**
separately. A file contains one snapshot per source. Each source is saved atomically on import.
If a multi-source import is cancelled or runs out of storage, completed sources remain available
and the remaining sources stay in the preview.

Files are limited to 256 MiB, with at most 512 MiB of expanded JSON, 10 million retained samples
and 100 unique sources across the complete archive. These limits apply to compressed and plain
JSON files. Processing runs in a cancellable worker, but large archives still need substantial
memory. Use a desktop browser for a full retained history.

## Optional Google sync

In **Connect → Data & backup → Google sync**, enable sync and connect to Google. Create a workspace
with a name and a destination folder, or open an existing workspace folder. The destination starts
at **My Drive** and is shown before creation. **Choose folder** lets you select another location.
Shunt creates its own workspace folder inside that destination. Cancelling selection creates nothing,
and an inaccessible destination never falls back to My Drive.

Use the same Google account and configured app on each device. Workspaces created by Shunt appear
in the workspace list. Opening from Drive selects the workspace folder. Shunt requests access to
files it creates or you select, using Google's
[`drive.file` scope](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

The first sync creates an ordinary, uncompressed `.json` file containing the workspace's synced
history and shared settings. Each device remains a separate history source. The latest three saved
revisions of each source are retained inside the JSON. Larger workspaces split into JSON parts only
when they exceed the app's 16 MiB per-file processing budget. Records remain whole. Each part can
be downloaded and parsed separately. This is an app budget, not a Drive file-size limit. The full
workspace still needs to fit in browser memory.

Each update uploads and verifies a new complete copy before retiring the exact previous files it
incorporated. Ordinary sequential sync leaves one JSON file, or one set of parts for a larger
workspace. Concurrent syncs and interrupted cleanup can leave additional copies. A later successful
sync combines the copies it reads. An incomplete upload cannot replace a complete copy. Files from
an unseen concurrent upload are never included in that sync's cleanup. Incomplete uploads remain
untouched because another device may still be uploading their remaining parts.

**Sync now** uploads this browser's hourly history and retrieves the latest sources from other
devices. Sources stay separate in Log, Stats and Warnings. Imported history does not join the active
recording. Saved copies contain hourly summaries, selected moments, session totals, warnings,
native battery and solar history, and saved settings. Raw sample chunks and the remembered
instrument's short trend stay local. Export this browser's JSON archive to preserve raw recordings.
Hourly history is retained for up to two years, subject to the summary and session limits below.

The connected panel puts **Sync now**, the workspace folder link, last sync, progress, cancellation
and errors together. Workspace selection and creation are under **Change workspace**. Device naming,
automatic sync and key sharing are under **Sync settings**. Opening an earlier saved revision pauses
automatic sync so its history stays on screen. Use **Sync now** or enable automatic sync to receive
the latest history again.

Existing spreadsheet-based workspaces remain readable. Create a new JSON workspace and select it
on each updated device for new uploads. Existing cloud files are not converted or deleted
automatically. Update Shunt on every device before using the new workspace. Finish recording, close
all Shunt tabs and app windows when an update is ready, then reopen.

Shared settings cover theme, sidebar and Stats preferences. When devices change them independently,
Shunt asks which version to keep. Disconnect radios before applying cloud settings. Bluetooth
permissions and automatic reconnect intent stay local.

**Include the Victron advertisement key in Google sync** is off by default. Opting in includes the
key in uploads and allows shared settings to apply it locally. Turning it off prevents subsequent
local key uploads and applications. It does not erase keys already saved in cloud history. Anyone
with access to those files can read an included key.

Automatic sync checks once a minute while the page is visible, online and connected to Google.
While this browser records, its history uploads at most once an hour and again when recording ends.
**Sync now** checks this browser's current history immediately. Unchanged history and settings do not
create another revision. Closing or suspending the app stops automatic sync. Access tokens exist
only in memory, so reloads and token expiry require another **Connect Google** click. Google's
[token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model) requires a
user action to renew access.

Disconnecting or disabling sync leaves cloud files and local copies intact. Deleting a workspace
moves its app-created folder to Trash, including any files added manually. It never trashes the
parent destination folder. Local recordings and downloaded copies remain. Keep manual JSON exports
for independent recovery beyond the three saved revisions.

Google sync uses browser sign-in and HTTPS requests. It can transfer history in Firefox even though
Firefox cannot record from the radios. JSON archive transfer remains the offline option. Test Google
sign-in and folder selection on each configured origin, including the installed app on Android.
Browser privacy settings can require additional Google permission prompts. If the sign-in window
shows an error page, close it or press **Cancel sync**, then connect again.

### Configure Google sync for your build

Google setup is optional. Without the three build variables below, the app keeps recording and
exporting locally and shows Google sync setup instructions.

1. In one Google Cloud project, enable **Google Drive API** and **Google Picker API**.
   Enable **Google Sheets API** as well to read existing spreadsheet-based workspaces. Set the OAuth
   audience to **External**. The app requests only the non-sensitive `drive.file` scope. While the app
   is in testing, add each Google account as a test user.
2. Create an OAuth client of type **Web application** with no redirect URIs. Add every origin that
   serves the app as an authorized JavaScript origin, for example `http://localhost:5173` and
   `https://ipazanin.github.io`. Origins have no path, and the port must match exactly. If Vite
   moves the dev server to another port because 5173 is taken, Google refuses sign-in until that
   origin is added too. `npm run preview` serves on port 4173, which needs its own entry. This
   browser token flow needs no client secret. See
   [Google's client setup](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid).
3. Create an API key restricted to the **Google Picker API** only. Drive and Sheets calls use the
   signed-in user's token, not the key. Its website restrictions must allow your app origins, such
   as `http://localhost:5173/*` and `https://ipazanin.github.io/*`, plus `https://docs.google.com/*`
   for the picker's iframe. Firefox sends only the origin as the referrer, so a pattern with a path
   such as `/jk-bms-victron-dashboard/*` would not match. Use the same project's numeric project
   number as the picker's app ID. See
   [Google's Picker setup](https://developers.google.com/workspace/drive/picker/guides/web-picker-sample).
4. Copy `.env.example` to `.env.local` and fill in `VITE_GOOGLE_CLIENT_ID`,
   `VITE_GOOGLE_API_KEY` and `VITE_GOOGLE_PROJECT_NUMBER`. These are public browser configuration
   values bundled into the app. Do not add a client secret, access token or refresh token.
5. For GitHub Pages, set repository **Actions variables** with those same three names. The workflow
   supplies them to both verification and deployment builds. Rebuild after changing them.

Use the same OAuth client and project across your devices and hosted origins so the app can discover
its existing files. Allow Google popups when connecting. A blocked script, denied permission or
expired token leaves local recording available. Do not rename the catalogue tabs, change its
headers or move its Sheet out of the workspace folder. Change shared settings through Shunt in
normal use. If editing its Sheet directly, preserve existing catalogue rows, revision IDs and
settings ancestry.

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

**The two radios behave differently in the background.** Chromium can stop advertisement delivery
when the tab is hidden or the window loses focus. The BMS uses a GATT connection that can remain
active, and its reconnect loop can try the radio directly while the page is away. Android may
suspend the page and its timers, including when the dashboard is installed on the home screen.
Solar waits for the page to return before starting a fresh advertisement watch.

**Returning to the app restarts solar automatically.** Each automatic startup attempt has a
15-second deadline. A stalled attempt is cancelled and retried, and delayed results from an old
attempt cannot change the current connection. Rapid app switches share the same scan budget, so
a cooldown may delay the next attempt before its deadline starts. Live readings resume when fresh
packets arrive. The browser must still have permission for the remembered controller.

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

**Where the key lives.** The active key is in your browser's `localStorage`. JSON archives and Google
uploads include it only when you opt in. A previously imported or uploaded archive may retain its
own copy. Shunt downloads its static app files for offline use and checks for updates. Optional
Google sync sends saved history and chosen settings directly to your Drive. There is no Shunt
backend or analytics. Fonts are bundled and no font CDN is contacted.

**Why the check byte matters.** Every Victron device on earth advertises under company id `0x02E1`.
In a marina you will receive your neighbours' broadcasts too. The check byte is what separates your
controller from theirs, and nothing that fails it is ever rendered as a reading. What the page says
about one depends on which radio heard it: watching the one controller you picked, a broadcast that
will not open can only be this controller's own key gone stale, and the panel says so; scanning for
the company id, the same broadcast is most likely a neighbour's, and the panel says that instead.

## The Log

Every session is recorded and browsable at `#/log`. Detailed samples stay in this browser.
Optional Google sync makes hourly history and important moments available to your other devices.

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

**The default raw allowance is 100 MiB**, configurable to 25, 50 or 100 MiB in the Log storage
controls. This choice applies only to this browser. At one reading per second from both radios,
100 MiB holds about 27 days of sample columns. Browser overhead, summaries, imported sources and
native device history use additional storage. Available disk space and browser policy can impose
a lower practical limit.

Once the allowance fills, the oldest sealed raw chunks are removed down to 90% of the allowance.
Hourly summaries are saved before raw chunks can be removed. Session totals, warnings and selected
moments remain available. The view identifies the retained raw range and shows hourly history
where detailed samples are absent.

Hourly summaries keep the existing energy accounting, observed coverage, current averages and
the minimum and maximum of nine displayed measurements. Up to 22 selected moments per session-hour
preserve first and last observations and those extrema with their original radio timestamps.
Missing readings remain gaps. Hour boundaries are UTC, displayed in the viewer's local time.
Intervals crossing an hour boundary allocate their existing energy totals by elapsed duration.
Summaries reconstructed from older raw recordings are labelled separately from summaries recorded
live. The original session totals remain unchanged.

Compact history keeps up to two years, 20,000 session-hours and 2,000 sessions. The count limits
can remove older closed sessions before their raw allowance fills. Local summaries needed by raw
chunks can remain longer until those chunks are removed. Open and currently viewed sessions are
protected from session eviction. Native BMS ring history and Victron daily history retain their
existing limits. These allowances do not reserve browser disk space.

**`[ DOWNLOAD JSON ]`** includes retained raw samples in engineering units, hourly summaries and
selected moments. Its stored session ledger and ledger recomputed from retained raw samples are
kept separate. Keep exports outside the browser for recordings you cannot afford to lose.

**Where it degrades, it says so.** Storage blocked by private browsing, a disk too full to accept
another chunk, or a database written by a newer build of this page each get their own sentence
naming the real cause. In all three the live instruments are unaffected: a full disk stops the Log,
never the instrument.

## Safety

Radio access is **read-only by construction**. The JK protocol uses one characteristic for both reads and
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
  are chrome and stay shared on purpose. Google sync is disabled in fake-radio mode, so demo
  recordings cannot be uploaded into a real cloud workspace.

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
and [`victron-ble`](https://github.com/keshavdv/victron-ble). Neither protocol library is used at runtime.
Vue supplies the UI. fflate compresses manual JSON archives and reads legacy compressed cloud
history. Fonts are self-hosted via `@fontsource`. Google Identity Services and Picker scripts load
when you enable Google sync.

## Licence

MIT.
