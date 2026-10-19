import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'
import { checkGoogleId, checkWorkspace, createDriveFile, DRIVE_FILES, FOLDER_MIME, getDriveFile, isShuntFile, listDriveFiles, SHEET_MIME } from './googleDrive'
import { pickGoogleSpreadsheet } from './googlePicker'
import { googleRequest, jsonRequest } from './googleRequest'
import { readSheetRanges, SETTINGS_HEADER, SHEETS } from './googleSheets'

export async function listGoogleWorkspaces(signal: AbortSignal): Promise<readonly CloudWorkspace[]> {
  const files = await listDriveFiles("trashed = false and appProperties has { key='shuntCloud' and value='1' } and appProperties has { key='shuntRole' and value='catalog' }", signal)
  return files.flatMap((file) => {
    const folderId = file.appProperties?.shuntWorkspace
    if (!folderId || !isShuntFile(file, 'catalog', SHEET_MIME) || !file.parents?.includes(folderId)) return []
    const version = file.appProperties?.shuntVersion
    if (version !== undefined && version !== '1' && version !== '2') return []
    const workspace: CloudWorkspace = { id: file.id, name: file.name, folderId, ...(version === '2' ? { version: 2 } : {}) }
    try {
      checkWorkspace(workspace)
    } catch {
      return []
    }
    return [workspace]
  })
}

export async function createGoogleWorkspace(name: string, signal: AbortSignal): Promise<CloudWorkspace> {
  const archiveName = name.trim()
  if (!archiveName || archiveName.length > 200) throw new Error('Choose an archive name of 1 to 200 characters.')
  const folder = await createDriveFile(archiveName, FOLDER_MIME, 'workspace', null, signal)
  checkGoogleId(folder.id)
  const sheet = await createDriveFile(archiveName, SHEET_MIME, 'initializing', folder.id, signal)
  checkGoogleId(sheet.id)
  const response = await googleRequest(`${SHEETS}/${sheet.id}?fields=sheets.properties.sheetId`, signal)
  const existing = await response.json() as { sheets?: { properties: { sheetId: number } }[] }
  const requests: unknown[] = ['Info', 'Settings'].map((title) => ({ addSheet: { properties: { title } } }))
  for (const tab of existing.sheets ?? []) requests.push({ deleteSheet: { sheetId: tab.properties.sheetId } })
  await googleRequest(`${SHEETS}/${sheet.id}:batchUpdate`, signal, jsonRequest('POST', { requests }))
  await googleRequest(`${SHEETS}/${sheet.id}/values:batchUpdate`, signal, jsonRequest('POST', {
    valueInputOption: 'RAW', data: [
      { range: "'Info'!A1", values: [['format', 'shunt-cloud'], ['version', 2], ['folderId', folder.id]] },
      { range: "'Settings'!A1", values: [SETTINGS_HEADER] },
    ],
  }))
  await googleRequest(`${DRIVE_FILES}/${sheet.id}`, signal, jsonRequest('PATCH', {
    appProperties: { shuntRole: 'catalog', shuntVersion: '2' },
  }))
  return { id: sheet.id, name: archiveName, folderId: folder.id, version: 2 }
}

export async function pickGoogleWorkspace(signal: AbortSignal): Promise<CloudWorkspace | null> {
  signal.throwIfAborted()
  const selected = await pickGoogleSpreadsheet(signal)
  signal.throwIfAborted()
  if (!selected) return null
  const sheet = await getDriveFile(selected.id, signal)
  const folderId = sheet.appProperties?.shuntWorkspace
  if (!folderId || !isShuntFile(sheet, 'catalog', SHEET_MIME)) throw new Error('This spreadsheet is not a Shunt archive. Choose an archive created by this app.')
  const workspace: CloudWorkspace = { id: sheet.id, name: sheet.name, folderId, ...(sheet.appProperties?.shuntVersion === '2' ? { version: 2 } : {}) }
  await validateGoogleWorkspace(workspace, signal)
  return workspace
}

export async function validateGoogleWorkspace(workspace: CloudWorkspace, signal: AbortSignal): Promise<1 | 2> {
  checkWorkspace(workspace)
  const [sheet, folder, tables] = await Promise.all([
    getDriveFile(workspace.id, signal), getDriveFile(workspace.folderId, signal),
    readSheetRanges(workspace.id, ["'Info'!A1:C4"], signal),
  ])
  if (!isShuntFile(sheet, 'catalog', SHEET_MIME) || !isShuntFile(folder, 'workspace', FOLDER_MIME)
    || sheet.appProperties?.shuntWorkspace !== workspace.folderId || !sheet.parents?.includes(workspace.folderId)
    || JSON.stringify(tables[0]) !== JSON.stringify([['format', 'shunt-cloud'], ['version', workspace.version ?? 1], ['folderId', workspace.folderId]])) {
    throw new Error('This Google archive has invalid format or folder metadata. Nothing was changed.')
  }
  return workspace.version ?? 1
}

export async function trashGoogleWorkspace(workspace: CloudWorkspace, signal: AbortSignal): Promise<void> {
  await validateGoogleWorkspace(workspace, signal)
  await googleRequest(`${DRIVE_FILES}/${encodeURIComponent(workspace.folderId)}`, signal, jsonRequest('PATCH', { trashed: true }))
}
