#!/usr/bin/env python3
"""
Ask the Victron SmartSolar whether it will talk over GATT at all.

The app reads the controller only by decrypting its Instant Readout advertisements — it never
connects. That is why the 30 stored daily records it keeps on its own flash are unreachable:
`src/domain/solar/history.ts` decodes them, but no transport anywhere can fetch one.

This probe settles the prior question. It connects, enumerates every service and characteristic
with its properties, reads whatever announces itself readable, and listens on every notifying
characteristic. All of that is observation; the probe never writes to the controller, so it
cannot change a charge parameter.

Three outcomes, all of them durable findings worth recording:

  * a service and characteristic table  -> a register-read transport is a reverse-engineering
    job with a known starting point,
  * a refusal or a demand to bond       -> a browser cannot get there, and the decoder is dead
    code until something outside the browser fetches for it,
  * nothing announces notify            -> whatever VictronConnect uses is not exposed to an
    unauthenticated client on this firmware.

The controller accepts one connection at a time. Disconnect VictronConnect on the phone first,
or this will either fail to connect or steal the link from it.

Usage:
  python victron_gatt_probe.py                       # scan for the SmartSolar, then probe it
  python victron_gatt_probe.py --address <UUID>      # skip discovery
  python victron_gatt_probe.py --listen 20           # linger longer on notifications
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

VICTRON_COMPANY_ID = 0x02E1

OUT = Path(__file__).resolve().parent.parent / "captures"

#: Reading a characteristic is safe, but some hold a blob big enough to bury the report.
MAX_READ_PREVIEW = 64


async def scan_for_controllers(seconds: float) -> list[tuple[BLEDevice, AdvertisementData]]:
    """Every Victron in range. Deliberately does not choose between them — see the caller."""
    print(f"scanning {seconds:.0f}s for a Victron controller...", file=sys.stderr)
    found: dict[str, tuple[BLEDevice, AdvertisementData]] = {}

    def on_advertisement(device: BLEDevice, adv: AdvertisementData) -> None:
        if VICTRON_COMPANY_ID in (adv.manufacturer_data or {}):
            found[device.address] = (device, adv)

    scanner = BleakScanner(detection_callback=on_advertisement)
    await scanner.start()
    await asyncio.sleep(seconds)
    await scanner.stop()

    return list(found.values())


async def probe(address: str, listen_seconds: float) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    report: list[str] = []

    def record(line: str = "") -> None:
        print(line)
        report.append(line)

    notifications: list[str] = []
    start = time.time()

    def on_notify(characteristic, data: bytearray) -> None:
        notifications.append(f"  {time.time() - start:7.3f}s  {characteristic.uuid}  {bytes(data).hex()}")

    record(f"# Victron GATT probe — {address}")
    record()

    print(f"connecting to {address} ...", file=sys.stderr)
    async with BleakClient(address) as client:
        record(f"connected: {client.is_connected}")
        record()

        subscribable = []
        for service in client.services:
            record(f"service {service.uuid}  {service.description}")
            for characteristic in service.characteristics:
                properties = ",".join(characteristic.properties)
                record(f"  char {characteristic.uuid}  [{properties}]  {characteristic.description}")

                if "read" in characteristic.properties:
                    try:
                        value = await client.read_gatt_char(characteristic)
                        preview = bytes(value[:MAX_READ_PREVIEW]).hex()
                        suffix = " ..." if len(value) > MAX_READ_PREVIEW else ""
                        record(f"       read: {preview}{suffix}  ({len(value)} bytes)")
                    except Exception as error:
                        record(f"       read refused: {error}")

                if "notify" in characteristic.properties or "indicate" in characteristic.properties:
                    subscribable.append(characteristic)

                for descriptor in characteristic.descriptors:
                    record(f"       descriptor {descriptor.uuid}  {descriptor.description}")
            record()

        if not subscribable:
            record("No notifying characteristic is exposed to an unauthenticated client.")
        else:
            record(f"subscribing to {len(subscribable)} notifying characteristic(s) for {listen_seconds:.0f}s")
            record("(nothing is written to the controller, so anything arriving here is unprompted)")
            subscribed = []
            for characteristic in subscribable:
                try:
                    await client.start_notify(characteristic, on_notify)
                    subscribed.append(characteristic)
                except Exception as error:
                    record(f"  subscribe refused on {characteristic.uuid}: {error}")

            await asyncio.sleep(listen_seconds)

            for characteristic in subscribed:
                try:
                    await client.stop_notify(characteristic)
                except Exception:
                    # The link may already be gone; nothing to unsubscribe from.
                    pass

            record()
            if notifications:
                record(f"{len(notifications)} notification(s):")
                report.extend(notifications)
                for line in notifications:
                    print(line)
            else:
                record("Nothing arrived unprompted. A register read would have to be requested.")

    destination = OUT / "victron-gatt.txt"
    destination.write_text("\n".join(report) + "\n")
    print(f"\nwrote {destination}", file=sys.stderr)


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--address", default=None, help="controller address/UUID, to skip discovery")
    parser.add_argument("--scan-seconds", type=float, default=8.0, help="how long to scan when discovering")
    parser.add_argument("--listen", type=float, default=10.0, help="how long to wait for unprompted notifications")
    args = parser.parse_args()

    address = args.address
    if address is None:
        found = await scan_for_controllers(args.scan_seconds)
        if not found:
            print(
                "No Victron controller in range. It advertises about once a second, so this is "
                "usually the radio being asleep or the Mac lacking Bluetooth permission.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        if len(found) > 1:
            # A marina puts other people's controllers in range, and signal strength does not say
            # whose is whose. Connecting is not passive — the controller accepts one client, so
            # picking wrong knocks a stranger's app off their own charger.
            print(f"{len(found)} Victron controllers are in range. Naming one is on you:", file=sys.stderr)
            for device, advertisement in sorted(found, key=lambda pair: -(pair[1].rssi or -999)):
                print(
                    f"  {advertisement.rssi:>4} dBm  {device.address}  {device.name or '(no name)'}",
                    file=sys.stderr,
                )
            print("Re-run with --address <UUID>, matching the name in VictronConnect.", file=sys.stderr)
            raise SystemExit(1)

        controller, advertisement = found[0]
        print(
            f"found {controller.name or '(no name)'} @ {controller.address} at {advertisement.rssi} dBm",
            file=sys.stderr,
        )
        address = controller.address

    try:
        await probe(address, args.listen)
    except Exception as error:
        print(f"\nprobe failed: {type(error).__name__}: {error}", file=sys.stderr)
        print(
            "A refusal here is itself the finding. Record whether it demanded bonding or a PIN, "
            "and whether VictronConnect was holding the link.",
            file=sys.stderr,
        )
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
