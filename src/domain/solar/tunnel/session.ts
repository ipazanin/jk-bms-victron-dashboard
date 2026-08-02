/**
 * Opening the SmartSolar's 306b GATT tunnel: the three characteristics, the frames that start a
 * session, and the frame that keeps it alive.
 *
 * Every byte here was captured off this boat's controller while VictronConnect exported its
 * history, so nothing below is inferred from a document. The order is part of the protocol: all
 * three characteristics are subscribed before the first write, then the two control frames, then
 * the two command frames. A session opened out of order answers nothing.
 *
 * The controller replies `07 00 03 00` to the last of those frames — an error opcode — and the
 * vendor app carries on regardless, because the session is open and every register asked after it
 * answers normally. It is chatter, not a failure, and the reason nothing here treats it as one is
 * structural: it names register 3, which is not a register this codebase ever asks for, so no
 * pending read can match it.
 *
 * THE KEEPALIVE IS THE ONE 0x06 FRAME IN THIS CODEBASE, and it is a literal for exactly that
 * reason. Decoded, it writes 10000 milliseconds to register 0x0093 on interface 0x00 — the
 * tunnel's own inactivity timeout, re-armed roughly every three seconds. A write on this link is a
 * read with one byte changed, and register 0x1030 sits a few bits from the history registers and is
 * believed to erase the stored days, so there is no encoder anywhere that composes a 0x06 frame.
 * A function that built one would take a register and could be handed any; a constant copied from
 * the capture has to be edited in this file to say anything else. That is a reviewable difference
 * rather than an enforced one — the bytes of a `Uint8Array` cannot be frozen, so nothing at runtime
 * stops a caller mutating this frame in place. Do not turn it into a function, and do not add a
 * sibling.
 *
 * The three UUIDs below are also the entire set this codebase ever looks up. The Nordic legacy DFU
 * service at 00001530-1212-efde-1523-785feabcd123 lives on the same controller and its control
 * point can drop the charger into bootloader mode; naming only these three is what keeps it out of
 * reach.
 */

/** The tunnel service. Not advertised — it is found after connecting, never in a chooser filter. */
export const SOLAR_TUNNEL_SERVICE = '306b0001-b081-4037-83dc-e59fcc3cdfd0'

/** Session control. Notifies `f901` repeatedly once open, which nothing reads. */
export const SOLAR_TUNNEL_CONTROL_CHARACTERISTIC = '306b0002-b081-4037-83dc-e59fcc3cdfd0'

/** Where requests go, and where most replies come back. */
export const SOLAR_TUNNEL_COMMAND_CHARACTERISTIC = '306b0003-b081-4037-83dc-e59fcc3cdfd0'

/** Notify-only. Carries the rest of a reply that did not fit on the command characteristic. */
export const SOLAR_TUNNEL_BULK_CHARACTERISTIC = '306b0004-b081-4037-83dc-e59fcc3cdfd0'

/** Written to the control characteristic first, in this order. */
export const TUNNEL_CONTROL_OPEN_FRAMES: readonly Uint8Array[] = Object.freeze([
  Uint8Array.of(0xfa, 0x80, 0xff),
  Uint8Array.of(0xf9, 0x80),
])

/** Then these, to the command characteristic. The second draws the harmless `07 00 03 00`. */
export const TUNNEL_COMMAND_OPEN_FRAMES: readonly Uint8Array[] = Object.freeze([
  Uint8Array.of(0x01),
  Uint8Array.of(0x03, 0x00),
])

/**
 * The captured keepalive, byte for byte. See the header: this is a literal and must stay one.
 */
export const TUNNEL_KEEPALIVE_FRAME: Uint8Array = Uint8Array.of(0x06, 0x00, 0x82, 0x18, 0x93, 0x42, 0x10, 0x27)

/**
 * How often the keepalive goes out. The frame itself asks for a ten-second timeout, and the vendor
 * app re-arms it about every 3.4 seconds — comfortably inside the window it just set, which is what
 * keeps a slow reply from ending the session under it.
 */
export const TUNNEL_KEEPALIVE_PERIOD_MS = 3_400
