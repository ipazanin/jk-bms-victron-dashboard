import type { GooglePickerBuilder } from './GooglePickerBuilder'

export interface GooglePickerApi {
  DocsView: new (viewId: string) => {
    setMimeTypes(mimeTypes: string): unknown
    setIncludeFolders(included: boolean): unknown
    setSelectFolderEnabled(enabled: boolean): unknown
  }
  ViewId: { FOLDERS: string }
  Action: { PICKED: 'picked', CANCEL: 'cancel', ERROR: 'error' }
  Response: { ACTION: 'action', DOCUMENTS: 'docs' }
  Document: { ID: 'id', NAME: 'name', MIME_TYPE: 'mimeType' }
  PickerBuilder: new () => GooglePickerBuilder
}
