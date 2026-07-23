# Solar bridge (macOS workaround)

The dashboard reads the Victron SmartSolar by scanning its Bluetooth "Instant
Readout" advertisements. On **macOS Chrome that scan is broken** — the browser's
`requestLEScan` opens a prompt, sits on _"Scanning…"_ with an empty list, and
never delivers a single advertisement (it's an unresolved Chromium issue,
crbug.com/897312). The BMS still works, because it uses a different Bluetooth API
that macOS does support; only the solar scan is affected.

This bridge is the way around it. A native process **can** see those
advertisements through CoreBluetooth, so `victron_bridge.py` scans locally and
relays the raw advertisement bytes to the page over a `ws://localhost` socket.
The page decodes them with the exact same code it uses for a real scan — same UI,
same recorder, same everything.

Your encryption key never leaves the browser and is never sent to this script.
The bytes it relays are a public BLE broadcast that anything in radio range
already receives.

## Run it

```sh
cd bridge
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python victron_bridge.py
```

On first run macOS will ask to let your terminal use Bluetooth — allow it
(System Settings → Privacy & Security → Bluetooth). You should see:

```
Victron bridge listening on ws://127.0.0.1:8787
Scanning for Victron advertisements (company id 0x02E1). Ctrl-C to stop.
```

## Point the dashboard at it

Serve the app **locally over http** (an `https://` page is not allowed to open a
`ws://localhost` socket), then add `?bridge=1`:

```sh
npm run dev
```

Open <http://localhost:5173/jk-bms-victron-dashboard/?bridge=1>, enter your key,
and press **Connect solar**. There is no Bluetooth prompt this time — the reading
comes straight from the bridge.

- `?bridge=1` → connect to `ws://localhost:8787` (the default).
- `?bridge=ws://host:port` → connect somewhere else.
- No `?bridge` at all → the normal browser scan, unchanged.

A side benefit: because Chrome no longer touches the radio for solar, the BMS
connection stops dropping when you start solar with both radios in use.
