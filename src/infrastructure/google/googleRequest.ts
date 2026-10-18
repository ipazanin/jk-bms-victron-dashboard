import { forgetGoogleAccess, googleAccessToken } from './googleAuth'

export async function googleRequest(url: string, signal: AbortSignal, request: RequestInit = {}): Promise<Response> {
  signal.throwIfAborted()
  const headers = new Headers(request.headers)
  headers.set('Authorization', `Bearer ${googleAccessToken()}`)
  const response = await fetch(url, { ...request, headers, signal }).catch((error: unknown) => {
    if (signal.aborted) throw error
    throw new Error('Google could not be reached. Check your connection. Sync will try again.')
  })
  if (response.ok) return response
  if (response.status === 401) {
    forgetGoogleAccess()
    throw new Error('Google access expired. Connect to Google again and retry.')
  }
  if (response.status === 429 || (response.status === 403 && await isRateLimited(response))) {
    throw new Error('Google is receiving too many requests. Wait a minute before trying again.')
  }
  if (response.status === 403) throw new Error('Google refused access. Select this archive again and check that Drive, Sheets and Picker APIs are enabled.')
  if (response.status === 404) throw new Error('This Google archive is unavailable. It may have been deleted or shared with another account.')
  throw new Error(`Google could not complete the request (${response.status}). Retry when your connection is available.`)
}

async function isRateLimited(response: Response): Promise<boolean> {
  const body = await response.json().catch(() => null) as { error?: { errors?: { reason?: string }[] } } | null
  const reason = body?.error?.errors?.[0]?.reason
  return reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'
}

export function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}
