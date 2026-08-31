/**
 * What the owner has to do about a rejoin that has stopped trying.
 *
 * Only the three answers in `RejoinBlocker` ever reach this — a radio that is merely out of range is
 * answered by patience and says nothing at all — so each sentence names the one action that ends it
 * and nothing else. Both radios wear the same words, and the subject is passed in because only the
 * caller knows whether it is talking about the pack or the controller.
 *
 * The subject never opens a sentence, so a device with no advertised name can stand in as a plain
 * noun without the copy reading as a sentence that starts mid-thought.
 *
 * `browser-cannot-rejoin` names no mechanism, because two of them reach it: a browser that cannot
 * list the devices it has already been allowed, and a radio route whose own prompt has to be
 * answered afresh on every start. What the owner does about either is the same press, so the
 * sentence names that press and not the mechanism — and the Connect page says it in these words
 * too, for a browser that has never been shown a device and so has no blocker to report yet.
 */

import type { RejoinBlocker } from './RejoinBlocker'

export function rejoinBlockerNote(blocker: RejoinBlocker, subject: string): string {
  switch (blocker) {
    case 'permission-gone':
      return (
        `This browser no longer has permission for ${subject}, so it cannot be rejoined without ` +
        'the chooser. Pick it once more and the page goes back to it on its own again.'
      )
    case 'browser-cannot-rejoin':
      return (
        `This browser has no way back to ${subject} without being asked, so it has to be picked ` +
        'from the chooser every time. Nothing here happens on its own.'
      )
    case 'radio-off':
      return (
        'Bluetooth is off, so nothing is being looked for. Switch it on and the page picks ' +
        `${subject} up again by itself.`
      )
  }
}
