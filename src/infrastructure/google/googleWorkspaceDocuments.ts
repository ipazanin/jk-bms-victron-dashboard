import type { CloudCatalog } from '../../domain/sync/CloudCatalog'
import type { CloudDocumentFile } from '../../domain/sync/CloudDocumentFile'
import type { CloudWorkspace } from '../../domain/sync/CloudWorkspace'
import { CLOUD_ARCHIVE_BYTES, CLOUD_DOCUMENT_BYTES, CLOUD_PUBLICATION_FILES } from '../../domain/sync/limits'
import { requireArchive } from '../../domain/backup/validation'
import { decodeCloudWorkspace, encodeCloudWorkspace, hashCloudBytes, mergeCloudCatalogs } from '../../application/sync/cloudWorkspaceJson'
import type { DriveFile } from './DriveFile'
import { checkGoogleId, checkWorkspace, DRIVE_FIELDS, DRIVE_FILES, driveLiteral, FOLDER_MIME, getDriveFile, isShuntFile, listDriveFiles } from './googleDrive'
import { downloadGoogleArchive } from './googleDriveBytes'
import { googleRequest, jsonRequest } from './googleRequest'

export async function readJsonWorkspace(workspace: CloudWorkspace, signal: AbortSignal): Promise<CloudCatalog> {
  requireJsonWorkspace(workspace)
  const files = await listDriveFiles(`'${driveLiteral(workspace.folderId)}' in parents and trashed = false and appProperties has { key='shuntCloud' and value='1' } and (appProperties has { key='shuntRole' and value='document' } or appProperties has { key='shuntRole' and value='pending-document' } or appProperties has { key='shuntRole' and value='retired-document' })`, signal)
  const completed = files.filter((file) => file.appProperties?.shuntRole === 'document')
  let catalog = mergeCloudCatalogs([])
  const publications = new Set<string>()
  for (const head of completed) {
    const receipt = documentReceipt(head, workspace)
    requireArchive(receipt.index === 0 && !publications.has(receipt.publicationId), 'cloud workspace', 'duplicate or invalid publication')
    publications.add(receipt.publicationId)
    const group = files.filter((file) => file.appProperties?.shuntPublication === receipt.publicationId)
      .map((file) => documentReceipt(file, workspace)).sort((left, right) => left.index - right.index)
    requireArchive(group.length === receipt.count && group.every((part, index) => part.index === index && part.count === receipt.count),
      'cloud workspace', 'a completed publication is missing files')
    const publicationBytes = group.reduce((sum, part) => sum + part.bytes, 0)
    requireArchive(publicationBytes <= CLOUD_ARCHIVE_BYTES, 'cloud workspace', 'workspace exceeds the download limit')
    const encoded: Uint8Array[] = []
    for (const part of group) {
      signal.throwIfAborted()
      encoded.push(await downloadDocument(part, signal))
    }
    const loaded = await decodeCloudWorkspace(encoded, receipt.publicationId)
    catalog = mergeCloudCatalogs([catalog, { ...loaded, documents: group }])
  }
  signal.throwIfAborted()
  const retired: CloudDocumentFile[] = []
  for (const head of files.filter((file) => file.appProperties?.shuntRole === 'retired-document')) {
    const receipt = documentReceipt(head, workspace)
    requireArchive(receipt.index === 0 && !publications.has(receipt.publicationId), 'cloud workspace', 'invalid retired publication')
    publications.add(receipt.publicationId)
    const group = files.filter((file) => file.appProperties?.shuntPublication === receipt.publicationId)
      .map((file) => documentReceipt(file, workspace))
    requireArchive(new Set(group.map((part) => part.index)).size === group.length
      && group.every((part) => part.count === receipt.count), 'cloud workspace', 'invalid retired files')
    retired.push(...group.map((part) => ({ ...part, retired: true as const })))
  }
  requireArchive(retired.length === 0 || catalog.documents!.length > 0, 'cloud workspace', 'the replacement for retired history is missing')
  return { ...catalog, documents: [...catalog.documents!, ...retired] }
}

export async function writeJsonWorkspace(workspace: CloudWorkspace, catalog: CloudCatalog, signal: AbortSignal): Promise<CloudCatalog> {
  requireJsonWorkspace(workspace)
  signal.throwIfAborted()
  const folder = await getDriveFile(workspace.folderId, signal)
  requireArchive(isShuntFile(folder, 'workspace', FOLDER_MIME) && folder.appProperties?.shuntVersion === '3',
    'cloud workspace', 'the workspace folder ownership changed')
  requireArchive(catalog.documents !== undefined, 'cloud workspace', 'read the workspace before publishing')
  const publicationId = crypto.randomUUID()
  const encoded = encodeCloudWorkspace(catalog, publicationId)
  await decodeCloudWorkspace(encoded, publicationId)
  const documents: CloudDocumentFile[] = []
  for (const [index, bytes] of encoded.entries()) {
    signal.throwIfAborted()
    const expected = { publicationId, index, count: encoded.length, hash: await hashCloudBytes(bytes), bytes: bytes.byteLength }
    const metadata = {
      name: encoded.length === 1 ? 'shunt.json' : `shunt-${index + 1}-of-${encoded.length}.json`,
      mimeType: 'application/json', parents: [workspace.folderId], description: JSON.stringify(expected),
      appProperties: { shuntCloud: '1', shuntRole: 'pending-document', shuntWorkspace: workspace.folderId,
        shuntPublication: publicationId, shuntHash: expected.hash },
    }
    const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files?fields=${DRIVE_FIELDS}`
    const started = await googleRequest(`${uploadUrl}&uploadType=resumable`, signal, {
      ...jsonRequest('POST', metadata),
      headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/json', 'X-Upload-Content-Length': String(bytes.byteLength) },
    })
    const location = started.headers.get('Location')
    const destination = location ? new URL(location) : null
    requireArchive(destination?.origin === 'https://www.googleapis.com' && destination.pathname === '/upload/drive/v3/files',
      'cloud workspace', 'Google returned an invalid upload destination')
    const response = await googleRequest(destination.href, signal, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: bytes.slice().buffer,
    })
    const file = await response.json() as DriveFile
    const receipt = documentReceipt(file, workspace)
    requireArchive(file.appProperties?.shuntRole === 'pending-document'
      && sameReceipt(receipt, { ...expected, id: receipt.id }),
    'cloud workspace', 'upload receipt does not match')
    documents.push(receipt)
    await downloadDocument(receipt, signal)
  }
  signal.throwIfAborted()
  const head = documents[0]!
  const saved = documentReceipt(await getDriveFile(head.id, signal), workspace)
  requireArchive(sameReceipt(saved, head), 'cloud workspace', 'the verified publication changed')
  await googleRequest(`${DRIVE_FILES}/${encodeURIComponent(head.id)}`, signal,
    jsonRequest('PATCH', { appProperties: { shuntRole: 'document' } }))
  let cleanupFailure: string | undefined
  try {
    const groups = new Map<string, CloudDocumentFile[]>()
    for (const document of catalog.documents) {
      const group = groups.get(document.publicationId) ?? []
      group.push(document)
      groups.set(document.publicationId, group)
    }
    for (const group of groups.values()) {
      const priorHead = group.find((document) => document.index === 0)
      requireArchive(priorHead !== undefined, 'cloud workspace', 'an incorporated publication has no head')
      signal.throwIfAborted()
      const priorResponse = await googleRequest(`${DRIVE_FILES}/${encodeURIComponent(priorHead.id)}?fields=${DRIVE_FIELDS}`, signal, {}, [404])
      if (priorResponse.status === 404) continue
      const prior = documentReceipt(await priorResponse.json() as DriveFile, workspace)
      requireArchive(sameReceipt(prior, priorHead), 'cloud workspace', 'an incorporated file changed before cleanup')
      await googleRequest(`${DRIVE_FILES}/${encodeURIComponent(priorHead.id)}`, signal,
        jsonRequest('PATCH', { appProperties: { shuntRole: 'retired-document' } }))
      for (const document of [...group.filter((part) => part.index !== 0), priorHead]) {
        signal.throwIfAborted()
        const response = await googleRequest(`${DRIVE_FILES}/${encodeURIComponent(document.id)}?fields=${DRIVE_FIELDS}`, signal, {}, [404])
        if (response.status === 404) continue
        const current = documentReceipt(await response.json() as DriveFile, workspace)
        requireArchive(sameReceipt(current, document), 'cloud workspace', 'an incorporated file changed before cleanup')
        await googleRequest(`${DRIVE_FILES}/${encodeURIComponent(document.id)}`, signal, { method: 'DELETE' }, [404])
      }
    }
  } catch (error) {
    cleanupFailure = `History and settings were saved, but older JSON files could not be removed. ${error instanceof Error ? error.message : 'Try syncing again.'}`
  }
  const { cleanupFailure: _previousFailure, ...savedCatalog } = catalog
  return { ...savedCatalog, documents, ...(cleanupFailure ? { cleanupFailure } : {}) }
}

function requireJsonWorkspace(workspace: CloudWorkspace): void {
  checkWorkspace(workspace)
  if (workspace.version !== 3) throw new Error('This older Google workspace is read-only. Create a JSON workspace to sync.')
}

function documentReceipt(file: DriveFile, workspace: CloudWorkspace): CloudDocumentFile {
  checkGoogleId(file.id)
  requireArchive(file.mimeType === 'application/json' && file.trashed !== true && file.parents?.includes(workspace.folderId)
    && file.appProperties?.shuntCloud === '1' && file.appProperties.shuntWorkspace === workspace.folderId
    && ['document', 'pending-document', 'retired-document'].includes(file.appProperties.shuntRole ?? '') && typeof file.description === 'string',
  'cloud workspace', 'invalid document ownership or metadata')
  const receipt = JSON.parse(file.description) as Omit<CloudDocumentFile, 'id'>
  requireArchive(receipt !== null && typeof receipt === 'object'
    && Object.keys(receipt).sort().join(',') === 'bytes,count,hash,index,publicationId'
    && typeof receipt.publicationId === 'string' && receipt.publicationId.length > 0 && receipt.publicationId.length <= 1024
    && receipt.publicationId === file.appProperties.shuntPublication
    && typeof receipt.hash === 'string' && /^[a-f0-9]{64}$/.test(receipt.hash) && receipt.hash === file.appProperties.shuntHash
    && Number.isSafeInteger(receipt.index) && Number.isSafeInteger(receipt.count)
    && receipt.index >= 0 && receipt.index < receipt.count && receipt.count <= CLOUD_PUBLICATION_FILES
    && Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0 && receipt.bytes <= CLOUD_DOCUMENT_BYTES && receipt.bytes === Number(file.size),
  'cloud workspace', 'invalid document size or publication metadata')
  return { ...receipt, id: file.id }
}

async function downloadDocument(receipt: CloudDocumentFile, signal: AbortSignal): Promise<Uint8Array> {
  const bytes = await downloadGoogleArchive(receipt.id, receipt.bytes, signal)
  requireArchive(bytes.byteLength === receipt.bytes && await hashCloudBytes(bytes) === receipt.hash,
    'cloud workspace', 'document checksum does not match')
  return bytes
}

function sameReceipt(left: CloudDocumentFile, right: CloudDocumentFile): boolean {
  return left.id === right.id && left.publicationId === right.publicationId && left.index === right.index
    && left.count === right.count && left.hash === right.hash && left.bytes === right.bytes
}
