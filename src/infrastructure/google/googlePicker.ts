import type { GooglePickerApi } from './GooglePickerApi'
import { googleConfig } from './googleConfig'
import { googleAccessToken } from './googleAuth'
import { loadGoogleScript } from './loadGoogleScript'

let prepared: Promise<void> | null = null

export function prepareGooglePicker(): Promise<void> {
  prepared ??= loadGoogleScript('https://apis.google.com/js/api.js').then(() => new Promise<void>((resolve, reject) => {
    const loader = (globalThis as unknown as {
      gapi?: { load(library: string, handlers: { callback(): void, onerror(): void, timeout: number, ontimeout(): void }): void }
    }).gapi
    const fail = () => reject(new Error('Google file picker could not load. Check your connection and try again.'))
    if (!loader) {
      fail()
      return
    }
    loader.load('picker', { callback: resolve, onerror: fail, timeout: 20_000, ontimeout: fail })
  })).catch((error: unknown) => {
    prepared = null
    throw error
  })
  return prepared
}

export async function pickGoogleSpreadsheet(signal: AbortSignal): Promise<{ id: string, name: string } | null> {
  signal.throwIfAborted()
  const configuration = googleConfig()
  if (!configuration) throw new Error('Google sync is not configured for this app.')
  await prepareGooglePicker()
  signal.throwIfAborted()
  const accessToken = googleAccessToken()
  const pickerApi = (globalThis as unknown as { google: { picker: GooglePickerApi } }).google.picker
  if (!pickerApi) throw new Error('Google file picker could not load. Reload the page and try again.')
  const view = new pickerApi.DocsView(pickerApi.ViewId.SPREADSHEETS)
  view.setMimeTypes('application/vnd.google-apps.spreadsheet')
  return new Promise((resolve, reject) => {
    let picker: { setVisible(visible: boolean): void, dispose(): void } | undefined
    function close() {
      signal.removeEventListener('abort', cancel)
      picker?.dispose()
    }
    function cancel() {
      close()
      reject(new DOMException('Google file selection was cancelled.', 'AbortError'))
    }
    picker = new pickerApi.PickerBuilder()
      .addView(view)
      .setAppId(configuration.projectNumber)
      .setDeveloperKey(configuration.apiKey)
      .setOAuthToken(accessToken)
      .setOrigin(window.location.origin)
      .setCallback((response) => {
        const action = response[pickerApi.Response.ACTION]
        if (action === pickerApi.Action.CANCEL) {
          close()
          resolve(null)
        }
        if (action === pickerApi.Action.ERROR) {
          close()
          reject(new Error('Google file picker reported an error. Try again.'))
        }
        if (action === pickerApi.Action.PICKED) {
          close()
          const document = response[pickerApi.Response.DOCUMENTS]?.[0]
          const id = document?.[pickerApi.Document.ID]
          if (!id || document?.[pickerApi.Document.MIME_TYPE] !== 'application/vnd.google-apps.spreadsheet') {
            reject(new Error('Select a Google spreadsheet to open an archive.'))
            return
          }
          resolve({ id, name: document[pickerApi.Document.NAME] || 'Google archive' })
        }
      })
      .build()
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) {
      cancel()
      return
    }
    picker.setVisible(true)
  })
}
