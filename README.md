# Shunt — a JK-BMS + Victron dashboard in your browser

A static web page that talks Bluetooth directly to a **JK-BMS** and a **Victron SmartSolar MPPT**,
and reconciles them. No app, no account, no backend, no cloud.

**[Open the live demo →](https://ipazanin.github.io/jk-bms-victron-dashboard/?demo)** — replays a real
recording, so it works with no hardware at all.

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
| Chrome / Edge, macOS | ✅ | ⚠️ behind a flag |
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
  it exists only on **Android and macOS**.

The page feature-detects all of this and degrades honestly. With no solar it is still a complete,
correct battery instrument — it withholds the house-load span rather than faking it to zero.

## The Victron encryption key

The advertisement payload is encrypted. The key is **not** the Bluetooth PIN and is **not** printed
on the product label.

> VictronConnect → connect to the controller → gear icon → **Product info** →
> **Instant readout via Bluetooth** → encryption key

It is 32 hex characters. The page verifies it before trusting it: byte 7 of every advertisement is a
check byte equal to the key's first byte, so a wrong key is rejected instead of rendering plausible
garbage.

**Where the key lives.** In your browser's `localStorage`, and nowhere else. This site is static —
there is no server to send it to. Nothing is transmitted anywhere.

**Why the check byte matters.** Every Victron device on earth advertises under company id `0x02E1`.
In a marina you will receive your neighbours' broadcasts too. The check byte is what separates your
controller from theirs; foreign advertisements are silently dropped.

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
npm run check:visual   # renders in real Chrome, asserts no overflow or console errors
```

`?demo` replays a recorded passage; `?demo=bms` replays the battery alone, to exercise the degraded
page. `?theme=light` forces light mode.

Architecture is layered, and the layering is load-bearing:

```
src/domain/          pure decoders and the reconciliation. No browser APIs. Unit-tested.
src/infrastructure/  Web Bluetooth adapters, and a demo source that replays a recording.
src/application/     reactive store, fault derivation, rolling history.
src/components/      hand-rolled inline SVG. No chart library.
```

## Credits

Protocol work stands on the shoulders of the [ESPHome JK-BMS component](https://github.com/syssi/esphome-jk-bms)
and [`victron-ble`](https://github.com/keshavdv/victron-ble). Neither is used at runtime — this page
ships no dependency beyond Vue.

## Licence

MIT.
