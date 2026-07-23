#!/usr/bin/env python3
"""
Local Bluetooth bridge for the JK-BMS / Victron dashboard.

macOS Chrome cannot deliver BLE advertisements to a web page — its requestLEScan
opens a prompt and then finds nothing — but CoreBluetooth sees those same
advertisements fine from a native process. This script scans for Victron
"Instant Readout" advertisements (Bluetooth SIG company id 0x02E1) and relays the
RAW manufacturer payload to the dashboard over a localhost WebSocket.

It never decrypts anything and never sees your encryption key: the browser does
the AES-CTR decrypt exactly as it would for a real scan. The bytes relayed here
are the same public broadcast any device in radio range already receives.

Run it, then open the dashboard locally with ?bridge=1, e.g.
  http://localhost:5173/jk-bms-victron-dashboard/?bridge=1
(?bridge=1 defaults to ws://localhost:8787; ?bridge=ws://host:port points elsewhere.)
"""

import asyncio
import json

from bleak import BleakScanner
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData
from websockets.asyncio.server import ServerConnection, serve

VICTRON_COMPANY_ID = 0x02E1
HOST = "127.0.0.1"
PORT = 8787

clients: set[ServerConnection] = set()


async def broadcast(message: str) -> None:
    for connection in list(clients):
        try:
            await connection.send(message)
        except Exception:
            clients.discard(connection)


async def on_advertisement(_device: BLEDevice, advertisement: AdvertisementData) -> None:
    payload = advertisement.manufacturer_data.get(VICTRON_COMPANY_ID)
    if not payload:
        return
    await broadcast(json.dumps({"mfg": payload.hex(), "rssi": advertisement.rssi}))


async def register(connection: ServerConnection) -> None:
    clients.add(connection)
    try:
        await connection.wait_closed()
    finally:
        clients.discard(connection)


async def main() -> None:
    scanner = BleakScanner(detection_callback=on_advertisement)
    async with serve(register, HOST, PORT):
        print(f"Victron bridge listening on ws://{HOST}:{PORT}")
        print("Scanning for Victron advertisements (company id 0x02E1). Ctrl-C to stop.")
        await scanner.start()
        try:
            await asyncio.Future()  # run until interrupted
        finally:
            await scanner.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
