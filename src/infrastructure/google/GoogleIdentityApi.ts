export interface GoogleIdentityApi {
  accounts: {
    oauth2: {
      initTokenClient(configuration: {
        client_id: string
        scope: string
        prompt: string
        callback: (response: {
          access_token?: string
          expires_in?: number | string
          scope?: string
          error?: string
        }) => void
        error_callback: (failure: { type: 'popup_failed_to_open' | 'popup_closed' | 'unknown' }) => void
      }): { requestAccessToken(): void }
    }
  }
}
