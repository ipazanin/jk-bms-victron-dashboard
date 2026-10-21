import type { DriveFile } from './DriveFile'
import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'
import { checkGoogleId, checkWorkspace, driveLiteral, DRIVE_FILES, FOLDER_MIME, getDriveFile, isShuntFile, listDriveFiles, SHEET_MIME } from './googleDrive'
import { pickGoogleFolder } from './googlePicker'
import { googleRequest, jsonRequest } from './googleRequest'
import { readSheetRanges } from './googleSheets'

function workspaceFromFile(file: DriveFile): CloudWorkspace | null {
  const version = file.appProperties?.shuntVersion
  let workspace: CloudWorkspace
  if (version === '3' && isShuntFile(file, 'workspace', FOLDER_MIME)) {
    workspace = { id: file.id, name: file.name, folderId: file.id, version: 3 }
  } else {
    const folderId = file.appProperties?.shuntWorkspace
    if (!folderId || !isShuntFile(file, 'catalog', SHEET_MIME) || !file.parents?.includes(folderId)
      || (version !== undefined && version !== '1' && version !== '2')) return null
    workspace = { id: file.id, name: file.name, folderId, ...(version === '2' ? { version: 2 } : {}) }
  }
  try {
    checkWorkspace(workspace)
    return workspace
  } catch {
    return null
  }
}

export async function listGoogleWorkspaces(signal: AbortSignal): Promise<readonly CloudWorkspace[]> {
  const files = await listDriveFiles("trashed = false and appProperties has { key='shuntCloud' and value='1' } and (appProperties has { key='shuntRole' and value='catalog' } or appProperties has { key='shuntRole' and value='workspace' })", signal)
  return files.flatMap((file) => {
    const workspace = workspaceFromFile(file)
    return workspace ? [workspace] : []
  })
}

export async function createGoogleWorkspace(name: string, parentFolderId: string, signal: AbortSignal): Promise<CloudWorkspace> {
  signal.throwIfAborted()
  const archiveName = name.trim()
  if (!archiveName || archiveName.length > 200) throw new Error('Choose an archive name of 1 to 200 characters.')
  const parent = await getDriveFile(parentFolderId, signal)
  if (parent.mimeType !== FOLDER_MIME || parent.trashed || parent.capabilities?.canAddChildren !== true) {
    throw new Error('Choose a Google Drive folder where you can create files.')
  }
  signal.throwIfAborted()
  const response = await googleRequest(`${DRIVE_FILES}?fields=id`, signal, jsonRequest('POST', {
    name: archiveName, mimeType: FOLDER_MIME, parents: [parentFolderId],
    appProperties: { shuntCloud: '1', shuntRole: 'workspace', shuntVersion: '3' },
  }))
  const folder = await response.json() as DriveFile
  checkGoogleId(folder.id)
  return { id: folder.id, name: archiveName, folderId: folder.id, version: 3 }
}

export async function pickGoogleWorkspace(signal: AbortSignal): Promise<CloudWorkspace | null> {
  signal.throwIfAborted()
  const selected = await pickGoogleFolder(signal)
  signal.throwIfAborted()
  if (!selected) return null
  const folder = await getDriveFile(selected.id, signal)
  if (!isShuntFile(folder, 'workspace', FOLDER_MIME)) {
    throw new Error('This folder is not a Shunt archive. Choose an archive created by this app.')
  }
  const workspace = workspaceFromFile(folder)
  if (workspace) return workspace
  const version = folder.appProperties?.shuntVersion
  if (version !== undefined && version !== '1' && version !== '2') {
    throw new Error('This Google archive version requires a newer app.')
  }
  const catalogs = await listDriveFiles(`trashed = false and '${driveLiteral(folder.id)}' in parents and appProperties has { key='shuntRole' and value='catalog' }`, signal)
  const legacyWorkspaces = catalogs.flatMap((catalog) => {
    const legacy = workspaceFromFile(catalog)
    return legacy && legacy.folderId === folder.id ? [legacy] : []
  })
  if (legacyWorkspaces.length !== 1) throw new Error('This Google archive has invalid folder metadata. Nothing was changed.')
  await validateGoogleWorkspace(legacyWorkspaces[0]!, signal)
  return legacyWorkspaces[0]!
}

export async function validateGoogleWorkspace(workspace: CloudWorkspace, signal: AbortSignal): Promise<1 | 2 | 3> {
  checkWorkspace(workspace)
  if (workspace.version === 3) {
    const folder = await getDriveFile(workspace.folderId, signal)
    if (!isShuntFile(folder, 'workspace', FOLDER_MIME) || folder.appProperties?.shuntVersion !== '3') {
      throw new Error('This Google archive has invalid folder metadata. Nothing was changed.')
    }
    return 3
  }
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
