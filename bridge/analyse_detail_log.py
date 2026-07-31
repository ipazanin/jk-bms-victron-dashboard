#!/usr/bin/env python3
"""
Derive the layout of a JK-BMS detail-log frame (type 0x06) from the bytes themselves.

`src/domain/bms/detailLog.ts` decodes these frames with a layout transcribed from a decompiled
vendor app — 24-byte records from offset 9, a uint16 LE first-record index at [6..7], a count at
[8], a uint32 RTC at each record's offset 0. Feeding a capture to that decoder proves nothing,
because it assumes exactly what needs proving.

So this tool assumes none of it. It searches record strides 8..64 against base offsets 5..16, scores
every hypothesis on whether a uint32 LE read at each record position gives a strictly ascending,
evenly spaced, plausibly-paced clock, and ranks them. Everything downstream — the sampling interval,
the epoch check, the field-scale dump — hangs off the winner rather than off the vendor's numbers.

What the searched base offset means: it is where the ascending uint32 actually sits, which is the
record base PLUS the RTC's offset inside a record. Those coincide only if the RTC really is the
first field of a record, which is itself part of what is unverified.

Usage:
  python analyse_detail_log.py                                   # captures/bms-frames.jsonl
  python analyse_detail_log.py analyse captures/bms-frames.jsonl
  python analyse_detail_log.py analyse some-frame.hex            # one frame per line, raw hex
  python analyse_detail_log.py analyse captures/bms-frames.jsonl \
      --cell-info captures/frames/cell-info-0x02.hex             # add the live cross-check
  python analyse_detail_log.py self-test                         # plant a known layout, recover it

The report goes to stdout and to captures/detail-log-analysis.txt.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

CAPTURES = Path(__file__).resolve().parent.parent / "captures"
DEFAULT_INPUT = CAPTURES / "bms-frames.jsonl"
DEFAULT_REPORT = CAPTURES / "detail-log-analysis.txt"

FRAME_LENGTH = 300
FRAME_TYPE_OFFSET = 4
FRAME_DETAIL_LOG = 0x06
FRAME_CELL_INFO = 0x02

#: Header bytes the vendor layout claims, printed raw for every frame and never used to drive a
#: decode. Naming them here keeps the report honest about what is being read where.
FRAME_COUNTER_OFFSET = 5
FIRST_RECORD_INDEX_OFFSET = 6
RECORD_COUNT_OFFSET = 8

VENDOR_RECORD_BASE = 9
VENDOR_RECORD_STRIDE = 24

SEARCHED_BASE_OFFSETS = range(5, 17)
SEARCHED_STRIDES = range(8, 65)

#: Three timestamps is the least that can show a rhythm: two differences to compare against each
#: other. Anything shorter scores zero rather than winning on a coincidence.
MINIMUM_TIMESTAMPS_TO_JUDGE = 3

#: A stored sample is at worst every half minute and at best daily. Outside that the ascending
#: uint32 is something other than a sampling clock.
SHORTEST_PLAUSIBLE_INTERVAL_SECONDS = 30
LONGEST_PLAUSIBLE_INTERVAL_SECONDS = 86_400

#: Twelve records is what the vendor layout says a frame holds, and it is used ONLY to normalise the
#: "how many records does this hypothesis support" term. A hypothesis carrying more scores no worse.
RECORDS_FOR_FULL_DEPTH = 12

RTC_EPOCH_YEAR = 2020

#: Confirmed on this firmware (19.10 / 19H) by captures/MANIFEST.md, which is why the cross-check is
#: allowed to lean on them while the detail-log offsets are not.
CELL_INFO_PACK_VOLTAGE_OFFSET = 150
CELL_INFO_PACK_POWER_OFFSET = 154
CELL_INFO_PACK_CURRENT_OFFSET = 158

PACK_VOLTAGE_MATCH_TOLERANCE_V = 0.15
PACK_CURRENT_MATCH_TOLERANCE_A = 0.5

SCALES = ((1.0, "x1"), (0.1, "x0.1"), (0.01, "x0.01"), (0.001, "x0.001"))

#: The temperature encoding used elsewhere in this protocol family: an unsigned byte biased by 40.
TEMPERATURE_BYTE_BIAS = 40


@dataclass(frozen=True)
class CapturedFrame:
    """One reassembled 300-byte frame, with the capture-relative time if the source carried one."""

    seconds: float | None
    frame_type: int
    raw: bytes


@dataclass(frozen=True)
class PlausibleReading:
    """A range a decoded number must land in to be worth a human's attention, for THIS pack."""

    label: str
    lowest: float
    highest: float
    signed_encoding_only: bool


#: Tuned to the boat's pack as recorded in captures/MANIFEST.md: 4 cells near 3.40 V, pack 13.61 V,
#: 315 Ah nominal, temperatures near 27 C.
PLAUSIBLE_READINGS = (
    PlausibleReading("cell", 3.0, 3.65, False),
    PlausibleReading("pack", 12.0, 14.6, False),
    PlausibleReading("current", -100.0, 100.0, True),
    PlausibleReading("capacity", 250.0, 330.0, False),
    PlausibleReading("temp", 0.0, 40.0, False),
)


@dataclass(frozen=True)
class StrideHypothesis:
    """One (base offset, stride) guess and how well an ascending clock read at it holds up."""

    base_offset: int
    stride: int
    timestamps: tuple[int, ...]
    differences: tuple[int, ...]
    steadiness: float
    pace_plausibility: float
    depth: float
    epoch_sanity: float
    score: float

    def record_count(self) -> int:
        return len(self.timestamps)

    def median_difference(self) -> float:
        if not self.differences:
            return 0.0
        return statistics.median(self.differences)

    def is_vendor_layout(self) -> bool:
        return self.base_offset == VENDOR_RECORD_BASE and self.stride == VENDOR_RECORD_STRIDE


def read_uint8(frame: bytes, offset: int) -> int:
    return frame[offset]


def read_int8(frame: bytes, offset: int) -> int:
    return int.from_bytes(frame[offset : offset + 1], "little", signed=True)


def read_uint16_le(frame: bytes, offset: int) -> int:
    return int.from_bytes(frame[offset : offset + 2], "little")


def read_int16_le(frame: bytes, offset: int) -> int:
    return int.from_bytes(frame[offset : offset + 2], "little", signed=True)


def read_uint32_le(frame: bytes, offset: int) -> int:
    return int.from_bytes(frame[offset : offset + 4], "little")


def read_int32_le(frame: bytes, offset: int) -> int:
    return int.from_bytes(frame[offset : offset + 4], "little", signed=True)


def payload_end(frame: bytes) -> int:
    """One past the last byte a field may occupy: the trailing byte is the frame checksum."""
    return len(frame) - 1


def load_frames(path: Path) -> tuple[CapturedFrame, ...]:
    """Reads either capture.py's JSONL or a plain hex dump, one frame per line."""
    if not path.exists():
        raise FileNotFoundError(path)
    lines = [line.strip() for line in path.read_text().splitlines() if line.strip()]
    if path.suffix == ".jsonl" or (lines and lines[0].startswith("{")):
        return tuple(load_jsonl_frames(lines))
    return tuple(load_hex_frames(lines))


def load_jsonl_frames(lines: list[str]) -> list[CapturedFrame]:
    frames: list[CapturedFrame] = []
    for position, line in enumerate(lines):
        try:
            record = json.loads(line)
            raw = bytes.fromhex(record["hex"])
        except (json.JSONDecodeError, KeyError, ValueError) as failure:
            print(f"  skipping unreadable JSONL line {position + 1}: {failure}", file=sys.stderr)
            continue
        seconds = record.get("t")
        declared_type = record.get("type")
        frame_type = declared_type if isinstance(declared_type, int) else raw[FRAME_TYPE_OFFSET]
        frames.append(CapturedFrame(seconds=seconds, frame_type=frame_type, raw=raw))
    return frames


def load_hex_frames(lines: list[str]) -> list[CapturedFrame]:
    frames: list[CapturedFrame] = []
    for position, line in enumerate(lines):
        cleaned = line.replace(" ", "").replace(":", "")
        try:
            raw = bytes.fromhex(cleaned)
        except ValueError as failure:
            print(f"  skipping unreadable hex line {position + 1}: {failure}", file=sys.stderr)
            continue
        if len(raw) <= FRAME_TYPE_OFFSET:
            print(f"  skipping hex line {position + 1}: only {len(raw)} bytes", file=sys.stderr)
            continue
        frames.append(CapturedFrame(seconds=None, frame_type=raw[FRAME_TYPE_OFFSET], raw=raw))
    return frames


def ascending_prefix(readings: list[int]) -> list[int]:
    """The leading run that strictly ascends. Padding and wrap-around end the run rather than
    poisoning the statistics of the records that did decode."""
    if not readings:
        return []
    prefix = [readings[0]]
    for reading in readings[1:]:
        if reading <= prefix[-1]:
            break
        prefix.append(reading)
    return prefix


def score_steadiness(differences: list[int]) -> float:
    """How near to equal the gaps are, as a 0..1 fade rather than a pass/fail. A clock that skips
    one sample should still beat noise, so the tolerance is generous and the fall-off linear."""
    if not differences:
        return 0.0
    median = statistics.median(differences)
    if median <= 0:
        return 0.0
    tolerance = max(2.0, median * 0.05)
    closeness = [max(0.0, 1.0 - abs(difference - median) / tolerance) for difference in differences]
    return sum(closeness) / len(closeness)


def score_pace_plausibility(differences: list[int]) -> float:
    if not differences:
        return 0.0
    inside = [
        difference
        for difference in differences
        if SHORTEST_PLAUSIBLE_INTERVAL_SECONDS <= difference <= LONGEST_PLAUSIBLE_INTERVAL_SECONDS
    ]
    return len(inside) / len(differences)


def score_depth(timestamps: list[int]) -> float:
    """Rewards hypotheses that explain more of the frame. This is what separates the true stride
    from its own harmonics: reading every other record ascends just as steadily, on half the data."""
    return min(1.0, len(timestamps) / RECORDS_FOR_FULL_DEPTH)


def score_epoch_sanity(timestamps: list[int], now: datetime) -> float:
    """Fraction of counter readings that land on a real date under the 2020 epoch."""
    if not timestamps:
        return 0.0
    horizon = int((now - datetime(RTC_EPOCH_YEAR, 1, 1, tzinfo=timezone.utc)).total_seconds()) + 86_400
    sane = [reading for reading in timestamps if 0 < reading <= horizon]
    return len(sane) / len(timestamps)


def build_hypothesis(frame: bytes, base_offset: int, stride: int, now: datetime) -> StrideHypothesis | None:
    limit = payload_end(frame)
    readings: list[int] = []
    position = base_offset
    while position + 4 <= limit:
        readings.append(read_uint32_le(frame, position))
        position += stride
    timestamps = ascending_prefix(readings)
    if len(timestamps) < MINIMUM_TIMESTAMPS_TO_JUDGE:
        return None

    differences = [later - earlier for earlier, later in zip(timestamps, timestamps[1:])]
    steadiness = score_steadiness(differences)
    pace_plausibility = score_pace_plausibility(differences)
    depth = score_depth(timestamps)
    epoch_sanity = score_epoch_sanity(timestamps, now)
    score = 100.0 * (0.40 * steadiness + 0.25 * pace_plausibility + 0.25 * depth + 0.10 * epoch_sanity)

    return StrideHypothesis(
        base_offset=base_offset,
        stride=stride,
        timestamps=tuple(timestamps),
        differences=tuple(differences),
        steadiness=steadiness,
        pace_plausibility=pace_plausibility,
        depth=depth,
        epoch_sanity=epoch_sanity,
        score=score,
    )


def rank_stride_hypotheses(frame: bytes, now: datetime) -> tuple[StrideHypothesis, ...]:
    """Every (base, stride) pair that yields an ascending clock, best first."""
    ranked: list[StrideHypothesis] = []
    for base_offset in SEARCHED_BASE_OFFSETS:
        for stride in SEARCHED_STRIDES:
            hypothesis = build_hypothesis(frame, base_offset, stride, now)
            if hypothesis is not None:
                ranked.append(hypothesis)
    ranked.sort(key=lambda candidate: (-candidate.score, candidate.stride, candidate.base_offset))
    return tuple(ranked)


def is_harmonic_of(candidate: StrideHypothesis, winner: StrideHypothesis) -> bool:
    """True when the candidate is the winner read every Nth record, or starting a whole number of
    records in. Such a candidate is not an alternative layout; it is the same layout, sampled."""
    if candidate.stride % winner.stride != 0:
        return False
    return (candidate.base_offset - winner.base_offset) % winner.stride == 0


def naive_local_clock_face(rtc_seconds: int) -> datetime:
    """The counter read as wall-clock seconds ticked from 2020-01-01 00:00 local: no zone, just a
    clock face."""
    return datetime(RTC_EPOCH_YEAR, 1, 1) + timedelta(seconds=rtc_seconds)


def absolute_instant(rtc_seconds: int) -> datetime:
    """The counter read as true seconds since the UTC instant of 2020-01-01."""
    return datetime(RTC_EPOCH_YEAR, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=rtc_seconds)


def format_stride_table(ranked: tuple[StrideHypothesis, ...], how_many: int) -> list[str]:
    lines = [
        "  rank  base  stride  records  median gap  steady  paced  depth  epoch  score  note",
        "  ----  ----  ------  -------  ----------  ------  -----  -----  -----  -----  ----",
    ]
    winner = ranked[0]
    for rank, candidate in enumerate(ranked[:how_many], start=1):
        notes: list[str] = []
        if candidate.is_vendor_layout():
            notes.append("vendor 9/24")
        if rank > 1 and is_harmonic_of(candidate, winner):
            notes.append("harmonic of #1")
        lines.append(
            f"  {rank:>4}  {candidate.base_offset:>4}  {candidate.stride:>6}  {candidate.record_count():>7}  "
            f"{candidate.median_difference():>10.1f}  {candidate.steadiness:>6.2f}  "
            f"{candidate.pace_plausibility:>5.2f}  {candidate.depth:>5.2f}  {candidate.epoch_sanity:>5.2f}  "
            f"{candidate.score:>5.1f}  {', '.join(notes)}"
        )
    return lines


def report_stride_search(ranked: tuple[StrideHypothesis, ...], how_many: int) -> list[str]:
    lines = ["## 1. Record stride — searched, not assumed", ""]
    if not ranked:
        lines.append("  No (base, stride) pair in the searched space produced three ascending uint32 LE")
        lines.append("  readings. Either the records carry no monotonic clock, the clock is not a uint32 LE,")
        lines.append("  or the record base lies outside offsets 5..16. Nothing below can be trusted.")
        return lines

    lines.append(f"  searched base offsets {SEARCHED_BASE_OFFSETS.start}..{SEARCHED_BASE_OFFSETS.stop - 1}, "
                 f"strides {SEARCHED_STRIDES.start}..{SEARCHED_STRIDES.stop - 1} "
                 f"({len(ranked)} produced an ascending clock)")
    lines.append("")
    lines.extend(format_stride_table(ranked, how_many))
    lines.append("")

    winner = ranked[0]
    lines.append(f"  WINNER: base offset {winner.base_offset}, stride {winner.stride}, "
                 f"{winner.record_count()} records, score {winner.score:.1f}")
    if winner.is_vendor_layout():
        lines.append("  This IS the vendor layout (records from 9, 24 bytes each). The transcribed offsets")
        lines.append("  survive contact with a real frame.")
    else:
        lines.append("  This is NOT the vendor layout.")
        lines.append(f"  detailLog.ts reads 24-byte records from offset 9; the bytes say {winner.stride}-byte records")
        lines.append(f"  from offset {winner.base_offset}. Every field offset in that decoder shifts, and everything it")
        lines.append("  decodes on this firmware is wrong.")

    runner_up = next((candidate for candidate in ranked[1:] if not is_harmonic_of(candidate, winner)), None)
    if runner_up is not None and winner.score - runner_up.score < 5.0:
        lines.append(f"  CLOSE CALL: base {runner_up.base_offset} / stride {runner_up.stride} scores "
                     f"{runner_up.score:.1f} against {winner.score:.1f} and is not a harmonic of the winner.")
        lines.append("  One frame does not separate them. Capture more frames before trusting either.")

    lines.append("")
    lines.append("  The base offset is where the ascending uint32 sits, which is the record base plus the")
    lines.append("  RTC's own offset inside a record. They coincide only if the RTC leads each record.")
    return lines


def report_sampling_interval(winner: StrideHypothesis) -> list[str]:
    differences = list(winner.differences)
    lines = ["## 2. Sampling interval", ""]
    if not differences:
        lines.append("  Fewer than two timestamps under the winning hypothesis; no interval to measure.")
        return lines

    slow_crystal = differences.count(3601)
    exact_hour = differences.count(3600)
    lines.append(f"  gaps between consecutive RTC readings ({len(differences)} of them), seconds:")
    lines.append(f"    min {min(differences)}   max {max(differences)}   median {statistics.median(differences):.1f}")
    lines.append(f"    exactly 3601 (the slow-crystal hour the vendor claims): {slow_crystal}")
    lines.append(f"    exactly 3600 (a true hour):                             {exact_hour}")
    lines.append(f"    neither:                                                {len(differences) - slow_crystal - exact_hour}")
    lines.append("")
    lines.append("  raw gaps: " + ", ".join(str(difference) for difference in differences))
    lines.append("")
    if slow_crystal and not exact_hour:
        lines.append("  The 3601-second claim holds: the pack's hour is a second long.")
    elif exact_hour and not slow_crystal:
        lines.append("  The gaps are true hours. The 3601 claim does not hold on this firmware, and stepping")
        lines.append("  whole hours from a neighbouring record is safe here.")
    elif not slow_crystal and not exact_hour:
        lines.append("  Neither hour appears. Whatever this counter paces, it is not the hourly ring the")
        lines.append("  vendor documentation describes.")
    return lines


def report_rtc_epoch(winner: StrideHypothesis, now: datetime) -> list[str]:
    lines = ["## 3. RTC epoch sanity — both readings, side by side", ""]
    local_zone = now.astimezone().tzinfo
    offset = now.astimezone().utcoffset() or timedelta(0)
    lines.append(f"  host zone offset right now: {offset}  (this is what separates the two readings)")
    lines.append("")

    edges = (("first", winner.timestamps[0]), ("last", winner.timestamps[-1]))
    for label, rtc_seconds in edges:
        face = naive_local_clock_face(rtc_seconds)
        instant = absolute_instant(rtc_seconds)
        lines.append(f"  {label} record, counter = {rtc_seconds}")
        lines.append(f"    naive-local (wall clock from 2020-01-01 00:00 local): {face:%Y-%m-%d %H:%M:%S}")
        lines.append(f"    absolute    (seconds from 2020-01-01T00:00:00Z):      {instant:%Y-%m-%d %H:%M:%S} UTC")
        lines.append(f"                                       same instant here: {instant.astimezone(local_zone):%Y-%m-%d %H:%M:%S %Z}")

    lines.append("")
    span = winner.timestamps[-1] - winner.timestamps[0]
    lines.append(f"  span covered by this frame: {span} s = {span / 3600:.1f} h = {span / 86400:.2f} days")
    lines.append("")

    impossible = [reading for reading in winner.timestamps if absolute_instant(reading) > now + timedelta(days=1)]
    unset_clock = [reading for reading in winner.timestamps if reading < 86_400]
    if impossible:
        lines.append(f"  FLAG: {len(impossible)} reading(s) land after today. The 2020 epoch is wrong, or the")
        lines.append("  field being read is not a clock at all.")
    if unset_clock:
        lines.append(f"  FLAG: {len(unset_clock)} reading(s) land within a day of 2020-01-01. That is a pack whose")
        lines.append("  RTC was never set, not a sample from this year.")
    if not impossible and not unset_clock:
        lines.append("  Every reading lands between 2020 and now under both readings — the epoch survives.")
        lines.append("  Which of the two is right cannot be settled from these bytes alone; match one of the")
        lines.append("  dates above against what the vendor app displays for the same record.")
    return lines


def report_headers(detail_frames: tuple[CapturedFrame, ...], winner: StrideHypothesis | None) -> list[str]:
    lines = ["## 4. Header fields, every 0x06 frame", ""]
    lines.append("  frame  t        byte5  index[6..7]  count[8]  count x stride + base  fits in 300")
    lines.append("  -----  -------  -----  -----------  --------  ---------------------  -----------")

    counters: list[int] = []
    indices: list[int] = []
    for position, captured in enumerate(detail_frames):
        frame = captured.raw
        counter = read_uint8(frame, FRAME_COUNTER_OFFSET)
        first_index = read_uint16_le(frame, FIRST_RECORD_INDEX_OFFSET)
        declared_count = read_uint8(frame, RECORD_COUNT_OFFSET)
        counters.append(counter)
        indices.append(first_index)
        if winner is None:
            extent = "?"
            verdict = "?"
        else:
            end = winner.base_offset + declared_count * winner.stride
            extent = str(end)
            verdict = "yes" if end <= FRAME_LENGTH else "NO"
        timing = f"{captured.seconds:.3f}" if captured.seconds is not None else "-"
        lines.append(
            f"  {position:>5}  {timing:>7}  0x{counter:02x}   {first_index:>11}  {declared_count:>8}  "
            f"{extent:>21}  {verdict:>11}"
        )

    lines.append("")
    if winner is not None:
        agreeing = [
            captured
            for captured in detail_frames
            if read_uint8(captured.raw, RECORD_COUNT_OFFSET) == winner.record_count()
        ]
        lines.append(f"  frames whose declared count equals the {winner.record_count()} ascending records found: "
                     f"{len(agreeing)}/{len(detail_frames)}")
        if len(agreeing) == len(detail_frames):
            lines.append("  The count byte at [8] means what the vendor layout says it means.")
        else:
            lines.append("  The count byte disagrees with the records actually present. Either [8] is not a")
            lines.append("  count, or the frame carries records the ascending run did not reach.")

    lines.append("")
    if len(detail_frames) < 2:
        lines.append("  Only one 0x06 frame in this file, so the paging cannot be read: whether byte 5 counts")
        lines.append("  frames and whether [6..7] walks the ring are both cross-frame questions. Capture with")
        lines.append("  `capture.py combined --detail-log 3` to get a series.")
        return lines

    lines.append(f"  byte 5 across frames:      {', '.join(f'0x{counter:02x}' for counter in counters)}")
    lines.append(f"  index [6..7] across frames: {', '.join(str(index) for index in indices)}")
    lines.append("")
    lines.append(f"  byte 5 {describe_progression(counters)}")
    lines.append(f"  index [6..7] {describe_progression(indices)}")
    if winner is not None:
        index_steps = [later - earlier for earlier, later in zip(indices, indices[1:])]
        matching_steps = [step for step in index_steps if step == winner.record_count()]
        if matching_steps and len(matching_steps) == len(index_steps):
            lines.append(f"  Each step is exactly {winner.record_count()} — the index is a record position in the ring and the")
            lines.append("  frames page through it contiguously.")
    return lines


def describe_progression(values: list[int]) -> str:
    steps = {later - earlier for earlier, later in zip(values, values[1:])}
    if steps == {0}:
        return "never changes — the same page came back each time."
    if all(step > 0 for step in steps):
        return f"increments (steps {sorted(steps)})."
    if all(step < 0 for step in steps):
        return f"decrements (steps {sorted(steps)})."
    return f"moves both ways (steps {sorted(steps)}) — not a simple counter."


def tags_for(reading: float, signed_encoding: bool) -> str:
    matched = [
        plausible.label
        for plausible in PLAUSIBLE_READINGS
        if plausible.lowest <= reading <= plausible.highest
        and (signed_encoding or not plausible.signed_encoding_only)
    ]
    if not matched:
        return ""
    return " [" + ",".join(matched) + "]"


def report_field_scales(frame: bytes, winner: StrideHypothesis) -> list[str]:
    lines = ["## 5. Field-scale candidates, first record under the winning hypothesis", ""]
    lines.append(f"  window: offsets {winner.base_offset}..{winner.base_offset + winner.stride - 1} of the frame, "
                 f"printed as +0..+{winner.stride - 1} within the record")
    lines.append("  Tags mark a value inside a range that is plausible FOR THIS PACK — 4 cells near 3.40 V,")
    lines.append("  pack 13.61 V, 315 Ah nominal, temperatures near 27 C. The [current] range is deliberately")
    lines.append("  wide, so that tag alone means little; section 6 is what settles current.")
    lines.append("")
    lines.append("  -- two-byte windows, little-endian --")

    base = winner.base_offset
    for inner in range(0, winner.stride - 1):
        offset = base + inner
        if offset + 2 > payload_end(frame):
            break
        unsigned = read_uint16_le(frame, offset)
        signed = read_int16_le(frame, offset)
        lines.append(f"  +{inner:<2} u16={unsigned:>6}  " + "  ".join(
            f"{name} {unsigned * scale:g}{tags_for(unsigned * scale, False)}" for scale, name in SCALES
        ))
        if signed != unsigned:
            lines.append(f"      i16={signed:>6}  " + "  ".join(
                f"{name} {signed * scale:g}{tags_for(signed * scale, True)}" for scale, name in SCALES
            ))

    lines.append("")
    lines.append("  -- single bytes --")
    for inner in range(0, winner.stride):
        offset = base + inner
        if offset >= payload_end(frame):
            break
        unsigned = read_uint8(frame, offset)
        signed = read_int8(frame, offset)
        biased = unsigned - TEMPERATURE_BYTE_BIAS
        lines.append(
            f"  +{inner:<2} u8={unsigned:>4}{tags_for(unsigned, False)}   "
            f"i8={signed:>4}{tags_for(signed, True)}   "
            f"u8-{TEMPERATURE_BYTE_BIAS}={biased:>4}{tags_for(biased, True)}"
        )
    return lines


def find_matching_windows(frame: bytes, winner: StrideHypothesis, target: float, tolerance: float) -> list[str]:
    """Every two-byte window and scale in the first record that lands on a live reading."""
    matches: list[str] = []
    base = winner.base_offset
    for inner in range(0, winner.stride - 1):
        offset = base + inner
        if offset + 2 > payload_end(frame):
            break
        unsigned = read_uint16_le(frame, offset)
        signed = read_int16_le(frame, offset)
        encodings = [("u16", unsigned)] if signed == unsigned else [("u16", unsigned), ("i16", signed)]
        for encoding, raw in encodings:
            for scale, name in SCALES:
                scaled = raw * scale
                if abs(scaled - target) <= tolerance:
                    matches.append(f"+{inner} as {encoding} {name} = {scaled:g}")
    return matches


def format_matches(matches: list[str]) -> list[str]:
    if not matches:
        return ["    none"]
    return [f"    {match}" for match in matches]


def report_cell_info_crosscheck(
    detail_frame: CapturedFrame,
    cell_info: CapturedFrame | None,
    winner: StrideHypothesis | None,
) -> list[str]:
    lines = ["## 6. Cross-check against a live cell-info frame (0x02)", ""]
    if cell_info is None:
        lines.append("  No 0x02 frame available. Pass one with --cell-info, or analyse a JSONL that holds both.")
        lines.append("  Without it the strongest confirmation there is — a detail-log column agreeing with a")
        lines.append("  live reading of the same pack — cannot be made.")
        return lines

    frame = cell_info.raw
    pack_voltage = read_uint32_le(frame, CELL_INFO_PACK_VOLTAGE_OFFSET) * 0.001
    pack_power = read_uint32_le(frame, CELL_INFO_PACK_POWER_OFFSET) * 0.001
    pack_current = read_int32_le(frame, CELL_INFO_PACK_CURRENT_OFFSET) * 0.001

    if cell_info.seconds is not None and detail_frame.seconds is not None:
        gap = abs(cell_info.seconds - detail_frame.seconds)
        lines.append(f"  nearest 0x02 frame is {gap:.1f} s from the 0x06 frame "
                     f"(t={cell_info.seconds:.3f} against t={detail_frame.seconds:.3f})")
        if gap > 60:
            lines.append("  That gap is wide enough for the pack to have moved; treat a near-miss as a miss.")
    else:
        lines.append("  Cell-info frame supplied separately, so how far apart in time the two are is unknown.")

    lines.append("")
    lines.append("  live, at offsets captures/MANIFEST.md records as confirmed on this firmware:")
    lines.append(f"    pack voltage (u32 @150 x0.001): {pack_voltage:.3f} V")
    lines.append(f"    pack power   (u32 @154 x0.001): {pack_power:.3f} W")
    lines.append(f"    pack current (i32 @158 x0.001): {pack_current:.3f} A")
    lines.append("")

    if winner is None:
        lines.append("  No winning stride hypothesis, so there are no detail-log candidates to hold against these.")
        return lines

    voltage_matches = find_matching_windows(detail_frame.raw, winner, pack_voltage, PACK_VOLTAGE_MATCH_TOLERANCE_V)
    current_matches = find_matching_windows(detail_frame.raw, winner, pack_current, PACK_CURRENT_MATCH_TOLERANCE_A)

    lines.append(f"  detail-log windows within {PACK_VOLTAGE_MATCH_TOLERANCE_V} V of the live pack voltage:")
    lines.extend(format_matches(voltage_matches))
    lines.append(f"  detail-log windows within {PACK_CURRENT_MATCH_TOLERANCE_A} A of the live current:")
    lines.extend(format_matches(current_matches))
    lines.append("")
    if voltage_matches and current_matches:
        lines.append("  A window agreeing on voltage AND another agreeing on current is the strongest evidence")
        lines.append("  available offline that the stride and the scales are right. Prefer the pair whose")
        lines.append("  offsets sit where a record layout would plausibly put them, and confirm on a second")
        lines.append("  frame captured under a different current before writing them into the decoder.")
    else:
        lines.append("  No agreement. Either the newest record in this frame predates the live reading, or the")
        lines.append("  stride is wrong, or these fields are not stored at these scales.")
    return lines


def nearest_cell_info(detail_frame: CapturedFrame, frames: tuple[CapturedFrame, ...]) -> CapturedFrame | None:
    candidates = [captured for captured in frames if captured.frame_type == FRAME_CELL_INFO]
    if not candidates:
        return None
    if detail_frame.seconds is None:
        return candidates[0]
    timed = [captured for captured in candidates if captured.seconds is not None]
    if not timed:
        return candidates[0]
    return min(timed, key=lambda captured: abs(captured.seconds - detail_frame.seconds))


def analyse(
    frames: tuple[CapturedFrame, ...],
    source: Path,
    supplied_cell_info: CapturedFrame | None,
    how_many_hypotheses: int,
    now: datetime,
) -> list[str]:
    """The whole report as lines. Returns early, and honestly, when there is nothing to work on."""
    lines = [
        "# JK-BMS detail-log (0x06) layout analysis",
        "",
        f"source: {source}",
        f"run at: {now.astimezone():%Y-%m-%d %H:%M:%S %Z}",
        f"frames in file: {len(frames)}  "
        + ", ".join(
            f"0x{frame_type:02x}×{sum(1 for captured in frames if captured.frame_type == frame_type)}"
            for frame_type in sorted({captured.frame_type for captured in frames})
        ),
        "",
    ]

    detail_frames = tuple(captured for captured in frames if captured.frame_type == FRAME_DETAIL_LOG)
    if not detail_frames:
        lines.append("No type 0x06 frame in this file, so there is nothing to analyse.")
        lines.append("")
        lines.append("The pack only sends one in reply to command 0xA7, which capture.py sends only under")
        lines.append("`combined --detail-log N`. If a run with that flag still produced none, the pack did not")
        lines.append("answer the opcode — check `raw notification bytes` in captures/bms-summary.txt to tell")
        lines.append("silence from a burst that arrived torn.")
        return lines

    first_detail = detail_frames[0]
    ranked = rank_stride_hypotheses(first_detail.raw, now)
    winner = ranked[0] if ranked else None

    lines.extend(report_stride_search(ranked, how_many_hypotheses))
    lines.append("")

    if len(detail_frames) > 1:
        lines.append("  winner per frame, to see whether the layout is stable across the series:")
        for position, captured in enumerate(detail_frames):
            per_frame = rank_stride_hypotheses(captured.raw, now)
            if per_frame:
                best = per_frame[0]
                lines.append(f"    frame {position}: base {best.base_offset}, stride {best.stride}, "
                             f"{best.record_count()} records, score {best.score:.1f}")
            else:
                lines.append(f"    frame {position}: no ascending clock found")
        lines.append("")

    if winner is not None:
        lines.extend(report_sampling_interval(winner))
        lines.append("")
        lines.extend(report_rtc_epoch(winner, now))
        lines.append("")

    lines.extend(report_headers(detail_frames, winner))
    lines.append("")

    if winner is not None:
        lines.extend(report_field_scales(first_detail.raw, winner))
        lines.append("")

    cell_info = supplied_cell_info or nearest_cell_info(first_detail, frames)
    lines.extend(report_cell_info_crosscheck(first_detail, cell_info, winner))
    return lines


def load_single_frame(path: Path) -> CapturedFrame | None:
    frames = load_frames(path)
    if not frames:
        return None
    return frames[0]


def run_analysis(arguments: argparse.Namespace) -> int:
    source = Path(arguments.path)
    try:
        frames = load_frames(source)
    except FileNotFoundError:
        print(f"No such file: {source}", file=sys.stderr)
        return 1

    if not frames:
        print(f"{source} is empty — no frames captured yet.", file=sys.stderr)
        print("Run `capture.py combined --detail-log 3` on the boat first.", file=sys.stderr)
        return 0

    supplied_cell_info = None
    if arguments.cell_info:
        supplied_cell_info = load_single_frame(Path(arguments.cell_info))
        if supplied_cell_info is None:
            print(f"--cell-info {arguments.cell_info} held no frame", file=sys.stderr)

    lines = analyse(
        frames=frames,
        source=source,
        supplied_cell_info=supplied_cell_info,
        how_many_hypotheses=arguments.top,
        now=datetime.now(timezone.utc),
    )
    report = "\n".join(lines)
    print(report)

    destination = Path(arguments.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(report + "\n")
    print(f"\nwritten to {destination}", file=sys.stderr)
    return 0


def build_frame_with_planted_layout(
    base_offset: int,
    stride: int,
    record_count: int,
    first_rtc: int,
    interval: int,
    first_record_index: int,
    frame_counter: int,
) -> bytes:
    """A synthetic 0x06 frame whose layout is known, so the detector can be caught confirming rather
    than detecting. The planted stride is deliberately not the vendor's 24."""
    frame = bytearray(FRAME_LENGTH)
    frame[0:4] = bytes([0x55, 0xAA, 0xEB, 0x90])
    frame[FRAME_TYPE_OFFSET] = FRAME_DETAIL_LOG
    frame[FRAME_COUNTER_OFFSET] = frame_counter
    frame[FIRST_RECORD_INDEX_OFFSET : FIRST_RECORD_INDEX_OFFSET + 2] = first_record_index.to_bytes(2, "little")
    frame[RECORD_COUNT_OFFSET] = record_count

    for position in range(record_count):
        record = base_offset + position * stride
        frame[record : record + 4] = (first_rtc + position * interval).to_bytes(4, "little")
        frame[record + 4] = 0
        frame[record + 5] = 0x03
        frame[record + 6 : record + 8] = (3402).to_bytes(2, "little")
        frame[record + 8 : record + 10] = (3398).to_bytes(2, "little")
        frame[record + 10 : record + 12] = (1361).to_bytes(2, "little")
        frame[record + 12 : record + 14] = (-56).to_bytes(2, "little", signed=True)
        frame[record + 14 : record + 16] = (3080).to_bytes(2, "little")
        frame[record + 16 : record + 18] = (3150).to_bytes(2, "little")
        frame[record + 18] = 27
        frame[record + 19] = 29

    frame[FRAME_LENGTH - 1] = sum(frame[0 : FRAME_LENGTH - 1]) & 0xFF
    return bytes(frame)


def run_self_test() -> int:
    """Plants a layout the vendor document does not describe and checks the search recovers it."""
    planted_base = 11
    planted_stride = 20
    planted_interval = 3601
    planted_records = 12
    now = datetime.now(timezone.utc)
    first_rtc = int((datetime(2026, 5, 1, tzinfo=timezone.utc) - datetime(RTC_EPOCH_YEAR, 1, 1, tzinfo=timezone.utc)).total_seconds())

    failures: list[str] = []

    def check(description: str, passed: bool, detail: str = "") -> None:
        marker = "ok  " if passed else "FAIL"
        print(f"  {marker}  {description}{('  — ' + detail) if detail else ''}")
        if not passed:
            failures.append(description)

    print(f"planting base {planted_base}, stride {planted_stride}, interval {planted_interval}s, "
          f"{planted_records} records — none of which is the vendor 9/24/3601 default\n")

    planted = build_frame_with_planted_layout(
        base_offset=planted_base,
        stride=planted_stride,
        record_count=planted_records,
        first_rtc=first_rtc,
        interval=planted_interval,
        first_record_index=0,
        frame_counter=0x01,
    )
    ranked = rank_stride_hypotheses(planted, now)
    winner = ranked[0] if ranked else None

    check("a hypothesis was found at all", winner is not None)
    if winner is None:
        return 1

    check("stride recovered", winner.stride == planted_stride, f"got {winner.stride}, planted {planted_stride}")
    check("base recovered", winner.base_offset == planted_base, f"got {winner.base_offset}, planted {planted_base}")
    check("record count recovered", winner.record_count() == planted_records,
          f"got {winner.record_count()}, planted {planted_records}")
    check("interval recovered", winner.median_difference() == planted_interval,
          f"got {winner.median_difference()}, planted {planted_interval}")
    check("the vendor layout did NOT win", not winner.is_vendor_layout())

    vendor = next((candidate for candidate in ranked if candidate.is_vendor_layout()), None)
    check("the vendor layout scores below the planted one",
          vendor is None or vendor.score < winner.score,
          "vendor absent from the ranking" if vendor is None else f"vendor {vendor.score:.1f} < winner {winner.score:.1f}")

    harmonic = next((candidate for candidate in ranked[1:] if candidate.stride == planted_stride * 2), None)
    check("a double-stride harmonic is recognised as one",
          harmonic is None or is_harmonic_of(harmonic, winner))

    # Recovering only the odd layout would leave the search merely biased the other way, which is
    # the same failure wearing different clothes.
    vendor_shaped = build_frame_with_planted_layout(
        base_offset=VENDOR_RECORD_BASE,
        stride=VENDOR_RECORD_STRIDE,
        record_count=planted_records,
        first_rtc=first_rtc,
        interval=planted_interval,
        first_record_index=0,
        frame_counter=0x01,
    )
    vendor_winner = rank_stride_hypotheses(vendor_shaped, now)[0]
    check("a genuinely 9/24 frame is recovered as 9/24",
          vendor_winner.is_vendor_layout(),
          f"got {vendor_winner.base_offset}/{vendor_winner.stride}")

    report = analyse(
        frames=(CapturedFrame(seconds=1.0, frame_type=FRAME_DETAIL_LOG, raw=planted),),
        source=Path("<planted>"),
        supplied_cell_info=None,
        how_many_hypotheses=5,
        now=now,
    )
    joined = "\n".join(report)
    check("the report names the planted stride", f"stride {planted_stride}" in joined)
    check("the report says plainly this is not the vendor layout", "NOT the vendor layout" in joined)
    check("a single frame skips the paging analysis",
          "Only one 0x06 frame in this file" in joined)
    check("3601 gaps are counted", f"exactly 3601 (the slow-crystal hour the vendor claims): {planted_records - 1}" in joined)

    paged = tuple(
        CapturedFrame(
            seconds=float(page),
            frame_type=FRAME_DETAIL_LOG,
            raw=build_frame_with_planted_layout(
                base_offset=planted_base,
                stride=planted_stride,
                record_count=planted_records,
                first_rtc=first_rtc + page * planted_records * planted_interval,
                interval=planted_interval,
                first_record_index=page * planted_records,
                frame_counter=page + 1,
            ),
        )
        for page in range(3)
    )
    paged_report = "\n".join(
        analyse(frames=paged, source=Path("<planted-series>"), supplied_cell_info=None, how_many_hypotheses=5, now=now)
    )
    check("a series reports the index walking the ring", "increments" in paged_report)
    check("a series does not claim the paging is unreadable",
          "Only one 0x06 frame in this file" not in paged_report)

    empty_report = "\n".join(
        analyse(
            frames=(CapturedFrame(seconds=0.0, frame_type=FRAME_CELL_INFO, raw=bytes(FRAME_LENGTH)),),
            source=Path("<no-detail-log>"),
            supplied_cell_info=None,
            how_many_hypotheses=5,
            now=now,
        )
    )
    check("a file with no 0x06 frame degrades honestly", "No type 0x06 frame in this file" in empty_report)

    noise_report = "\n".join(
        analyse(
            frames=(CapturedFrame(seconds=0.0, frame_type=FRAME_DETAIL_LOG, raw=bytes(FRAME_LENGTH)),),
            source=Path("<all-zero>"),
            supplied_cell_info=None,
            how_many_hypotheses=5,
            now=now,
        )
    )
    check("an all-zero 0x06 frame finds no clock rather than inventing one",
          "produced three ascending uint32 LE" in noise_report)

    print()
    if failures:
        print(f"SELF-TEST FAILED: {len(failures)} check(s) — " + "; ".join(failures))
        return 1
    print("SELF-TEST PASSED — the search recovered a layout it was never told about.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("mode", choices=["analyse", "self-test"], nargs="?", default="analyse")
    parser.add_argument("path", nargs="?", default=str(DEFAULT_INPUT),
                        help="captured frames: capture.py JSONL, or a .hex file with one frame per line")
    parser.add_argument("--cell-info", default=None,
                        help="a 0x02 frame as .hex, for the live cross-check when the JSONL has none")
    parser.add_argument("--out", default=str(DEFAULT_REPORT), help="where to write the report")
    parser.add_argument("--top", type=int, default=12, help="how many ranked stride hypotheses to print")
    arguments = parser.parse_args()

    if arguments.mode == "self-test":
        return run_self_test()
    return run_analysis(arguments)


if __name__ == "__main__":
    sys.exit(main())
