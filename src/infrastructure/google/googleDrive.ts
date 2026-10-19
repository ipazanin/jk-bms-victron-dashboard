import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'
import type { DriveFile } from './DriveFile'
import { googleRequest, jsonRequest } from './googleRequest'

export const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
export const DRIVE_FIELDS = 'id,name,mimeType,parents,appProperties,size,trashed,description,createdTime'

export function driveLiteral(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

export async function getDriveFile(id: string, signal: AbortSignal): Promise<DriveFile> {
  checkGoogleId(id)
  const response = await googleRequest(`${DRIVE_FILES}/${encodeURIComponent(id)}?fields=${DRIVE_FIELDS}`, signal)
  return await response.json() as DriveFile
}

export async function listDriveFiles(query: string, signal: AbortSignal): Promise<DriveFile[]> {
  const files: DriveFile[] = []
  let pageToken: string | undefined
  const seenPages = new Set<string>()
  do {
    const parameters = new URLSearchParams({ q: query, fields: `nextPageToken,files(${DRIVE_FIELDS})`, pageSize: '1000', spaces: 'drive' })
    if (pageToken) parameters.set('pageToken', pageToken)
    const response = await googleRequest(`${DRIVE_FILES}?${parameters}`, signal)
    const page = await response.json() as { files?: DriveFile[], nextPageToken?: string }
    if (!Array.isArray(page.files)) throw new Error('Google returned an invalid file list.')
    files.push(...page.files)
    if (files.length > 100_000 || seenPages.size >= 100) throw new Error('This Google archive has too many files to open safely.')
    pageToken = page.nextPageToken
    if (pageToken) {
      if (seenPages.has(pageToken)) throw new Error('Google returned a repeated file page. Try again.')
      seenPages.add(pageToken)
    }
  } while (pageToken)
  return files
}

export async function createDriveFile(name: string, mimeType: string, role: string, folderId: string | null, signal: AbortSignal): Promise<DriveFile> {
  const response = await googleRequest(`${DRIVE_FILES}?fields=${DRIVE_FIELDS}`, signal, jsonRequest('POST', {
    name, mimeType,
    appProperties: { shuntCloud: '1', shuntRole: role, ...(folderId ? { shuntWorkspace: folderId } : {}) },
    ...(folderId ? { parents: [folderId] } : {}),
  }))
  return await response.json() as DriveFile
}

export function checkGoogleId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new Error('The Google file identifier is invalid.')
}

export function checkWorkspace(workspace: CloudWorkspace): void {
  checkGoogleId(workspace.id)
  checkGoogleId(workspace.folderId)
  if (!workspace.name.trim() || workspace.name.length > 200) throw new Error('The Google archive name is invalid.')
  if (workspace.version !== undefined && workspace.version !== 1 && workspace.version !== 2) throw new Error('This Google archive version requires a newer app.')
}

export function isShuntFile(file: DriveFile, role: string, mimeType: string): boolean {
  return file.appProperties?.shuntCloud === '1' && file.appProperties.shuntRole === role && file.mimeType === mimeType && file.trashed !== true
}
