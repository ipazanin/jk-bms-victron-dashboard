import { onScopeDispose, ref, watch } from 'vue'
import type { Ref } from 'vue'

/**
 * An element's measured width, kept in a `Ref` fed by a `ResizeObserver`.
 *
 * The caller creates and owns the target ref; this composable only observes whatever element ends
 * up bound to it.
 *
 * @param fallback Only ever the first frame's width: the observer answers before anything is
 * painted twice.
 */
export function useMeasuredWidth(target: Ref<Element | null>, fallback = 640): Ref<number> {
  const width = ref(fallback)
  let observer: ResizeObserver | null = null

  watch(target, (element) => {
    observer?.disconnect()
    observer = null
    if (element === null || typeof ResizeObserver === 'undefined') return

    observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0
      if (measured > 0) width.value = Math.round(measured)
    })
    observer.observe(element)
  })

  onScopeDispose(() => observer?.disconnect())

  return width
}
