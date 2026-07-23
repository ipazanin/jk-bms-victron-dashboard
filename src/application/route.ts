/**
 * Where the page is, kept in the URL so a session can be linked to and survives a reload.
 *
 * The route rides in the hash because the page is served as static files: a path-based route would
 * need a server willing to answer `/log/<id>` with `index.html`, and there is no server. Everything
 * before the hash is untouched by a hash assignment, so `?theme=light` survives every navigation
 * without this module knowing it exists.
 *
 * A route is not a Source. `route` is what the user is looking at; `source` is what the numbers on
 * the instruments are. Opening the Log while both radios are live changes the first and must not
 * change the second.
 */

import { ref } from 'vue'
import type { Ref } from 'vue'

import type { SessionId } from '../domain/history/types'

export type Route =
  | { readonly name: 'dashboard' }
  | { readonly name: 'connect' }
  | { readonly name: 'stats' }
  | { readonly name: 'log' }
  | { readonly name: 'warnings' }
  | { readonly name: 'session'; readonly id: SessionId }

const LOG_SEGMENT = 'log'
const CONNECT_SEGMENT = 'connect'
const STATS_SEGMENT = 'stats'
const WARNINGS_SEGMENT = 'warnings'

/** Shared instances, so a hashchange that resolves to the same place assigns nothing. */
const DASHBOARD: Route = { name: 'dashboard' }
const CONNECT: Route = { name: 'connect' }
const STATS: Route = { name: 'stats' }
const LOG: Route = { name: 'log' }
const WARNINGS: Route = { name: 'warnings' }

const current = ref<Route>(parseRoute(currentHash()))

/** This module is the only writer; `navigate` is the way in. */
export const route: Readonly<Ref<Route>> = current

/**
 * The grammar, in one place and pure so it can be tested without a window: `#/` or no hash at all
 * is the dashboard, `#/connect` and `#/stats` are the two standalone tabs, `#/log` is the list,
 * `#/log/<sessionId>` is one session. Anything else is the dashboard rather than an error page — a
 * stale bookmark should land somewhere useful and say nothing, which is what a hash the app no
 * longer understands deserves.
 */
export function parseRoute(hash: string): Route {
  const segments = hash
    .replace(/^#/, '')
    .split('/')
    .filter((segment) => segment.length > 0)

  if (segments[0] === CONNECT_SEGMENT) return CONNECT
  if (segments[0] === STATS_SEGMENT) return STATS
  if (segments[0] === WARNINGS_SEGMENT) return WARNINGS
  if (segments[0] !== LOG_SEGMENT) return DASHBOARD
  if (segments.length === 1) return LOG

  const id = decodeSegment(segments[1])
  return id === '' ? LOG : { name: 'session', id }
}

/** The href a link should carry, so navigation is real anchors the browser can open in a new tab. */
export function hashOf(target: Route): string {
  switch (target.name) {
    case 'connect':
      return `#/${CONNECT_SEGMENT}`
    case 'stats':
      return `#/${STATS_SEGMENT}`
    case 'warnings':
      return `#/${WARNINGS_SEGMENT}`
    case 'log':
      return `#/${LOG_SEGMENT}`
    case 'session':
      return `#/${LOG_SEGMENT}/${encodeURIComponent(target.id)}`
    default:
      return '#/'
  }
}

export function navigate(next: Route): void {
  const hash = hashOf(next)
  if (typeof window !== 'undefined') window.location.hash = hash
  // Assigning a hash the page already carries fires no hashchange, so the ref is synced from the
  // assigned value here instead of waiting for a listener that may never run.
  apply(parseRoute(hash))
}

/**
 * Starts listening, after resolving the hash the page was opened with — a deep link must land on
 * its session on the first paint, not on the second. Returns an unsubscribe, like `watchAdapter`.
 */
export function startRouting(): () => void {
  if (typeof window === 'undefined') return () => undefined

  const sync = (): void => apply(parseRoute(window.location.hash))
  sync()
  window.addEventListener('hashchange', sync)
  return () => window.removeEventListener('hashchange', sync)
}

function apply(next: Route): void {
  if (sameRoute(current.value, next)) return
  current.value = next
}

function sameRoute(left: Route, right: Route): boolean {
  if (left.name === 'session' && right.name === 'session') return left.id === right.id
  return left.name === right.name
}

function currentHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash
}

/** A hand-edited address bar can carry a stray `%`, which throws rather than returning anything. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment).trim()
  } catch {
    return ''
  }
}
