#!/usr/bin/env python3
"""
Ask a Victron SmartSolar whether it will serve its stored history at all.

The controller carries a VE.Direct tunnel on GATT service 306b0001. Register 0x0140 holds a
capability word whose bit 2 the vendor documents as "history supported". Reading that one word is
the cheapest form of the question: if the bit is clear, nothing further is worth building, and no
history register was ever addressed to find out.

Nothing here writes a register. The five session-open frames are the sequence VictronConnect itself
sends, and the only request that follows is opcode 0x05 — a read. The guard below refuses to build
anything else, because on this tunnel a read and a write differ by one byte, and 0x1030 is
"clear history": addressing it with a write erases the thirty-one days the whole exercise exists to
preserve.

Two operational facts, both from Victron. The controller accepts one client at a time, so this locks
VictronConnect out while it runs. And while any client is connected the charger changes how it
advertises, so a scanner filtering on connectable advertisements goes quiet until the session closes.

Usage:
  python victron_tunnel_probe.py --address <UUID>
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path

from bleak import BleakClient

SERVICE = "306b0001-b081-4037-83dc-e59fcc3cdfd0"
CONTROL = "306b0002-b081-4037-83dc-e59fcc3cdfd0"
COMMAND = "306b0003-b081-4037-83dc-e59fcc3cdfd0"
BULK = "306b0004-b081-4037-83dc-e59fcc3cdfd0"

OUT = Path(__file__).resolve().parent.parent / "captures"

#: The session the device expects before it will answer anything. Written in this order; the last is
#: a keepalive telling it to hold the link for ten seconds, which has to be repeated to stay open.
SESSION_OPEN_CONTROL = [bytes.fromhex("fa80ff"), bytes.fromhex("f980")]
SESSION_OPEN_COMMAND = [bytes.fromhex("01"), bytes.fromhex("0300")]
KEEPALIVE = bytes.fromhex("0600821893421027")
KEEPALIVE_INTERVAL_SECONDS = 3.4

READ_OPCODE = 0x05
#: Bit 2 is the history-supported flag. Nothing else may be asked for: every history register lives
#: next to `clear history`, and this script has no business near it.
CAPABILITIES_REGISTER = 0x0140
READABLE_REGISTERS = frozenset({CAPABILITIES_REGISTER})

HISTORY_SUPPORTED_BIT = 1 << 2


def build_read_request(register: int, interface: int) -> bytes:
    if register not in READABLE_REGISTERS:
        raise ValueError(f"refusing to request register 0x{register:04x}")
    # The register id rides big-endian because it is a CBOR unsigned integer and CBOR says so, while
    # the payload of any reply stays little-endian. Inverting these is the classic way to read a
    # plausible wrong number off this tunnel.
    #
    # The interface byte is not fixed. Captures show 0x00, 0x01 and 0x03 from one app session, so it
    # is worth asking on more than one before concluding the register is unanswerable.
    return bytes([READ_OPCODE, interface, 0x81, 0x19, (register >> 8) & 0xFF, register & 0xFF])


def register_of(payload: bytes) -> int | None:
    """The register a value report answers for, or None if this is not one."""
    if len(payload) < 4 or payload[0] != 0x08:
        return None
    if payload[2] == 0x18:
        return payload[3]
    if payload[2] == 0x19 and len(payload) >= 5:
        return (payload[3] << 8) | payload[4]
    return None


def describe_capabilities(payload: bytes) -> str:
    if not payload:
        return "empty payload"
    word = int.from_bytes(payload[:4].ljust(4, b"\x00"), "little")
    supported = bool(word & HISTORY_SUPPORTED_BIT)
    return (
        f"capability word 0x{word:08x}\n"
        f"  bit 2 (history supported): {'YES' if supported else 'no'}"
    )


async def probe(address: str, listen_seconds: float) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    received: list[tuple[float, str, bytes]] = []
    start = time.time()

    def on_notify(characteristic, data: bytearray) -> None:
        received.append((time.time() - start, characteristic.uuid[:8], bytes(data)))

    print(f"connecting to {address} ...", file=sys.stderr)
    async with BleakClient(address) as client:
        print("connected; subscribing before writing anything", file=sys.stderr)
        for uuid in (CONTROL, COMMAND, BULK):
            await client.start_notify(uuid, on_notify)

        for frame in SESSION_OPEN_CONTROL:
            await client.write_gatt_char(CONTROL, frame, response=False)
            await asyncio.sleep(0.2)
        for frame in SESSION_OPEN_COMMAND:
            await client.write_gatt_char(COMMAND, frame, response=False)
            await asyncio.sleep(0.2)
        await client.write_gatt_char(COMMAND, KEEPALIVE, response=False)
        print("session opened; asking for the capability register only", file=sys.stderr)

        # The keepalive is answered on interface 0x00, so that is the one the device is certainly
        # listening on; the others are asked in case the read path differs from the control path.
        for interface in (0x00, 0x03, 0x01):
            await asyncio.sleep(0.6)
            request = build_read_request(CAPABILITIES_REGISTER, interface)
            print(f"  -> iface 0x{interface:02x}: {request.hex()}", file=sys.stderr)
            await client.write_gatt_char(COMMAND, request, response=False)
            await asyncio.sleep(1.5)

        deadline = time.time() + listen_seconds
        while time.time() < deadline:
            await asyncio.sleep(KEEPALIVE_INTERVAL_SECONDS)
            await client.write_gatt_char(COMMAND, KEEPALIVE, response=False)

        for uuid in (CONTROL, COMMAND, BULK):
            try:
                await client.stop_notify(uuid)
            except Exception:
                # The link may already be gone; nothing to unsubscribe from.
                pass

    lines = [f"# Victron tunnel capability probe — {address}", ""]
    lines.append(f"notifications received: {len(received)}")
    for at, source, payload in received:
        lines.append(f"  {at:6.2f}s  char {source}  {payload.hex()}")

    # The keepalive is itself acknowledged as a value report for VReg 0x93, so a reply only counts as
    # an answer if it names the register that was actually asked for.
    keepalive_acks = [p for _, _, p in received if register_of(p) == 0x93]
    answers = [p for _, _, p in received if register_of(p) == CAPABILITIES_REGISTER]
    refusals = [p for _, _, p in received if p[:1] == b"\x09"]
    errors = [p for _, _, p in received if p[:1] == b"\x07"]

    lines.append("")
    lines.append(f"keepalive acknowledgements (VReg 0x93): {len(keepalive_acks)}")
    lines.append(f"  -> the session opened; the tunnel is answering.")
    lines.append(f"answers for register 0x{CAPABILITIES_REGISTER:04x}: {len(answers)}")
    lines.append(f"refusals (opcode 0x09, register unsupported): {len(refusals)}")
    lines.append(f"errors (opcode 0x07): {len(errors)}")
    lines.append("")
    if answers:
        for payload in answers:
            lines.append(f"value report: {payload.hex()}")
            lines.append(describe_capabilities(payload[4 if payload[2] == 0x18 else 5:]))
    elif refusals:
        lines.append("The controller refused the register outright, which is a clear answer:")
        lines.append("this firmware does not expose the capability word over the tunnel.")
    else:
        lines.append("The session works and the keepalive is acknowledged, but the read drew no")
        lines.append("reply of any kind. The tunnel is reachable and this register is not.")

    report = "\n".join(lines)
    print("\n" + report)
    (OUT / "victron-tunnel-probe.txt").write_text(report + "\n")


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--address", required=True, help="controller address/UUID — never guessed")
    parser.add_argument("--listen", type=float, default=15.0, help="how long to hold the session open")
    args = parser.parse_args()
    await probe(args.address, args.listen)


if __name__ == "__main__":
    asyncio.run(main())
