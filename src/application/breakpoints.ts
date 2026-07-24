/**
 * The one width where the shell switches between the docked desktop rail and the off-canvas mobile
 * drawer, named once so the media queries in App, the header and the sidebar cannot drift apart
 * from each other or from the matching CSS. At 861px and up the rail is docked and collapsible; at
 * 860px and down it is a drawer.
 */

import type { Ref } from 'vue'

import { useMediaQuery } from './useMediaQuery'

export const DESKTOP_QUERY = '(min-width: 861px)'
export const MOBILE_QUERY = '(max-width: 860px)'

export function useIsDesktop(): Ref<boolean> {
  return useMediaQuery(DESKTOP_QUERY)
}

export function useIsMobile(): Ref<boolean> {
  return useMediaQuery(MOBILE_QUERY)
}
