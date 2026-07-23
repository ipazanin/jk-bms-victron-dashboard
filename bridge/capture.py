#!/usr/bin/env python3
"""
One-shot development capture for the JK-BMS / Victron dashboard.

Runs on the boat's Mac, where CoreBluetooth works even though Chrome's requestLEScan does not.
Pulls everything useful for building the Stats/History tab offline after leaving the boat:

  * every JK-BMS frame type over GATT — device info (0x97), cell info (0x96), settings (0x01,
    pushed) and the event LOGBOOK (0xA1 -> frame 0x05), as raw 300-byte hex,
  * a short live time series of cell-info frames,
  * decoded lifetime-counter candidates at BOTH this repo's offsets and esphome's, so the
    firmware's real layout is settled from data, not guessed,
  * raw Victron "Instant Readout" advertisements (company id 0x02E1) with RSSI.

Nothing is decrypted and no Victron key is used or needed: the advertisement bytes captured are
the same public broadcast any device in range receives.

Usage:
  python capture.py scan                 # list nearby BLE devices, find the BMS + the Victron
  python capture.py bms [--address UUID] [--seconds 45]
  python capture.py solar [--seconds 60]
  python capture.py all                  # scan, then bms, then solar
"""

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

JK_SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb"
JK_CHARACTERISTIC = "0000ffe1-0000-1000-8000-00805f9b34fb"
VICTRON_COMPANY_ID = 0x02E1

CMD_DEVICE_INFO = 0x97
CMD_CELL_INFO = 0x96
CMD_LOGBOOK = 0xA1

COMMAND_HEADER = bytes([0xAA, 0x55, 0x90, 0xEB])
RESPONSE_HEADER = bytes([0x55, 0xAA, 0xEB, 0x90])
FRAME_LENGTH = 300
COMMAND_LENGTH = 20

FRAME_NAMES = {0x01: "settings", 0x02: "cell-info", 0x03: "device-info", 0x05: "logbook"}

OUT = Path(__file__).resolve().parent.parent / "captures"


def out_dir() -> Path:
    (OUT / "frames").mkdir(parents=True, exist_ok=True)
    return OUT


def build_command(command: int) -> bytes:
    frame = bytearray(COMMAND_LENGTH)
    frame[0:4] = COMMAND_HEADER
    frame[4] = command
    frame[19] = sum(frame[0:19]) & 0xFF
    return bytes(frame)


def checksum_ok(frame: bytes) -> bool:
    return len(frame) == FRAME_LENGTH and (sum(frame[0 : FRAME_LENGTH - 1]) & 0xFF) == frame[FRAME_LENGTH - 1]


class FrameAssembler:
    """Reassembles 300-byte JK frames from arbitrary notification chunks (mirrors protocol.ts)."""

    def __init__(self) -> None:
        self.buffer = bytearray()

    def feed(self, chunk: bytes) -> list[bytes]:
        self.buffer.extend(chunk)
        frames: list[bytes] = []
        search_from = 0
        while True:
            start = self.buffer.find(RESPONSE_HEADER, search_from)
            if start == -1:
                keep = max(0, len(self.buffer) - (len(RESPONSE_HEADER) - 1))
                del self.buffer[:keep]
                return frames
            if len(self.buffer) - start < FRAME_LENGTH:
                del self.buffer[:start]
                return frames
            frame = bytes(self.buffer[start : start + FRAME_LENGTH])
            if checksum_ok(frame):
                frames.append(frame)
                del self.buffer[: start + FRAME_LENGTH]
                search_from = 0
            else:
                search_from = start + 1


def u16(frame: bytes, off: int) -> int:
    return int.from_bytes(frame[off : off + 2], "little")


def u32(frame: bytes, off: int) -> int:
    return int.from_bytes(frame[off : off + 4], "little")


def decode_cell_candidates(frame: bytes) -> dict:
    """Print lifetime counters at this repo's offsets AND esphome's, to settle the layout."""

    def safe(fn):
        try:
            return fn()
        except Exception:
            return None

    return {
        # this repo (decode.ts): CYCLE_COUNT=182, CYCLED_CAPACITY=186 (*0.001)
        "repo_cycleCount@182": safe(lambda: u32(frame, 182)),
        "repo_cycledCapacityAh@186": safe(lambda: round(u32(frame, 186) * 0.001, 3)),
        # esphome JK02_32S: cycles@150, cycledAh@154(*0.001), soh@158, runtime_s@162
        "esphome_cycleCount@150": safe(lambda: u32(frame, 150)),
        "esphome_cycledCapacityAh@154": safe(lambda: round(u32(frame, 154) * 0.001, 3)),
        "esphome_soh@158": safe(lambda: frame[158]),
        "esphome_runtime_s@162": safe(lambda: u32(frame, 162)),
        # esphome soc/remaining for cross-check
        "esphome_soc@141": safe(lambda: frame[141]),
        "esphome_remainingAh@142": safe(lambda: round(u32(frame, 142) * 0.001, 3)),
        "esphome_fullAh@146": safe(lambda: round(u32(frame, 146) * 0.001, 3)),
    }


def decode_logbook(frame: bytes) -> list[dict]:
    """esphome logbook: 5-byte entries after the header — 4-byte value + 1-byte event code.

    Layout is not certain across firmware; the raw hex is saved regardless. This is a best-effort
    parse over the payload region so the shape is visible in the summary."""
    entries = []
    # Payload begins after the 4-byte header + frame-type byte; scan 5-byte records until zeros.
    body = frame[6 : FRAME_LENGTH - 1]
    for i in range(0, len(body) - 5, 5):
        rec = body[i : i + 5]
        value = int.from_bytes(rec[0:4], "little")
        code = rec[4]
        if value == 0 and code == 0:
            continue
        entries.append({"raw": rec.hex(), "value": value, "code": code})
    return entries


async def find_devices(seconds: float = 8.0):
    print(f"scanning {seconds:.0f}s for BLE devices...", file=sys.stderr)
    found: dict[str, tuple[BLEDevice, AdvertisementData]] = {}

    def cb(device: BLEDevice, adv: AdvertisementData) -> None:
        found[device.address] = (device, adv)

    scanner = BleakScanner(detection_callback=cb)
    await scanner.start()
    await asyncio.sleep(seconds)
    await scanner.stop()

    jk = None
    victron = None
    lines = []
    for address, (device, adv) in sorted(found.items(), key=lambda kv: -(kv[1][1].rssi or -999)):
        services = [s.lower() for s in (adv.service_uuids or [])]
        is_jk = (device.name or "").upper().startswith("JK") or any("ffe0" in s for s in services)
        is_victron = VICTRON_COMPANY_ID in (adv.manufacturer_data or {})
        tag = " <JK-BMS>" if is_jk else (" <VICTRON>" if is_victron else "")
        lines.append(f"  {adv.rssi:>4} dBm  {address}  {device.name or '(no name)'}{tag}")
        if is_jk and jk is None:
            jk = device
        if is_victron and victron is None:
            victron = device
    report = "\n".join(lines)
    print(report)
    out_dir()
    (OUT / "scan.txt").write_text(report + "\n")
    return jk, victron


async def capture_bms(address: str | None, seconds: float) -> None:
    out_dir()
    if address is None:
        jk, _ = await find_devices()
        if jk is None:
            print("No JK-BMS found. Close the JK phone app and any Chrome tab connected to it, then retry.", file=sys.stderr)
            return
        address = jk.address
        print(f"using BMS {jk.name} @ {address}", file=sys.stderr)

    assembler = FrameAssembler()
    frames_log = (OUT / "bms-frames.jsonl").open("w")
    latest: dict[int, bytes] = {}
    counts: dict[int, int] = {}
    start = time.time()

    def on_notify(_handle, data: bytearray) -> None:
        for frame in assembler.feed(bytes(data)):
            ftype = frame[4]
            latest[ftype] = frame
            counts[ftype] = counts.get(ftype, 0) + 1
            frames_log.write(json.dumps({"t": round(time.time() - start, 3), "type": ftype, "hex": frame.hex()}) + "\n")

    print(f"connecting to {address} ...", file=sys.stderr)
    async with BleakClient(address) as client:
        print("connected. subscribing + polling device/cell/logbook.", file=sys.stderr)
        char = None
        for service in client.services:
            for c in service.characteristics:
                if c.uuid.lower() == JK_CHARACTERISTIC:
                    char = c
        if char is None:
            print("characteristic 0xFFE1 not found — dumping GATT table instead.", file=sys.stderr)
            (OUT / "bms-gatt.txt").write_text(
                "\n".join(f"{s.uuid}\n  " + "\n  ".join(c.uuid for c in s.characteristics) for s in client.services)
            )
            return

        write_no_resp = "write-without-response" in char.properties

        await client.start_notify(JK_CHARACTERISTIC, on_notify)

        async def send(cmd: int) -> None:
            await client.write_gatt_char(JK_CHARACTERISTIC, build_command(cmd), response=not write_no_resp)

        await send(CMD_DEVICE_INFO)
        await asyncio.sleep(2.0)
        await send(CMD_CELL_INFO)
        await asyncio.sleep(2.0)
        await send(CMD_LOGBOOK)
        await asyncio.sleep(3.0)

        # Live time series of whatever the BMS keeps streaming (cell info).
        print(f"collecting a {seconds:.0f}s time series...", file=sys.stderr)
        await asyncio.sleep(seconds)
        await client.stop_notify(JK_CHARACTERISTIC)

    frames_log.close()

    summary = [f"frame counts: " + ", ".join(f"0x{t:02x} {FRAME_NAMES.get(t,'?')}={n}" for t, n in sorted(counts.items()))]
    for ftype, frame in sorted(latest.items()):
        name = FRAME_NAMES.get(ftype, f"type-{ftype:02x}")
        path = OUT / "frames" / f"{name}-0x{ftype:02x}.hex"
        path.write_text(frame.hex() + "\n")
        summary.append(f"\n== 0x{ftype:02x} {name} == saved {path.name}")
        if ftype == 0x02:
            for k, v in decode_cell_candidates(frame).items():
                summary.append(f"   {k} = {v}")
        if ftype == 0x05:
            entries = decode_logbook(frame)
            summary.append(f"   logbook entries (best-effort): {len(entries)}")
            for e in entries[:20]:
                summary.append(f"   {e}")
    report = "\n".join(summary)
    print("\n" + report)
    (OUT / "bms-summary.txt").write_text(report + "\n")
    print(f"\nsaved to {OUT}", file=sys.stderr)


async def capture_solar(seconds: float) -> None:
    out_dir()
    log = (OUT / "victron-adv.jsonl").open("w")
    count = 0
    start = time.time()

    def cb(device: BLEDevice, adv: AdvertisementData) -> None:
        nonlocal count
        payload = (adv.manufacturer_data or {}).get(VICTRON_COMPANY_ID)
        if not payload:
            return
        count += 1
        log.write(
            json.dumps(
                {
                    "t": round(time.time() - start, 3),
                    "address": device.address,
                    "name": device.name,
                    "rssi": adv.rssi,
                    "mfg": payload.hex(),
                }
            )
            + "\n"
        )

    print(f"scanning {seconds:.0f}s for Victron advertisements (company 0x02E1)...", file=sys.stderr)
    scanner = BleakScanner(detection_callback=cb)
    await scanner.start()
    await asyncio.sleep(seconds)
    await scanner.stop()
    log.close()
    print(f"captured {count} Victron advertisements -> {OUT / 'victron-adv.jsonl'}", file=sys.stderr)


async def capture_combined(address: str | None, seconds: float) -> None:
    """Both radios at once: a live GATT pack series and Victron advertisements, written incrementally
    so a capture cut short when the boat's owner disconnects keeps everything that streamed."""
    out_dir()
    if address is None:
        jk, _ = await find_devices()
        if jk is None:
            print("No JK-BMS found. Close the JK phone app + any Chrome tab on it, then retry.", file=sys.stderr)
            return
        address = jk.address
        print(f"using BMS {jk.name} @ {address}", file=sys.stderr)

    assembler = FrameAssembler()
    frames_log = (OUT / "bms-frames.jsonl").open("w")
    solar_log = (OUT / "victron-adv.jsonl").open("w")
    latest: dict[int, bytes] = {}
    counts: dict[int, int] = {}
    solar_count = 0
    start = time.time()

    def on_notify(_handle, data: bytearray) -> None:
        for frame in assembler.feed(bytes(data)):
            ftype = frame[4]
            latest[ftype] = frame
            counts[ftype] = counts.get(ftype, 0) + 1
            frames_log.write(json.dumps({"t": round(time.time() - start, 3), "type": ftype, "hex": frame.hex()}) + "\n")
            frames_log.flush()

    def on_adv(device: BLEDevice, adv: AdvertisementData) -> None:
        nonlocal solar_count
        payload = (adv.manufacturer_data or {}).get(VICTRON_COMPANY_ID)
        if not payload:
            return
        solar_count += 1
        solar_log.write(
            json.dumps({"t": round(time.time() - start, 3), "address": device.address, "name": device.name, "rssi": adv.rssi, "mfg": payload.hex()})
            + "\n"
        )
        solar_log.flush()

    print(f"connecting to {address} ...", file=sys.stderr)
    scanner = BleakScanner(detection_callback=on_adv)
    async with BleakClient(address) as client:
        print(f"connected. paired capture for {seconds:.0f}s (Ctrl-C to stop early; data is kept).", file=sys.stderr)
        char = next((c for s in client.services for c in s.characteristics if c.uuid.lower() == JK_CHARACTERISTIC), None)
        if char is None:
            print("characteristic 0xFFE1 not found.", file=sys.stderr)
            return
        write_no_resp = "write-without-response" in char.properties
        await client.start_notify(JK_CHARACTERISTIC, on_notify)
        await scanner.start()

        async def send(cmd: int) -> None:
            await client.write_gatt_char(JK_CHARACTERISTIC, build_command(cmd), response=not write_no_resp)

        await send(CMD_DEVICE_INFO)
        await asyncio.sleep(1.5)
        await send(CMD_LOGBOOK)
        await asyncio.sleep(1.5)
        await send(CMD_CELL_INFO)

        try:
            await asyncio.sleep(seconds)
        finally:
            try:
                await scanner.stop()
                await client.stop_notify(JK_CHARACTERISTIC)
            except Exception:
                pass

    frames_log.close()
    solar_log.close()

    summary = [
        f"paired capture {round(time.time() - start)}s",
        f"solar advertisements: {solar_count}",
        "frame counts: " + ", ".join(f"0x{t:02x} {FRAME_NAMES.get(t,'?')}={n}" for t, n in sorted(counts.items())),
    ]
    for ftype, frame in sorted(latest.items()):
        name = FRAME_NAMES.get(ftype, f"type-{ftype:02x}")
        (OUT / "frames" / f"{name}-0x{ftype:02x}.hex").write_text(frame.hex() + "\n")
        summary.append(f"saved frames/{name}-0x{ftype:02x}.hex")
        if ftype == 0x05:
            summary.append(f"   logbook entries (best-effort): {len(decode_logbook(frame))}")
    report = "\n".join(summary)
    print("\n" + report)
    (OUT / "bms-summary.txt").write_text(report + "\n")


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["scan", "bms", "solar", "combined", "all"], nargs="?", default="all")
    parser.add_argument("--address", default=None, help="BMS CoreBluetooth address/UUID to skip discovery")
    parser.add_argument("--seconds", type=float, default=None, help="capture window")
    args = parser.parse_args()

    if args.mode == "scan":
        await find_devices()
    elif args.mode == "bms":
        await capture_bms(args.address, args.seconds or 45.0)
    elif args.mode == "solar":
        await capture_solar(args.seconds or 60.0)
    elif args.mode == "combined":
        await capture_combined(args.address, args.seconds or 180.0)
    else:
        await find_devices()
        await capture_bms(args.address, args.seconds or 45.0)
        await capture_solar(args.seconds or 60.0)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
