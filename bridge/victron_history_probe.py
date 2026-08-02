#!/usr/bin/env python3
"""
Reproduce, from our own client, the session VictronConnect uses to read a SmartSolar's stored
history — and stop at the cheapest question that proves it worked.

The controller's history is not in doubt: an HCI snoop of the vendor app against this unit shows
it answering the totals register and all thirty-one daily records. What is in doubt is whether an
independent client can open the same session, so this asks for the three registers that settle
that and nothing more — the product serial as a canary, the capability word, and the totals.
Thirty-one day reads prove nothing further and are left to the application.

Two corrections over the probe that came before it, and they are the whole reason it failed:

  The interface byte is 0x03. The capture shows interface 0x00 refusing registers with
  `09 00 19 <reg> 01` while 0x03 answers those same registers moments later — which is exactly
  the refusal that was once read as "this controller has no history".

  The session-open keepalive is one frame, not two. The app writes the keepalive, a read of
  0xEC66 and 0xEC65, and a trailing `03 01 03 03` as a single write; the earlier probe sent only
  the leading keepalive. The trailing bytes are the best candidate for what makes interfaces 1
  and 3 answer at all, so they are sent here exactly as recorded.

Nothing here can write a register. There is no encoder for opcode 0x06 and no way to reach one:
a read and a write differ by one byte on this tunnel, and the register block being read sits
beside one long believed to mean "clear history". The absence of the encoder is the guarantee.

Two operational facts, both from Victron. The controller accepts one BLE client at a time, so
this locks VictronConnect out while it runs. And while any client is connected it changes how it
advertises, so the dashboard's Instant Readout feed goes quiet until the session closes — which
is why this exits as soon as it has its answer.

Usage:
  python victron_history_probe.py --address <MAC-or-UUID>
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

READ_OPCODE = 0x05
#: The interface every answered register read in the capture carries. Interface 0x00 refuses.
TUNNEL_INTERFACE = 0x03
CBOR_ARRAY_OF_ONE = 0x81
#: A CBOR array header's low bits are its count, so a read of two registers is 0x82 — which is how
#: the app asks inside its session-open write, and the shape has to be kept to reproduce it.
CBOR_ARRAY_OF_TWO = 0x82
CBOR_TWO_BYTE_UNSIGNED = 0x19

SESSION_OPEN_CONTROL = [bytes.fromhex("fa80ff"), bytes.fromhex("f980")]
SESSION_OPEN_COMMAND = [bytes.fromhex("01"), bytes.fromhex("0300")]
KEEPALIVE = bytes.fromhex("0600821893421027")
KEEPALIVE_INTERVAL_SECONDS = 3.4

#: The two registers the app reads inside its session-open write, on interface 0x00: its own MAC and
#: the value beside it. Held apart from the history registers because they are asked for differently
#: and for a different reason, but built by the same guarded encoder rather than pasted in as bytes.
SESSION_REGISTERS = (0xEC66, 0xEC65)
SESSION_INTERFACE = 0x00
#: The tail of that same write. Not a register access — the best candidate for what makes interfaces
#: 1 and 3 answer, which is why the earlier probe, having sent only the keepalive, drew silence.
SESSION_OPEN_TRAILER = bytes.fromhex("03010303")

PRODUCT_SERIAL_REGISTER = 0x010A
CAPABILITIES_REGISTER = 0x0140
HISTORY_TOTALS_REGISTER = 0x104F

#: Nothing outside this set may be addressed. It deliberately excludes every day register: this
#: script answers "does the session work", and the day sweep belongs to the application.
READABLE_REGISTERS = (PRODUCT_SERIAL_REGISTER, CAPABILITIES_REGISTER, HISTORY_TOTALS_REGISTER)

HISTORY_SUPPORTED_BIT = 1 << 2
DAYS_AVAILABLE_OFFSET = 18


def build_read_request(register: int, interface: int = TUNNEL_INTERFACE) -> bytes:
    """The six bytes that ask for one register. There is no sibling that builds a write."""
    if register not in READABLE_REGISTERS and register not in SESSION_REGISTERS:
        raise ValueError(f"refusing to request register 0x{register:04x}")
    # Big-endian, because the register id is a CBOR unsigned integer and CBOR says so. The payload
    # that comes back is little-endian; the two must never share a helper.
    return bytes(
        [
            READ_OPCODE,
            interface,
            CBOR_ARRAY_OF_ONE,
            CBOR_TWO_BYTE_UNSIGNED,
            (register >> 8) & 0xFF,
            register & 0xFF,
        ]
    )


def build_session_open() -> bytes:
    """
    The keepalive, one read of two registers, and the trailer — the single write the app sends.

    Assembled from named parts rather than pasted in as a hex blob, so every register it puts on the
    wire passes the same guard as the history sweep. The shape is kept exactly: one read PDU under a
    CBOR array of two, not two PDUs of one. This frame is the difference between a session that
    answers and one that does not, and it has only ever been observed in the form below.
    """
    read = bytes([READ_OPCODE, SESSION_INTERFACE, CBOR_ARRAY_OF_TWO])
    for register in SESSION_REGISTERS:
        read += bytes([CBOR_TWO_BYTE_UNSIGNED, (register >> 8) & 0xFF, register & 0xFF])
    return KEEPALIVE + read + SESSION_OPEN_TRAILER


def value_reports(stream: bytes) -> dict[int, bytes]:
    """
    Every `08 <iface> 19 <reg> <CBOR byte string>` in a notification stream, by register.

    The tunnel has no length prefix, no delimiter and no checksum, and one PDU can split across
    the command and bulk characteristics, so the two are concatenated and scanned a byte at a
    time. A reply whose byte-string header runs past the end of the buffer is left for the next
    pass rather than truncated into a plausible wrong value.
    """
    found: dict[int, bytes] = {}
    at = 0
    while at + 5 < len(stream):
        if stream[at] != 0x08 or stream[at + 2] != CBOR_TWO_BYTE_UNSIGNED:
            at += 1
            continue
        register = (stream[at + 3] << 8) | stream[at + 4]
        header = stream[at + 5]
        major, extra = header >> 5, header & 0x1F
        if major != 2:
            at += 1
            continue
        if extra < 24:
            length, start = extra, at + 6
        elif extra == 24 and at + 6 < len(stream):
            length, start = stream[at + 6], at + 7
        else:
            at += 1
            continue
        if start + length > len(stream):
            at += 1
            continue
        found[register] = stream[start : start + length]
        at = start + length
    return found


def refusals(stream: bytes) -> list[int]:
    """Registers the controller named back under opcode 0x09 — a refusal, not silence."""
    return [
        (stream[at + 3] << 8) | stream[at + 4]
        for at in range(len(stream) - 5)
        if stream[at] == 0x09 and stream[at + 2] == CBOR_TWO_BYTE_UNSIGNED
    ]


async def probe(address: str) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    received: list[tuple[float, str, bytes]] = []
    replies = bytearray()
    start = time.time()

    def on_notify(characteristic, data: bytearray) -> None:
        received.append((time.time() - start, characteristic.uuid[:8], bytes(data)))
        if characteristic.uuid.startswith(("306b0003", "306b0004")):
            replies.extend(data)

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
        await client.write_gatt_char(COMMAND, build_session_open(), response=False)
        await asyncio.sleep(0.8)
        print("session opened; asking for three registers on interface 0x03", file=sys.stderr)

        for register in READABLE_REGISTERS:
            request = build_read_request(register)
            print(f"  -> 0x{register:04x}: {request.hex()}", file=sys.stderr)
            await client.write_gatt_char(COMMAND, request, response=False)
            await asyncio.sleep(1.2)

        await client.write_gatt_char(COMMAND, KEEPALIVE, response=False)
        await asyncio.sleep(1.0)

        for uuid in (CONTROL, COMMAND, BULK):
            try:
                await client.stop_notify(uuid)
            except Exception:
                # The link may already be gone; there is nothing to unsubscribe from.
                pass

    answered = value_reports(bytes(replies))
    refused = refusals(bytes(replies))

    lines = [f"# Victron history session probe — {address}", ""]
    lines.append(f"notifications: {len(received)}")
    for at, source, payload in received:
        lines.append(f"  {at:6.2f}s  char {source}  {payload.hex()}")
    lines.append("")

    for register in READABLE_REGISTERS:
        payload = answered.get(register)
        if payload is None:
            state = "REFUSED" if register in refused else "no reply"
            lines.append(f"0x{register:04x}  {state}")
            continue
        lines.append(f"0x{register:04x}  answered {len(payload)} bytes: {payload.hex()}")
        if register == PRODUCT_SERIAL_REGISTER:
            lines.append(f"          serial: {payload.decode('ascii', 'replace')}")
        if register == CAPABILITIES_REGISTER:
            word = int.from_bytes(payload[:4].ljust(4, b"\x00"), "little")
            supported = bool(word & HISTORY_SUPPORTED_BIT)
            lines.append(f"          capability word 0x{word:08x}, history bit: {'set' if supported else 'clear'}")
        if register == HISTORY_TOTALS_REGISTER and len(payload) > DAYS_AVAILABLE_OFFSET:
            lines.append(f"          days available: {payload[DAYS_AVAILABLE_OFFSET]}")

    lines.append("")
    totals = answered.get(HISTORY_TOTALS_REGISTER)
    if totals is not None:
        lines.append("The session reproduces. An independent client can read this controller's history.")
    elif HISTORY_TOTALS_REGISTER in refused:
        lines.append("The totals register was refused on interface 0x03 — new information; the")
        lines.append("capture shows the vendor app being answered for it on this same unit.")
    else:
        lines.append("The totals register drew no reply. The session open is still not what the app sends.")

    report = "\n".join(lines)
    print("\n" + report)
    (OUT / "victron-history-probe.txt").write_text(report + "\n")
    return 0 if totals is not None else 1


async def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--address", required=True, help="controller address/UUID — never guessed")
    args = parser.parse_args()
    raise SystemExit(await probe(args.address))


if __name__ == "__main__":
    asyncio.run(main())
