#!/usr/bin/env python3
"""Decode captured JK-BMS frames with the SAME offsets as src/domain/bms/decode.ts, plus the
event logbook (0x05). For development documentation of a real capture — read-only, no device."""

import sys
from pathlib import Path

DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "captures"
FRAMES = DIR / "frames"


def load(name: str) -> bytes | None:
    p = FRAMES / name
    if not p.exists():
        return None
    return bytes.fromhex(p.read_text().strip())


def u16(f, o):
    return int.from_bytes(f[o : o + 2], "little")


def u32(f, o):
    return int.from_bytes(f[o : o + 4], "little")


def i16(f, o):
    return int.from_bytes(f[o : o + 2], "little", signed=True)


def i32(f, o):
    return int.from_bytes(f[o : o + 4], "little", signed=True)


def ascii_at(f, o, n):
    s = f[o : o + n]
    end = s.find(0)
    return (s if end == -1 else s[:end]).decode("ascii", "replace")


def popcount(v):
    return bin(v).count("1")


def decode_device_info(f):
    return {
        "model": ascii_at(f, 6, 16),
        "hardwareVersion": ascii_at(f, 22, 8),
        "softwareVersion": ascii_at(f, 30, 8),
        "uptimeSeconds": u32(f, 38),
        "powerOnCount": u32(f, 42),
        "serialNumber": ascii_at(f, 86, 16),
    }


def decode_cell_info(f):
    cells = min(32, popcount(u32(f, 70)))
    v = [u16(f, 6 + i * 2) * 0.001 for i in range(cells)]
    return {
        "cellCount": cells,
        "cellVoltages": [round(x, 3) for x in v],
        "cellDeltaV": round(max(v) - min(v), 3) if v else 0,
        "packVoltageV": round(u32(f, 150) * 0.001, 3),
        "powerW": round(u32(f, 154) * 0.001, 3),
        "currentA": round(i32(f, 158) * 0.001, 3),
        "stateOfCharge": f[173],
        "remainingCapacityAh": round(u32(f, 174) * 0.001, 3),
        "nominalCapacityAh": round(u32(f, 178) * 0.001, 3),
        "cycleCount": u32(f, 182),
        "cycledCapacityAh": round(u32(f, 186) * 0.001, 3),
        "mosfetTempC": round(i16(f, 144) * 0.1, 1),
        "temp1C": round(i16(f, 162) * 0.1, 1),
        "temp2C": round(i16(f, 164) * 0.1, 1),
        "uptimeSeconds": u32(f, 194),
        "chargingEnabled": f[198] == 1,
        "dischargingEnabled": f[199] == 1,
    }


def decode_settings(f):
    return {
        "cellUnderVoltageV": round(u32(f, 10) * 0.001, 3),
        "cellOverVoltageV": round(u32(f, 18) * 0.001, 3),
        "balanceTriggerDeltaV": round(u32(f, 26) * 0.001, 3),
        "maxBalanceCurrentA": round(u32(f, 78) * 0.001, 3),
        "cellCount": u32(f, 114),
        "balancerEnabled": u32(f, 126) == 1,
        "nominalCapacityAh": round(u32(f, 130) * 0.001, 3),
        "startBalanceVoltageV": round(u32(f, 138) * 0.001, 3),
    }


def fmt_uptime(seconds):
    d, r = divmod(int(seconds), 86400)
    h, r = divmod(r, 3600)
    m, s = divmod(r, 60)
    return f"{d}d {h:02d}h {m:02d}m {s:02d}s"


def decode_logbook(f):
    """5-byte entries after header+type: 4-byte seconds-since-boot + 1-byte event code."""
    body = f[6:-1]
    out = []
    for i in range(0, len(body) - 4, 5):
        rec = body[i : i + 5]
        value = int.from_bytes(rec[0:4], "little")
        code = rec[4]
        if value == 0 and code == 0:
            continue
        out.append((value, code, rec.hex()))
    return out


def main():
    print(f"# Decoded capture — {DIR}\n")
    di = load("device-info-0x03.hex")
    if di:
        print("## device-info (0x03)")
        for k, v in decode_device_info(di).items():
            extra = f"  ({fmt_uptime(v)})" if k == "uptimeSeconds" else ""
            print(f"  {k}: {v}{extra}")
        print()
    ci = load("cell-info-0x02.hex")
    if ci:
        print("## cell-info (0x02)")
        for k, v in decode_cell_info(ci).items():
            extra = f"  ({fmt_uptime(v)})" if k == "uptimeSeconds" else ""
            print(f"  {k}: {v}{extra}")
        print()
    st = load("settings-0x01.hex")
    if st:
        print("## settings (0x01)")
        for k, v in decode_settings(st).items():
            print(f"  {k}: {v}")
        print()
    lb = load("logbook-0x05.hex")
    if lb:
        entries = decode_logbook(lb)
        print(f"## logbook (0x05) — {len(entries)} events, timestamps = seconds since first power-on")
        for value, code, raw in entries:
            print(f"  {value:>10}s  {fmt_uptime(value):<16}  code=0x{code:02x} ({code:>3})   [{raw}]")
        print()
        from collections import Counter

        codes = Counter(c for _, c, _ in entries)
        print("  code histogram: " + ", ".join(f"0x{c:02x}×{n}" for c, n in sorted(codes.items())))


if __name__ == "__main__":
    main()
