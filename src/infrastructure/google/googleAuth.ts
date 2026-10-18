import type { GoogleIdentityApi } from './GoogleIdentityApi'
import { googleConfig } from './googleConfig'
import { loadGoogleScript } from './loadGoogleScript'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const EXPIRY_MARGIN_MS = 60_000
const listeners = new Set<(connected: boolean) => void>()
let token: { accessToken: string, expiresAt: number } | null = null
let identity: GoogleIdentityApi | null = null
let expiryTimer: ReturnType<typeof setTimeout> | undefined
let generation = 0
let rejectPending: ((reason: Error) => void) | null = null

export async function prepareGoogleIdentity(): Promise<void> {
  if (!googleConfig()) throw new Error('Google sync is not configured for this app.')
  await loadGoogleScript('https://accounts.google.com/gsi/client')
  identity = (globalThis as unknown as { google?: GoogleIdentityApi }).google ?? null
  if (!identity?.accounts?.oauth2) throw new Error('Google sign-in could not load. Reload the page and try again.')
}

/** Call from a click after preparation, so the browser can open Google's popup. */
export function requestGoogleAccess(): Promise<void> {
  const configuration = googleConfig()
  if (!configuration || !identity) return Promise.reject(new Error('Google sign-in is still loading. Try again when it is ready.'))
  if (rejectPending) return Promise.reject(new Error('Finish the open Google sign-in window first.'))
  const requestedGeneration = ++generation
  return new Promise<void>((resolve, reject) => {
    rejectPending = reject
    function fail(message: string) {
      if (requestedGeneration !== generation) return
      generation++
      rejectPending = null
      reject(new Error(message))
    }
    try {
      const client = identity!.accounts.oauth2.initTokenClient({
        client_id: configuration.clientId,
        scope: DRIVE_SCOPE,
        prompt: '',
        callback: (response) => {
          if (requestedGeneration !== generation) return
          if (response.error) {
            fail('Google access was not granted. Your local archive is unchanged.')
            return
          }
          if (!response.scope?.split(/\s+/).includes(DRIVE_SCOPE)) {
            fail('Allow access to the files you select to use Google sync.')
            return
          }
          const lifetime = Number(response.expires_in) * 1000 - EXPIRY_MARGIN_MS
          if (!response.access_token || !Number.isFinite(lifetime) || lifetime <= 0) {
            fail('Google returned an expired or incomplete sign-in. Connect again.')
            return
          }
          generation++
          clearTimeout(expiryTimer)
          token = { accessToken: response.access_token, expiresAt: Date.now() + lifetime }
          rejectPending = null
          expiryTimer = setTimeout(forgetGoogleAccess, lifetime)
          notifyAccess()
          resolve()
        },
        error_callback: (failure) => {
          if (failure.type === 'popup_closed') fail('Google sign-in was cancelled.')
          else if (failure.type === 'popup_failed_to_open') fail('Google sign-in could not open. Allow popups for this site and try again.')
          else fail('Google sign-in failed. Try again.')
        },
      })
      client.requestAccessToken()
    } catch {
      fail('Google sign-in could not open. Try again.')
    }
  })
}

export function googleAccessToken(): string {
  if (token && token.expiresAt > Date.now()) return token.accessToken
  forgetGoogleAccess()
  throw new Error('Connect to Google again to continue syncing.')
}

export function forgetGoogleAccess(): void {
  generation++
  clearTimeout(expiryTimer)
  token = null
  const pending = rejectPending
  rejectPending = null
  pending?.(new Error('Google sign-in was cancelled.'))
  notifyAccess()
}

export function subscribeGoogleAccess(listener: (connected: boolean) => void): () => void {
  listeners.add(listener)
  listener(token !== null && token.expiresAt > Date.now())
  return () => listeners.delete(listener)
}

function notifyAccess(): void {
  for (const listener of listeners) listener(token !== null)
}
