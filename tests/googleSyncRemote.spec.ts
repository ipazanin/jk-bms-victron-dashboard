import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudSnapshotRevision } from '../src/domain/sync/CloudSnapshotRevision'
import type { DriveFile } from '../src/infrastructure/google/DriveFile'
import { remote } from '../src/infrastructure/google/googleSyncRemote'
import { googleRequest } from '../src/infrastructure/google/googleRequest'
import { listGoogleWorkspaces, trashGoogleWorkspace, validateGoogleWorkspace } from '../src/infrastructure/google/googleWorkspaces'

const forget = vi.hoisted(() => vi.fn())
vi.mock('../src/infrastructure/google/googleAuth', () => ({ googleAccessToken: () => 'memory-token', forgetGoogleAccess: forget }))
const fetchGoogle = vi.fn<typeof fetch>()
const workspace = { id: 'sheet-id', name: 'My archive', folderId: 'folder-id' }
const compactWorkspace = { ...workspace, version: 2 as const }
const signal = new AbortController().signal
const hash = 'a'.repeat(64)

beforeEach(() => {
  fetchGoogle.mockReset()
  forget.mockReset()
  vi.stubGlobal('fetch', fetchGoogle)
})
afterEach(() => vi.unstubAllGlobals())

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

function mockWorkspace(valid = true, version: 1 | 2 = 1) {
  fetchGoogle.mockResolvedValueOnce(json({ id: workspace.id, name: workspace.name, mimeType: 'application/vnd.google-apps.spreadsheet',
    parents: [workspace.folderId], appProperties: { shuntCloud: valid ? '1' : 'ledgerboard', shuntRole: 'catalog', shuntWorkspace: workspace.folderId } }))
  fetchGoogle.mockResolvedValueOnce(json({ id: workspace.folderId, name: workspace.name, mimeType: 'application/vnd.google-apps.folder',
    appProperties: { shuntCloud: '1', shuntRole: 'workspace' } }))
  fetchGoogle.mockResolvedValueOnce(json({ valueRanges: [{ values: [['format', 'shunt-cloud'], ['version', version], ['folderId', workspace.folderId]] }] }))
}

const snapshotDescription: Omit<CloudSnapshotRevision, 'snapshotFileId' | 'createdAt'> = {
  storage: 'snapshot', id: 'revision', source: { id: 'phone', label: '=FORMULA()' }, exportedAt: 1_700_000_000_000,
  snapshotHash: hash, contentHash: hash, sessions: 1, samples: 0, hours: 1, bytes: 10, storedBytes: 3,
}

function snapshotFile(overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    id: 'snapshot', name: 'copy.json.gz', mimeType: 'application/gzip', parents: [workspace.folderId], size: '3',
    createdTime: '2025-01-01T00:00:00.000Z', description: JSON.stringify(snapshotDescription),
    appProperties: { shuntCloud: '1', shuntRole: 'snapshot', shuntWorkspace: workspace.folderId, shuntHash: hash, shuntContentHash: hash },
    ...overrides,
  }
}

function revision(file = snapshotFile()): CloudSnapshotRevision {
  return { ...snapshotDescription, snapshotFileId: file.id, createdAt: Date.parse(file.createdTime!) }
}

describe('Google sync transport', () => {
  it('stops a streamed download when bytes exceed the declared size', async () => {
    const cancelled = vi.fn()
    fetchGoogle.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) },
      cancel: cancelled,
    })))
    await expect(remote.downloadBlock('block', 2, signal)).rejects.toThrow('declared size')
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('forgets expired access and never automatically retries a write', async () => {
    fetchGoogle.mockResolvedValue(new Response('', { status: 401 }))
    await expect(googleRequest('https://www.googleapis.com/drive/v3/files', signal, { method: 'POST' })).rejects.toThrow('Connect to Google again')
    expect(forget).toHaveBeenCalledOnce()
    expect(fetchGoogle).toHaveBeenCalledOnce()
  })

  it('surfaces throttling without retrying a write', async () => {
    fetchGoogle.mockResolvedValue(new Response('', { status: 429 }))
    await expect(googleRequest('https://www.googleapis.com/drive/v3/files', signal, { method: 'POST' })).rejects.toThrow('Wait a minute')
    expect(fetchGoogle).toHaveBeenCalledOnce()
  })

  it.each(['rateLimitExceeded', 'userRateLimitExceeded'])('treats a Drive 403 with %s as throttling', async (reason) => {
    fetchGoogle.mockResolvedValue(new Response(JSON.stringify({ error: { code: 403, errors: [{ domain: 'usageLimits', reason }] } }), { status: 403 }))
    await expect(googleRequest('https://www.googleapis.com/drive/v3/files', signal)).rejects.toThrow('Wait a minute')
  })

  it.each([
    ['a permission reason', JSON.stringify({ error: { code: 403, errors: [{ reason: 'insufficientFilePermissions' }] } })],
    ['a body that is not JSON', '<html>Forbidden</html>'],
  ])('reports refused access for a 403 with %s', async (_case, body) => {
    fetchGoogle.mockResolvedValue(new Response(body, { status: 403 }))
    await expect(googleRequest('https://www.googleapis.com/drive/v3/files', signal)).rejects.toThrow('Google refused access')
  })

  it('replaces the browser network error with a plain message', async () => {
    fetchGoogle.mockRejectedValue(new TypeError('NetworkError when attempting to fetch resource.'))
    await expect(googleRequest('https://www.googleapis.com/drive/v3/files', signal)).rejects.toThrow('Google could not be reached')
  })

  it('passes a cancellation during the request through unchanged', async () => {
    const cancelled = new AbortController()
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    fetchGoogle.mockImplementation(async () => {
      cancelled.abort(abort)
      throw abort
    })
    await expect(googleRequest('https://www.googleapis.com/drive/v3/files', cancelled.signal)).rejects.toBe(abort)
  })

  it('lists valid workspaces when another catalogue has left its folder', async () => {
    const catalog = { mimeType: 'application/vnd.google-apps.spreadsheet', name: 'Archive' }
    fetchGoogle.mockResolvedValue(json({ files: [
      { ...catalog, id: 'moved-sheet', parents: ['elsewhere'], appProperties: { shuntCloud: '1', shuntRole: 'catalog', shuntWorkspace: 'old-folder' } },
      { ...catalog, id: workspace.id, parents: [workspace.folderId], appProperties: { shuntCloud: '1', shuntRole: 'catalog', shuntWorkspace: workspace.folderId } },
    ] }))
    await expect(listGoogleWorkspaces(signal)).resolves.toEqual([{ id: workspace.id, name: 'Archive', folderId: workspace.folderId }])
  })

  it('keeps compact and legacy workspaces distinguishable when listing', async () => {
    const catalog = { mimeType: 'application/vnd.google-apps.spreadsheet', name: 'Archive', parents: [workspace.folderId] }
    const metadata = { shuntCloud: '1', shuntRole: 'catalog', shuntWorkspace: workspace.folderId }
    fetchGoogle.mockResolvedValue(json({ files: [
      { ...catalog, id: 'legacy', appProperties: metadata },
      { ...catalog, id: 'compact', appProperties: { ...metadata, shuntVersion: '2' } },
      { ...catalog, id: 'future', appProperties: { ...metadata, shuntVersion: '3' } },
    ] }))
    await expect(listGoogleWorkspaces(signal)).resolves.toEqual([
      { id: 'legacy', name: 'Archive', folderId: workspace.folderId },
      { id: 'compact', name: 'Archive', folderId: workspace.folderId, version: 2 },
    ])
  })

  it('validates the selected workspace version against its Info table', async () => {
    mockWorkspace(true, 2)
    await expect(validateGoogleWorkspace({ ...workspace, version: 2 }, signal)).resolves.toBe(2)
    mockWorkspace(true, 1)
    await expect(validateGoogleWorkspace(workspace, signal)).resolves.toBe(1)
    mockWorkspace(true, 1)
    await expect(validateGoogleWorkspace({ ...workspace, version: 2 }, signal)).rejects.toThrow('invalid format or folder')
  })

  it('skips invalid snapshot metadata while preserving valid sources', async () => {
    mockWorkspace(true, 2)
    fetchGoogle.mockResolvedValueOnce(json({ valueRanges: [{ values: [['id', 'sourceId', 'parents', 'createdAt', 'theme', 'sidebar', 'statsPreferences', 'victronAdvertisementKey']] }] }))
    fetchGoogle.mockResolvedValueOnce(json({ files: [snapshotFile(), snapshotFile({ parents: ['other-folder'] }), snapshotFile({ description: '{broken' })] }))
    const catalog = await remote.readCatalog(compactWorkspace, signal)
    expect(catalog.archives).toEqual([revision()])
    expect(catalog.unreadableArchives).toBe(2)
    expect(fetchGoogle.mock.calls.every(([, request]) => request?.method !== 'DELETE')).toBe(true)
  })

  it('leaves duplicate revision identities out without blocking unrelated sources', async () => {
    mockWorkspace(true, 2)
    fetchGoogle.mockResolvedValueOnce(json({ valueRanges: [{ values: [['id', 'sourceId', 'parents', 'createdAt', 'theme', 'sidebar', 'statsPreferences', 'victronAdvertisementKey']] }] }))
    fetchGoogle.mockResolvedValueOnce(json({ files: [
      snapshotFile(), snapshotFile({ id: 'duplicate-file' }),
      snapshotFile({ id: 'other-file', description: JSON.stringify({ ...snapshotDescription, id: 'other-revision', source: { id: 'tablet', label: 'Tablet' } }) }),
    ] }))
    const catalog = await remote.readCatalog(compactWorkspace, signal)
    expect(catalog.archives.map((copy) => copy.source.id)).toEqual(['tablet'])
    expect(catalog.unreadableArchives).toBe(2)
    expect(fetchGoogle.mock.calls.every(([, request]) => request?.method !== 'DELETE')).toBe(true)
  })

  it('rejects repeated pagination tokens instead of looping', async () => {
    fetchGoogle.mockImplementation(async () => json({ files: [], nextPageToken: 'same-page' }))
    await expect(listGoogleWorkspaces(signal)).rejects.toThrow('repeated file page')
    expect(fetchGoogle).toHaveBeenCalledTimes(2)
  })

  it('orders complete copies by server creation time and file ID, never capture time', async () => {
    mockWorkspace(true, 2)
    fetchGoogle.mockResolvedValueOnce(json({ valueRanges: [{ values: [['id', 'sourceId', 'parents', 'createdAt', 'theme', 'sidebar', 'statsPreferences', 'victronAdvertisementKey']] }] }))
    fetchGoogle.mockResolvedValueOnce(json({ files: [
      snapshotFile({ id: 'z', description: JSON.stringify({ ...snapshotDescription, id: 'z', exportedAt: 1 }) }),
      snapshotFile({ id: 'a', description: JSON.stringify({ ...snapshotDescription, id: 'a', exportedAt: 9 }) }),
      snapshotFile({ id: 'older', createdTime: '2024-01-01T00:00:00.000Z', description: JSON.stringify({ ...snapshotDescription, id: 'older', exportedAt: 99 }) }),
    ] }))
    const catalog = await remote.readCatalog(compactWorkspace, signal)
    expect(catalog.archives.map((copy) => copy.id)).toEqual(['older', 'a', 'z'])
    expect(fetchGoogle.mock.calls.some(([url]) => decodeURIComponent(String(url)).includes("'Archives'"))).toBe(false)
  })

  it('rejects another application spreadsheet before trashing anything', async () => {
    mockWorkspace(false)
    await expect(trashGoogleWorkspace(workspace, signal)).rejects.toThrow('invalid format or folder')
    expect(fetchGoogle.mock.calls.every(([, request]) => request?.method !== 'PATCH')).toBe(true)
  })

  it('rejects malformed catalogue rows without dropping them', async () => {
    mockWorkspace()
    fetchGoogle.mockResolvedValueOnce(json({ valueRanges: [
      { values: [['id', 'sourceId', 'sourceLabel', 'exportedAt', 'manifestFileId', 'manifestHash', 'contentHash', 'sessions', 'samples', 'bytes'], ['broken']] },
      { values: [['id', 'sourceId', 'parents', 'createdAt', 'theme', 'sidebar', 'statsPreferences', 'victronAdvertisementKey']] },
    ] }))
    await expect(remote.readCatalog(workspace, signal)).rejects.toThrow()
  })

  it('passes an already cancelled operation without making a request', async () => {
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(googleRequest('https://www.googleapis.com/drive/v3/files', cancelled.signal)).rejects.toThrow()
    expect(fetchGoogle).not.toHaveBeenCalled()
  })
})
