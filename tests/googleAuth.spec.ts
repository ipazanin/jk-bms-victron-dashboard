// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoogleIdentityApi } from '../src/infrastructure/google/GoogleIdentityApi'

type TokenConfiguration = Parameters<GoogleIdentityApi['accounts']['oauth2']['initTokenClient']>[0]
let configuration: TokenConfiguration
const requestAccessToken = vi.fn()

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  document.head.innerHTML = ''
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'client')
  vi.stubEnv('VITE_GOOGLE_API_KEY', 'key')
  vi.stubEnv('VITE_GOOGLE_PROJECT_NUMBER', '123')
  vi.stubGlobal('google', { accounts: { oauth2: {
    initTokenClient: (requested: TokenConfiguration) => {
      configuration = requested
      return { requestAccessToken }
    },
  } } })
  requestAccessToken.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function preparedAuth() {
  const auth = await import('../src/infrastructure/google/googleAuth')
  const preparation = auth.prepareGoogleIdentity()
  document.querySelector('script')!.dispatchEvent(new Event('load'))
  await preparation
  return auth
}

function grant() {
  configuration.callback({ access_token: 'token', scope: 'https://www.googleapis.com/auth/drive.file', expires_in: 3600 })
}

describe('Google access', () => {
  it('opens the popup during the calling click and expires the token in memory', async () => {
    const auth = await preparedAuth()
    const changed = vi.fn()
    auth.subscribeGoogleAccess(changed)
    const access = auth.requestGoogleAccess()
    expect(requestAccessToken).toHaveBeenCalledOnce()
    grant()
    await access
    expect(auth.googleAccessToken()).toBe('token')
    expect(changed).toHaveBeenLastCalledWith(true)
    vi.advanceTimersByTime(3_540_000)
    expect(() => auth.googleAccessToken()).toThrow('Connect to Google again')
    expect(changed).toHaveBeenLastCalledWith(false)
    expect(localStorage.length).toBe(0)
  })

  it('does not restore access when a cancelled request returns late', async () => {
    const auth = await preparedAuth()
    const access = auth.requestGoogleAccess()
    const rejection = expect(access).rejects.toThrow('cancelled')
    auth.forgetGoogleAccess()
    grant()
    await rejection
    expect(() => auth.googleAccessToken()).toThrow('Connect to Google again')
  })

  it('reports a closed popup and permits another request', async () => {
    const auth = await preparedAuth()
    const access = auth.requestGoogleAccess()
    configuration.error_callback({ type: 'popup_closed' })
    await expect(access).rejects.toThrow('cancelled')
    const next = auth.requestGoogleAccess()
    grant()
    await next
    auth.forgetGoogleAccess()
  })

  it('asks for popups only when the popup failed to open', async () => {
    const auth = await preparedAuth()
    const blocked = auth.requestGoogleAccess()
    configuration.error_callback({ type: 'popup_failed_to_open' })
    await expect(blocked).rejects.toThrow('Allow popups')
    const failed = auth.requestGoogleAccess()
    configuration.error_callback({ type: 'unknown' })
    await expect(failed).rejects.toThrow('Google sign-in failed. Try again.')
  })

  it('rejects access without the requested file permission', async () => {
    const auth = await preparedAuth()
    const access = auth.requestGoogleAccess()
    configuration.callback({ access_token: 'token', expires_in: 3600, scope: 'openid' })
    await expect(access).rejects.toThrow('Allow access')
    expect(() => auth.googleAccessToken()).toThrow('Connect to Google again')
  })

  it('retries after a failed script load', async () => {
    const auth = await import('../src/infrastructure/google/googleAuth')
    const failed = auth.prepareGoogleIdentity()
    document.querySelector('script')!.dispatchEvent(new Event('error'))
    await expect(failed).rejects.toThrow('Google could not load')
    expect(document.querySelector('script')).toBeNull()
    const retry = auth.prepareGoogleIdentity()
    document.querySelector('script')!.dispatchEvent(new Event('load'))
    await retry
  })

  it('refuses Google setup in fake-radio mode without loading external scripts', async () => {
    vi.stubEnv('VITE_FAKE_BLE', 'true')
    const auth = await import('../src/infrastructure/google/googleAuth')
    await expect(auth.prepareGoogleIdentity()).rejects.toThrow('not configured')
    expect(document.querySelector('script')).toBeNull()
    expect(requestAccessToken).not.toHaveBeenCalled()
  })

  it('allows the app to load with absent Google configuration', async () => {
    vi.stubEnv('VITE_GOOGLE_API_KEY', '')
    const { googleConfig } = await import('../src/infrastructure/google/googleConfig')
    expect(googleConfig()).toBeNull()
  })
})
