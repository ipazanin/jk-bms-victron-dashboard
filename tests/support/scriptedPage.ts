/**
 * A page that is in front, or behind, exactly when a spec says so.
 *
 * There is no way to put a real window behind another one from a test, and the two states are what
 * the rejoin supervisor spends most of its life waiting on, so they are supplied rather than read.
 * Visibility and focus move apart here for the same reason they do on a desk: a window on a second
 * monitor stays visible while the owner types somewhere else.
 */

import type { PageActivity } from '../../src/application/pageActivity'

export interface ScriptedPage {
  readonly activity: PageActivity
  show(): void
  hide(): void
  focus(): void
  blur(): void
}

export function scriptedPage(options: { visible?: boolean; focused?: boolean } = {}): ScriptedPage {
  let visible = options.visible ?? true
  let focused = options.focused ?? true
  const listeners = new Set<() => void>()

  const announce = (): void => {
    for (const listener of [...listeners]) listener()
  }

  return {
    activity: {
      visible: () => visible,
      focused: () => focused,
      subscribe(onChange) {
        listeners.add(onChange)
        return () => listeners.delete(onChange)
      },
    },
    show() {
      visible = true
      announce()
    },
    hide() {
      visible = false
      announce()
    },
    focus() {
      focused = true
      announce()
    },
    blur() {
      focused = false
      announce()
    },
  }
}
