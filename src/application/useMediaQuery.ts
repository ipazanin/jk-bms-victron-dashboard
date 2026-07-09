import { onScopeDispose, ref } from 'vue'
import type { Ref } from 'vue'

export function useMediaQuery(query: string): Ref<boolean> {
  const matches = ref(false)
  if (typeof window === 'undefined' || !window.matchMedia) return matches

  const list = window.matchMedia(query)
  matches.value = list.matches

  const update = (event: MediaQueryListEvent) => (matches.value = event.matches)
  list.addEventListener('change', update)
  onScopeDispose(() => list.removeEventListener('change', update))

  return matches
}
