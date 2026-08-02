/**
 * Folding a stored-log read into the pack's own ledger.
 *
 * The insight the whole merge rests on: the pack's true history is one sequence, and every read is
 * a contiguous window onto it. The ring appends at its head and drops from its tail, so placing a
 * read against the ledger is finding the shift at which their bytes agree — and bytes are the right
 * thing to compare, because nothing else about a record is unique. Ring index is a position that
 * moved 42 places in four hours. The RTC counter repeats, and one repeated pair carries genuinely
 * different content. Adjacent records are byte-identical nine times in one read, so a content
 * digest would collapse rows the pack really wrote.
 *
 * What is stored is therefore the pack's write order and nothing derived from it: `seq` is handed
 * out on first sight and never revised, no stored row is ever rewritten, and a record the ledger
 * already holds is recognised rather than duplicated.
 *
 * This module decides; it never stores. The store hands it a tail, takes back rows to append, and
 * owns everything about budgets and transactions.
 */

import type { RingLedgerTail } from './RingLedgerTail'
import type { RingMergeOutcome } from './RingMergeOutcome'
import type { RingRecordRow } from './RingRecordRow'
import type { RingRun } from './RingRun'
import type { RingSnapshot } from './RingSnapshot'

/**
 * Fewer than this many overlapping records is not evidence of a shift.
 *
 * Four is enough because the RTC counter sits inside the compared bytes: two four-record windows can
 * only match if their counters match, and counters are all but unique. Measured on a real 836-record
 * ring, the longest run of identical consecutive records is two, and a general offset search resolves
 * to exactly one shift at every truncation depth down to four.
 */
export const MIN_ALIGNMENT_OVERLAP = 4

/**
 * How much of the ledger's tail is loaded for alignment. Larger than any read yet observed, because
 * the ring is NOT a fixed-length FIFO: it returned 836 records on one read and 809 on the next,
 * dropping 42 while adding 15. Nothing here may assume a ring size.
 */
export const ALIGNMENT_TAIL_RECORDS = 2_048

/** Bytes 0..3 of a record, little-endian: the pack's RTC counter in seconds. */
const RTC_SECONDS_OFFSET = 0

/**
 * The unique shift `s` such that `tail.rows[s + i]` equals `run.records[i]` for every overlapping
 * `i`, or null when no such shift covers at least MIN_ALIGNMENT_OVERLAP records.
 *
 * A general offset search, NOT a suffix-of-tail against prefix-of-run. The two differ exactly where
 * it matters: a read cut short by the quiet gap or the 30 s ceiling carries a window that lies
 * wholly inside the ledger, and a suffix-prefix match cannot see it — it would report no overlap and
 * append several hundred rows the ledger already holds.
 *
 * Two shifts that both agree are not a tie to break. They mean the compared bytes did not identify
 * the window, so the answer is null and the caller declares a gap rather than picking one.
 */
export function alignRun(tail: RingLedgerTail, run: RingRun): number | null {
  const rows = tail.rows
  const records = run.records
  if (rows.length === 0 || records.length === 0) return null

  const lowest = MIN_ALIGNMENT_OVERLAP - records.length
  const highest = rows.length - MIN_ALIGNMENT_OVERLAP
  let found: number | null = null

  for (let shift = lowest; shift <= highest; shift += 1) {
    const from = Math.max(0, -shift)
    const to = Math.min(records.length, rows.length - shift)
    if (to - from < MIN_ALIGNMENT_OVERLAP) continue

    let agrees = true
    for (let position = from; position < to; position += 1) {
      if (!sameBytes(rows[shift + position].bytes, records[position])) {
        agrees = false
        break
      }
    }
    if (!agrees) continue
    if (found !== null) return null
    found = shift
  }

  return found
}

/**
 * Places one read against the ledger's tail and says which rows are new.
 *
 * Four outcomes, and the third is the one that makes the merge safe across a month away from the
 * boat: a run that aligns nowhere is appended whole with its first row declaring the break, so
 * history the pack no longer holds is stated as missing rather than quietly bridged. A run too
 * short to identify itself is discarded instead of guessed at.
 *
 * Records that fall below the tail's oldest row are neither appended nor counted as overlap. They
 * are either already stored under the tail's window or older than anything this ledger kept, and
 * prepending them would mean a stored row's seq changing — the one thing that must never happen.
 *
 * `now` stamps the provenance of rows this fold creates; the snapshot's own `observedAt` is what
 * the journal row carries.
 */
export function foldRingSnapshot(
  tail: RingLedgerTail,
  snapshot: RingSnapshot,
  now: number,
): { readonly rows: readonly RingRecordRow[]; readonly merge: RingMergeOutcome } {
  const runs = [...snapshot.runs].sort((left, right) => left.firstIndex - right.firstIndex)
  const baseSeq = tail.rows.length > 0 ? tail.rows[0].seq : tail.nextSeq
  const known = [...tail.rows]
  const rows: RingRecordRow[] = []

  let nextSeq = tail.nextSeq
  let overlap = 0
  let runsDiscarded = 0
  let gapDeclared = false
  let ringShift: number | null = null

  const append = (bytes: Uint8Array, followsGap: boolean): void => {
    const row: RingRecordRow = {
      deviceKey: snapshot.deviceKey,
      seq: nextSeq,
      packClockSeconds: packClockSecondsOf(bytes),
      bytes,
      firstReadAt: now,
      followsGap,
    }
    nextSeq += 1
    rows.push(row)
    known.push(row)
  }

  for (const run of runs) {
    if (run.records.length === 0) continue

    const shift = alignRun({ nextSeq, rows: known }, run)
    if (shift === null) {
      if (run.records.length < MIN_ALIGNMENT_OVERLAP) {
        runsDiscarded += 1
        continue
      }
      // An empty ledger is opened, not broken. The oldest row still declares the break, because the
      // ring had already dropped whatever came before it.
      if (known.length > 0) gapDeclared = true
      run.records.forEach((bytes, position) => append(bytes, position === 0))
      continue
    }

    if (ringShift === null) ringShift = baseSeq + shift - run.firstIndex

    const from = Math.max(0, -shift)
    const to = Math.min(run.records.length, known.length - shift)
    overlap += to - from
    for (let position = to; position < run.records.length; position += 1) {
      append(run.records[position], false)
    }
  }

  return {
    rows,
    merge: { appended: rows.length, overlap, ringShift, gapDeclared, runsDiscarded },
  }
}

function packClockSecondsOf(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    RTC_SECONDS_OFFSET,
    true,
  )
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let at = 0; at < left.length; at += 1) {
    if (left[at] !== right[at]) return false
  }
  return true
}
