import { createApp } from 'vue'
import type { App, Component } from 'vue'

let app: App | null = null
let host: HTMLElement | null = null

/** Mounts one component on a detached host and hands back its rendered text, SVG included. */
export function textOf(component: Component, props: Record<string, unknown>): string {
  unmountComponent()
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(component, props)
  app.mount(host)
  return host.textContent ?? ''
}

export function unmountComponent(): void {
  app?.unmount()
  app = null
  host?.remove()
  host = null
}
