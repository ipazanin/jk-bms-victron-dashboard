// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GooglePickerBuilder } from '../src/infrastructure/google/GooglePickerBuilder'
import { pickGoogleSpreadsheet } from '../src/infrastructure/google/googlePicker'

vi.mock('../src/infrastructure/google/googleAuth', () => ({ googleAccessToken: () => 'token' }))
vi.mock('../src/infrastructure/google/loadGoogleScript', () => ({ loadGoogleScript: async () => {} }))
let callback: Parameters<GooglePickerBuilder['setCallback']>[0]
const dispose = vi.fn()
const setVisible = vi.fn()

beforeEach(() => {
  dispose.mockReset()
  setVisible.mockReset()
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'client')
  vi.stubEnv('VITE_GOOGLE_API_KEY', 'key')
  vi.stubEnv('VITE_GOOGLE_PROJECT_NUMBER', '123')
  const builder: GooglePickerBuilder = {
    addView() { return builder }, setAppId() { return builder }, setOAuthToken() { return builder },
    setDeveloperKey() { return builder }, setOrigin() { return builder },
    setCallback(listener) { callback = listener; return builder },
    build() { return { setVisible, dispose } },
  }
  vi.stubGlobal('gapi', { load: (_library: string, handlers: { callback(): void }) => handlers.callback() })
  vi.stubGlobal('google', { picker: {
    DocsView: class { setMimeTypes() {} },
    ViewId: { SPREADSHEETS: 'spreadsheets' },
    Action: { PICKED: 'picked', CANCEL: 'cancel', ERROR: 'error' },
    Response: { ACTION: 'action', DOCUMENTS: 'docs' },
    Document: { ID: 'id', NAME: 'name', MIME_TYPE: 'mimeType' },
    PickerBuilder: class { constructor() { return builder } },
  } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Google file picker cancellation', () => {
  it('disposes the open dialog and rejects when sync is cancelled', async () => {
    const controller = new AbortController()
    const picked = pickGoogleSpreadsheet(controller.signal)
    const rejected = expect(picked).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(setVisible).toHaveBeenCalledWith(true))
    controller.abort()
    await rejected
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('removes the abort listener after a selection has settled', async () => {
    const controller = new AbortController()
    const picked = pickGoogleSpreadsheet(controller.signal)
    await vi.waitFor(() => expect(setVisible).toHaveBeenCalledWith(true))
    callback({ action: 'picked', docs: [{ id: 'sheet', name: 'Archive', mimeType: 'application/vnd.google-apps.spreadsheet' }] })
    await expect(picked).resolves.toEqual({ id: 'sheet', name: 'Archive' })
    controller.abort()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('resolves nothing when the user closes the dialog', async () => {
    const picked = pickGoogleSpreadsheet(new AbortController().signal)
    await vi.waitFor(() => expect(setVisible).toHaveBeenCalledWith(true))
    callback({ action: 'cancel' })
    await expect(picked).resolves.toBeNull()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('disposes the dialog and rejects when the picker reports an error', async () => {
    const controller = new AbortController()
    const picked = pickGoogleSpreadsheet(controller.signal)
    await vi.waitFor(() => expect(setVisible).toHaveBeenCalledWith(true))
    callback({ action: 'error' })
    await expect(picked).rejects.toThrow('Google file picker reported an error. Try again.')
    controller.abort()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not open a dialog after cancellation during preparation', async () => {
    const controller = new AbortController()
    const picked = pickGoogleSpreadsheet(controller.signal)
    controller.abort()
    await expect(picked).rejects.toMatchObject({ name: 'AbortError' })
    expect(setVisible).not.toHaveBeenCalled()
  })
})
