/**
 * The two widths the layout turns on, named once so the media queries in the components cannot
 * drift apart from each other or from the matching CSS.
 *
 * The shell switches between the docked desktop rail and the off-canvas mobile drawer at 861px:
 * at 861px and up the rail is docked and collapsible, at 860px and down it is a drawer.
 *
 * Compact is the narrower, unrelated question of whether an instrument lays itself out for a phone
 * — a vertical schematic, a stacked ledger — and every instrument that asks it must ask it at the
 * same width, or two cards in one column disagree about which one they are in.
 */

import type { Ref } from 'vue'

import { useMediaQuery } from './useMediaQuery'

export const DESKTOP_QUERY = '(min-width: 861px)'
export const MOBILE_QUERY = '(max-width: 860px)'
export const COMPACT_QUERY = '(max-width: 720px)'
/** Narrower still: the header's own width, where its status line has to say the same thing in
 *  fewer words. The alternative was hiding it, which loses the page's only persistent readout of
 *  whether the figures below are live. */
export const NARROW_QUERY = '(max-width: 420px)'

export function useIsDesktop(): Ref<boolean> {
  return useMediaQuery(DESKTOP_QUERY)
}

export function useIsMobile(): Ref<boolean> {
  return useMediaQuery(MOBILE_QUERY)
}
