export interface GooglePickerBuilder {
  addView(view: unknown): GooglePickerBuilder
  setAppId(appId: string): GooglePickerBuilder
  setOAuthToken(token: string): GooglePickerBuilder
  setDeveloperKey(key: string): GooglePickerBuilder
  setOrigin(origin: string): GooglePickerBuilder
  setCallback(callback: (response: {
    action?: string
    docs?: { id?: string, name?: string, mimeType?: string }[]
  }) => void): GooglePickerBuilder
  build(): { setVisible(visible: boolean): void, dispose(): void }
}
