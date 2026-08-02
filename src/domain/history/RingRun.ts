/**
 * A maximal stretch of one read that arrived unbroken.
 *
 * A burst that lost frames comes back as several of these rather than as one sequence with holes in
 * it, because a hole is exactly what must never be bridged: the records either side of it are not
 * adjacent in the pack's own history and folding them as if they were would put a row's neighbour
 * an unknown distance away.
 */
export interface RingRun {
  readonly firstIndex: number
  /** 24 bytes each, in ring order, contiguous from firstIndex. */
  readonly records: readonly Uint8Array[]
}
