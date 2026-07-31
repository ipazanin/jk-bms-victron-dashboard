/**
 * What one stored-log read established.
 *
 * The four answers are named apart rather than folded into a success flag because each one points
 * at a different fix, and because the two failures that look identical from the outside — a pack
 * that ignored the opcode and a burst the BLE stack tore up — are the whole reason the read counts
 * raw notification bytes at all.
 *
 * - `no-answer`    not one byte crossed the characteristic. The pack does not answer this opcode,
 *                  or answers it only under a precondition we have not met.
 * - `torn-burst`   bytes arrived and none of them survived assembly. The pack does answer; the
 *                  transport lost or mangled the reply, so the fix is in the link, not the opcode.
 * - `other-frames` frames assembled and none was type 0x06. The opcode is understood as something
 *                  else on this firmware, and the frame types that came back say what.
 * - `records-read` at least one type 0x06 frame arrived. Whether every one of them decoded is a
 *                  separate question the transfer's record count answers.
 */
export type DetailLogOutcome = 'no-answer' | 'torn-burst' | 'other-frames' | 'records-read'
