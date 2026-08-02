/**
 * One clock rewrite, read straight out of the ring.
 *
 * The pack writes an adjacent pair of records when its clock is set: the face it was reading, then
 * the face it was given. The pair records the rewrite exactly. It does not record which of the two
 * faces was right, which is why absolute placement stays an owner's answer and never an inference.
 */
export interface PackClockCalibration {
  /** Seq of the record carrying the NEW face — the row that opens the next segment. */
  readonly atSeq: number
  readonly beforeCounterSeconds: number
  readonly afterCounterSeconds: number
  /** after − before. Zero for a sync that changed nothing, which is most of them. */
  readonly stepSeconds: number
}
